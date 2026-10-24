// The stand-in agent CLI: plays the support agent until Resolve exists (phase 8), and the ops agent
// (phase 12, ADR 0039). The proposal file's principal picks the key variable. It writes each
// proposal file ticket to the ticket store, labelled simulated, as Resolve will (ADR 0029); a
// proposal with no ticket writes none. It then connects to the gate's MCP endpoint with the
// principal key through the MCP SDK's client, calls each proposal's tool and prints each agent
// response, or the responses as JSON with --json. It holds no PayPal credential: the gate reads
// and decides. Returns the output and exit code rather than writing them, so tests can call it
// directly. No AI.

import {
  type Database,
  type DatabaseHandle,
  type Environment,
  failureReason,
  openDatabase,
  openFailure,
  resolveDatabaseTarget,
  takePgliteOption,
  targetName,
} from "@countersign/db";
import { firstIssueMessage, REASONS, type ReasonCode } from "@countersign/mandate";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  StreamableHTTPClientTransport,
  StreamableHTTPError,
} from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { z } from "zod";
import { readJson } from "./case-file";
import { type AgentResponse, AgentResponseSchema } from "./decide";
import type { CliResult } from "./decide-cli";
import {
  OPS_AGENT_KEY_VAR,
  type PrincipalName,
  parsePrincipalEnv,
  SUPPORT_AGENT_KEY_VAR,
} from "./principals";
import {
  type Expected,
  type ProposalFile,
  ProposalFileSchema,
  plural,
  prepareProposals,
  type Resolved,
  sameCodes,
} from "./proposal-file";

export const AGENT_USAGE =
  "Usage: npm run agent -- <proposal file> [--json] [--url <gate MCP URL>] [--pglite <dir>]";

export const DEFAULT_GATE_URL = "http://127.0.0.1:8787/mcp";

// The principals this CLI can propose as, each with the variable holding its key.
const KEY_VARIABLES = {
  "support-agent": SUPPORT_AGENT_KEY_VAR,
  "ops-agent": OPS_AGENT_KEY_VAR,
} as const satisfies Record<PrincipalName, string>;

const isAgentPrincipal = (name: string): name is PrincipalName =>
  Object.hasOwn(KEY_VARIABLES, name);

type Agent = { principal: PrincipalName; variable: string };

export const EXIT_MATCHED = 0;
export const EXIT_DIFFERED = 1;
export const EXIT_CANT_RUN = 2;

export type AgentCliOptions = {
  // A database to use instead of opening one, for tests that share it with a gate in-process.
  db?: Database;
  // When the simulated tickets are received. Defaults to the system clock, read at this edge.
  now?: () => Date;
};

function cantRun(error: string): CliResult {
  return { exitCode: EXIT_CANT_RUN, stdout: "", stderr: `${error.replace(/\s*\n\s*/g, " ")}\n` };
}

const GateUrl = z
  .url({ protocol: /^https?$/, error: "must be an http or https URL" })
  .transform((value) => new URL(value));

type Options = { json: boolean; url: URL; pgliteDir: string | undefined; path: string };

function parseArgs(args: readonly string[]): { ok: true; options: Options } | CliResult {
  const option = takePgliteOption(args);
  if (!option.ok) return cantRun(`${option.error} ${AGENT_USAGE}`);
  let json = false;
  let url: URL | undefined;
  const rest: string[] = [];
  for (let index = 0; index < option.rest.length; index++) {
    const arg = option.rest[index] as string;
    if (arg === "--json") json = true;
    else if (arg === "--url") {
      if (url !== undefined) return cantRun(`--url is given twice. ${AGENT_USAGE}`);
      const parsed = GateUrl.safeParse(option.rest[index + 1]);
      if (!parsed.success) return cantRun(`--url needs the gate's MCP URL. ${AGENT_USAGE}`);
      url = parsed.data;
      index++;
    } else if (arg.startsWith("-")) return cantRun(`Unknown option ${arg}. ${AGENT_USAGE}`);
    else rest.push(arg);
  }
  const [path, ...extra] = rest;
  if (path === undefined || extra.length > 0) return cantRun(AGENT_USAGE);
  return {
    ok: true,
    options: { json, url: url ?? new URL(DEFAULT_GATE_URL), pgliteDir: option.pgliteDir, path },
  };
}

function loadFile(
  path: string,
): { ok: true; file: ProposalFile; agent: Agent } | { ok: false; error: string } {
  const read = readJson(path);
  if (!read.ok) return read;
  const parsed = ProposalFileSchema.safeParse(read.json);
  if (!parsed.success)
    return { ok: false, error: firstIssueMessage("Proposal file", parsed.error) };
  const { principal } = parsed.data;
  if (!isAgentPrincipal(principal)) {
    const known = Object.keys(KEY_VARIABLES).join(" or ");
    return { ok: false, error: `${path}: the agent CLI proposes as ${known}, not ${principal}.` };
  }
  return {
    ok: true,
    file: parsed.data,
    agent: { principal, variable: KEY_VARIABLES[principal] },
  };
}

// The principal's key, named by its variable when missing, never shown. Two principal variables
// holding the same value both count as unset, as at the gate.
function agentKey(
  env: Environment,
  { principal, variable }: Agent,
): { ok: true; key: string } | { ok: false; error: string } {
  const { keys } = parsePrincipalEnv(env);
  const key = keys.find((item) => item.name === principal)?.key;
  if (key === undefined) {
    return {
      ok: false,
      error: `The agent CLI can't start. Set ${variable} in .env.local, 32 or more characters.`,
    };
  }
  return { ok: true, key };
}

// One line for a gate that refused the key, or one that couldn't be reached. Never the gate's
// own words, which a misconfigured proxy could fill with anything.
function gateProblem(error: unknown, url: URL, { variable }: Agent): string {
  if (error instanceof StreamableHTTPError && error.code === 401) {
    return `The gate at ${url.href} refused the principal key (HTTP 401). Check ${variable} matches the gate's.`;
  }
  if (error instanceof StreamableHTTPError && (error.code ?? 0) > 0) {
    return `The gate at ${url.href} answered HTTP ${error.code}.`;
  }
  return `Couldn't reach the gate at ${url.href}. Start it with npm run dev --workspace @countersign/gate.`;
}

async function connect(
  url: URL,
  key: string,
  agent: Agent,
): Promise<{ ok: true; client: Client } | { ok: false; error: string }> {
  const client = new Client({ name: "countersign-stand-in-agent", version: "0.7.0" });
  const transport = new StreamableHTTPClientTransport(url, {
    requestInit: { headers: { Authorization: `Bearer ${key}` } },
  });
  try {
    await client.connect(transport);
    return { ok: true, client };
  } catch (error) {
    await client.close().catch(() => {});
    return { ok: false, error: gateProblem(error, url, agent) };
  }
}

type Called = { ok: true; response: AgentResponse } | { ok: false; error: string };

// Calls the proposal's tool. A result the gate marks as an error means nothing was recorded.
async function call(
  client: Client,
  { proposal }: Resolved,
  url: URL,
  agent: Agent,
): Promise<Called> {
  const { tool, args, justification } = proposal;
  let result: Awaited<ReturnType<Client["callTool"]>>;
  try {
    result = await client.callTool({
      name: tool,
      arguments: { ...args, ...(justification === undefined ? {} : { justification }) },
    });
  } catch (error) {
    return { ok: false, error: gateProblem(error, url, agent) };
  }
  if (result.isError === true) {
    const [first] = Array.isArray(result.content) ? result.content : [];
    const text = typeof first?.text === "string" ? first.text : "The gate answered an error.";
    return { ok: false, error: text };
  }
  const parsed = AgentResponseSchema.safeParse(result.structuredContent);
  if (!parsed.success) {
    return { ok: false, error: "The gate's answer isn't an agent response." };
  }
  return { ok: true, response: parsed.data };
}

type Ran = { resolved: Resolved; response: AgentResponse };

const DECISION_OF = {
  allowed: "allow",
  pending_approval: "step_up",
  denied: "deny",
} as const satisfies Record<AgentResponse["decision"], Expected["decision"]>;

const DECISION_WORDS = {
  allowed: "Allow",
  pending_approval: "Step-up",
  denied: "Deny",
} as const satisfies Record<AgentResponse["decision"], string>;

const codesOf = (response: AgentResponse): ReasonCode[] =>
  response.decision === "allowed" ? [] : response.reasons.map((reason) => reason.code);

const words = (decision: string, reasons: readonly string[]) => [decision, ...reasons].join(" ");

// The "Expected … got …" line, or null when the response is what the file expected.
function mismatch({ resolved: { expect }, response }: Ran): string | null {
  const decision = DECISION_OF[response.decision];
  const reasons = codesOf(response);
  if (decision === expect.decision && sameCodes(reasons, expect.reasons)) return null;
  return `Expected ${words(expect.decision, expect.reasons)}, got ${words(decision, reasons)}.`;
}

function readableLines(ran: Ran, index: number, count: number): string[] {
  const { response, resolved } = ran;
  const lines = [
    `Proposal ${index + 1} of ${count}`,
    `  For       ${resolved.label}`,
    `  Tool      ${resolved.proposal.tool}`,
    `  Decision  ${DECISION_WORDS[response.decision]}`,
    `  Intent    ${response.intent_id ?? "None"}`,
  ];
  if (response.decision === "allowed") {
    lines.push(`  Hash      ${response.intent_hash}`, "  Reasons   None");
  } else {
    lines.push("  Reasons");
    for (const reason of response.reasons) {
      lines.push(`    ${REASONS[reason.code].words} (${reason.code})`, `      ${reason.detail}`);
    }
    if (response.decision === "pending_approval") {
      lines.push(`  Expires   ${response.expires_at}`);
    } else {
      lines.push(`  Reply     ${response.safe_reply_hint}`);
    }
  }
  const differs = mismatch(ran);
  if (differs) lines.push(`  ${differs}`);
  return lines;
}

function render(
  json: boolean,
  file: ProposalFile,
  url: URL,
  { principal }: Agent,
  ran: Ran[],
): CliResult {
  const differed = ran.filter((item) => mismatch(item) !== null).length;
  const exitCode = differed > 0 ? EXIT_DIFFERED : EXIT_MATCHED;
  const summary =
    differed > 0 ? [`${plural(differed, "proposal", "proposals")} differed from the file.`] : [];
  if (json) {
    const problems = ran.flatMap((item, index) => {
      const line = mismatch(item);
      return line === null ? [] : [`Proposal ${index + 1}: ${line}`];
    });
    const stderr = [...problems, ...summary];
    return {
      exitCode,
      stdout: `${JSON.stringify(
        ran.map((item) => item.response),
        null,
        2,
      )}\n`,
      stderr: stderr.length === 0 ? "" : `${stderr.join("\n")}\n`,
    };
  }
  const lines = [file.description, `Gate ${url.href}, as ${principal}`];
  ran.forEach((item, index) => {
    lines.push("", ...readableLines(item, index, ran.length));
  });
  if (summary.length > 0) lines.push("", ...summary);
  return { exitCode, stdout: `${lines.join("\n")}\n`, stderr: "" };
}

type Store = {
  db: Database;
  // Words an error from the ticket store or `seed_orders`, never with a connection string.
  storeFailure: (ticketId: string, error: unknown) => string;
  failure: (error: unknown) => string;
};

async function runWith(
  store: Store,
  file: ProposalFile,
  options: Options,
  agent: Agent,
  key: string,
  now: () => Date,
): Promise<CliResult> {
  let prepared: Awaited<ReturnType<typeof prepareProposals>>;
  try {
    prepared = await prepareProposals(store.db, file.proposals, now(), store.storeFailure);
  } catch (error) {
    return cantRun(store.failure(error));
  }
  if (!prepared.ok) return cantRun(prepared.error);

  const connected = await connect(options.url, key, agent);
  if (!connected.ok) return cantRun(connected.error);
  const { client } = connected;
  try {
    const ran: Ran[] = [];
    for (const [index, resolved] of prepared.resolved.entries()) {
      const called = await call(client, resolved, options.url, agent);
      if (!called.ok) {
        const earlier =
          index === 0
            ? "No earlier proposal ran."
            : `${plural(index, "proposal", "proposals")} ran first.`;
        return cantRun(`Proposal ${index + 1}: ${called.error} ${earlier}`);
      }
      ran.push({ resolved, response: called.response });
    }
    return render(options.json, file, options.url, agent, ran);
  } finally {
    await client.close().catch(() => {});
  }
}

/**
 * Runs the stand-in agent as the proposal file's principal. Exit 0 when every decision matched,
 * 1 when any didn't, 2 when it can't run.
 */
export async function runAgent(
  args: readonly string[],
  env: Environment,
  cliOptions: AgentCliOptions = {},
): Promise<CliResult> {
  const parsed = parseArgs(args);
  if (!("ok" in parsed)) return parsed;
  const { options } = parsed;
  const file = loadFile(options.path);
  if (!file.ok) return cantRun(file.error);
  const key = agentKey(env, file.agent);
  if (!key.ok) return cantRun(key.error);
  const now = cliOptions.now ?? (() => new Date());

  if (cliOptions.db !== undefined) {
    const store: Store = {
      db: cliOptions.db,
      storeFailure: (ticketId) => `Couldn't store ticket ${ticketId}.`,
      failure: () => "Couldn't read the seed orders or the ticket store.",
    };
    return runWith(store, file.file, options, file.agent, key.key, now);
  }

  const target = resolveDatabaseTarget(env, options.pgliteDir);
  let handle: DatabaseHandle;
  try {
    handle = await openDatabase(target);
  } catch (error) {
    return cantRun(openFailure(error, target));
  }
  const store: Store = {
    db: handle.db,
    storeFailure: (ticketId, error) =>
      `Couldn't store ticket ${ticketId} at ${targetName(target)}: ${failureReason(error, target)}. Run npm run db:migrate if the tickets table is missing.`,
    failure: (error) =>
      `Couldn't read the seed orders at ${targetName(target)}: ${failureReason(error, target)}. Run npm run db:migrate and npm run seed first.`,
  };
  try {
    return await runWith(store, file.file, options, file.agent, key.key, now);
  } finally {
    await handle.close().catch(() => {});
  }
}
