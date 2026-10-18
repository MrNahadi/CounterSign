// The propose CLI: runs every proposal in a proposal file through propose() against the PayPal
// sandbox, the carrier mock and the audit log, then prints each decision with its trace and what
// executed, or the agent responses with --json. Order numbers and senders are resolved from
// `seed_orders`. Returns the output and exit code rather than writing them, so tests can call it
// directly. Each file ticket is simulated: the CLI writes it to the ticket store, labelled
// simulated, before proposing, as Resolve will (ADR 0029; brief §8: simulated parts are labeled).

import { dirname, resolve } from "node:path";
import { createDatabaseShipmentStore, createMockCarrier } from "@countersign/carrier-mock";
import {
  type DatabaseHandle,
  type Environment,
  failureReason,
  hasAuditLogTable,
  openDatabase,
  openFailure,
  resolveDatabaseTarget,
  takePgliteOption,
  targetName,
} from "@countersign/db";
import { firstIssueMessage, type Mandate, parseMandate } from "@countersign/mandate";
import {
  createPayPalClient,
  type FetchLike,
  type PayPalClient,
  parsePayPalEnv,
} from "@countersign/rail-paypal";
import { readJson } from "./case-file";
import { type CliResult, decisionLines } from "./decide-cli";
import {
  type Expected,
  type ProposalFile,
  ProposalFileSchema,
  plural,
  prepareProposals,
  type Resolved,
  sameCodes,
} from "./proposal-file";
import { type ProposeResult, propose } from "./propose";

export const PROPOSE_USAGE = "Usage: npm run propose -- <proposal file> [--json] [--pglite <dir>]";

export const EXIT_MATCHED = 0;
export const EXIT_DIFFERED = 1;
export const EXIT_CANT_RUN = 2;

export type ProposeCliOptions = {
  // A rail client to use instead of one built from the environment, for tests. The environment's
  // PayPal variables are still required.
  rail?: PayPalClient;
  fetch?: FetchLike;
  // The decision time for each proposal. Defaults to the system clock, read at this edge only.
  now?: () => Date;
  // The time execution results are logged at.
  clock?: () => Date;
};

function cantRun(error: string): CliResult {
  return { exitCode: EXIT_CANT_RUN, stdout: "", stderr: `${error.replace(/\s*\n\s*/g, " ")}\n` };
}

type Loaded = { file: ProposalFile; mandate: Mandate };

function loadProposalFile(
  path: string,
): { ok: true; loaded: Loaded } | { ok: false; error: string } {
  const read = readJson(path);
  if (!read.ok) return read;
  const parsed = ProposalFileSchema.safeParse(read.json);
  if (!parsed.success)
    return { ok: false, error: firstIssueMessage("Proposal file", parsed.error) };
  const mandatePath = resolve(dirname(path), parsed.data.mandate);
  const mandateFile = readJson(mandatePath);
  if (!mandateFile.ok) return mandateFile;
  const mandate = parseMandate(mandateFile.json);
  if (!mandate.ok) return { ok: false, error: `${mandatePath}: ${mandate.error}` };
  return { ok: true, loaded: { file: parsed.data, mandate: mandate.mandate } };
}

// The PayPal client's variables, named when missing, never shown.
function paypalProblem(env: Environment): string | null {
  const parsed = parsePayPalEnv(env);
  if (parsed.ok) return null;
  const sentences = ["The propose CLI can't start."];
  if (parsed.missing.length > 0) sentences.push(`Set ${parsed.missing.join(", ")} in .env.local.`);
  sentences.push(...parsed.problems.filter((problem) => !problem.endsWith(" is missing.")));
  return sentences.join(" ");
}

type Ran = { resolved: Resolved; result: Extract<ProposeResult, { ok: true }> };

type Got = { decision: Expected["decision"]; reasons: string[] };

function gotOf({ result }: Ran): Got {
  if (result.replay) return { decision: "allow", reasons: [] };
  return {
    decision: result.record.decision,
    reasons: result.record.reasons.map((reason) => reason.code),
  };
}

const words = ({ decision, reasons }: Got) => [decision, ...reasons].join(" ");

// The "Expected … got …" line, or null when the result is what the file expected.
function mismatch(ran: Ran): string | null {
  const got = gotOf(ran);
  const { expect } = ran.resolved;
  if (got.decision === expect.decision && sameCodes(got.reasons, expect.reasons)) return null;
  return `Expected ${words(expect)}, got ${words(got)}.`;
}

function executionLines({ result }: Ran): string[] {
  const { execution } = result;
  if (execution === null) return ["  Execution None, nothing was sent"];
  const lines = [`  Outcome   ${execution.outcome}`];
  lines.push(
    `  Refund    ${execution.refund === null ? "None" : `${execution.refund.id} ${execution.refund.status}`}`,
  );
  if (execution.error) {
    const { name, issues, debugId } = execution.error;
    const parts = [name ?? "No error name", ...issues, `debug ID ${debugId ?? "none"}`];
    lines.push(`  Refused   ${parts.join(", ")}`);
  }
  if (!execution.sent) lines.push("  Replayed, no new refund.");
  if (execution.resultProblem) {
    lines.push(`  Result not logged: ${execution.resultProblem.replace(/\s*\n\s*/g, " ")}`);
  }
  return lines;
}

function readableLines(ran: Ran, index: number, count: number): string[] {
  const { result, resolved } = ran;
  let lines: string[];
  if (result.replay) {
    lines = [
      `Proposal ${index + 1} of ${count}`,
      "  Decision  Allow",
      `  Replay    Already requested at entry #${result.firstRequestSeq}, so not decided again`,
      `  Intent    ${result.intentId}`,
      `  Hash      ${result.intentHash}`,
    ];
  } else {
    lines = decisionLines(result, index, count);
  }
  lines.splice(1, 0, `  For       ${resolved.label}`);
  lines.push(...executionLines(ran));
  for (const problem of result.problems) {
    lines.push(`  Read problem  ${problem.call}: ${problem.message}`);
  }
  const differs = mismatch(ran);
  if (differs) lines.push(`  ${differs}`);
  return lines;
}

function jsonOf({ result }: Ran) {
  const { execution } = result;
  return {
    response: result.response,
    execution:
      execution === null
        ? null
        : {
            outcome: execution.outcome,
            refund_id: execution.refund?.id ?? null,
            refund_status: execution.refund?.status ?? null,
            new_refund: execution.sent,
          },
  };
}

function render(json: boolean, { file, mandate }: Loaded, ran: Ran[]): CliResult {
  const differed = ran.filter((item) => mismatch(item) !== null).length;
  const unknown = ran.filter((item) => item.result.execution?.outcome === "unknown").length;
  const exitCode = differed > 0 || unknown > 0 ? EXIT_DIFFERED : EXIT_MATCHED;
  const summary: string[] = [];
  if (differed > 0) {
    summary.push(`${plural(differed, "proposal", "proposals")} differed from the file.`);
  }
  if (unknown > 0) {
    summary.push(
      `${plural(unknown, "refund", "refunds")} with an unknown outcome. Run npm run reconcile.`,
    );
  }
  if (json) {
    const problems = ran.flatMap((item, index) => [
      ...item.result.problems.map(
        (problem) => `Proposal ${index + 1}: ${problem.call}: ${problem.message}`,
      ),
      ...[mismatch(item)]
        .filter((line) => line !== null)
        .map((line) => `Proposal ${index + 1}: ${line}`),
    ]);
    const stderr = [...problems, ...summary];
    return {
      exitCode,
      stdout: `${JSON.stringify(ran.map(jsonOf), null, 2)}\n`,
      stderr: stderr.length === 0 ? "" : `${stderr.join("\n")}\n`,
    };
  }
  const lines = [file.description, `Mandate ${mandate.id} version ${mandate.version}`];
  ran.forEach((item, index) => {
    lines.push("", ...readableLines(item, index, ran.length));
  });
  if (summary.length > 0) lines.push("", ...summary);
  return { exitCode, stdout: `${lines.join("\n")}\n`, stderr: "" };
}

/** Runs the propose CLI. Exit 0 when every proposal matched, 1 when any didn't, 2 when it can't run. */
export async function runPropose(
  args: readonly string[],
  env: Environment,
  options: ProposeCliOptions = {},
): Promise<CliResult> {
  const option = takePgliteOption(args);
  if (!option.ok) return cantRun(`${option.error} ${PROPOSE_USAGE}`);
  const json = option.rest.includes("--json");
  const rest = option.rest.filter((arg) => arg !== "--json");
  const unknownOption = rest.find((arg) => arg.startsWith("-"));
  if (unknownOption) return cantRun(`Unknown option ${unknownOption}. ${PROPOSE_USAGE}`);
  const [path, ...extra] = rest;
  if (path === undefined || extra.length > 0) return cantRun(PROPOSE_USAGE);

  const file = loadProposalFile(path);
  if (!file.ok) return cantRun(file.error);
  const missing = paypalProblem(env);
  if (missing) return cantRun(missing);
  const rail =
    options.rail ?? createPayPalClient({ env, ...(options.fetch ? { fetch: options.fetch } : {}) });
  const now = options.now ?? (() => new Date());

  const target = resolveDatabaseTarget(env, option.pgliteDir);
  let handle: DatabaseHandle;
  try {
    handle = await openDatabase(target);
  } catch (error) {
    return cantRun(openFailure(error, target));
  }
  try {
    let present: boolean;
    try {
      present = await hasAuditLogTable(handle.db);
    } catch (error) {
      return cantRun(openFailure(error, target));
    }
    if (!present) {
      return cantRun(
        `The database at ${targetName(target)} has no audit_log table. Run npm run db:migrate first.`,
      );
    }
    const { db } = handle;

    const prepared = await prepareProposals(
      db,
      file.loaded.file.proposals,
      now(),
      (ticketId, error) =>
        `Couldn't store ticket ${ticketId} at ${targetName(target)}: ${failureReason(error, target)}. Run npm run db:migrate if the tickets table is missing.`,
    );
    if (!prepared.ok) return cantRun(prepared.error);
    const { resolved } = prepared;

    const carrier = createMockCarrier(createDatabaseShipmentStore(db));
    const ran: Ran[] = [];
    for (const [index, item] of resolved.entries()) {
      const result = await propose({
        mandate: file.loaded.mandate,
        principal: file.loaded.file.principal,
        proposal: item.proposal,
        now: now(),
        rail,
        carrier,
        db,
        ...(options.clock ? { clock: options.clock } : {}),
      });
      if (!result.ok) {
        const earlier =
          index === 0
            ? "Nothing was recorded for it."
            : `${plural(index, "proposal", "proposals")} ran first.`;
        return cantRun(
          `Couldn't record proposal ${index + 1}: ${result.problem} ${result.detail}. ${earlier}`,
        );
      }
      ran.push({ resolved: item, result });
    }
    return render(json, file.loaded, ran);
  } catch (error) {
    return cantRun(
      `Couldn't use the audit log at ${targetName(target)}: ${failureReason(error, target)}`,
    );
  } finally {
    await handle.close().catch(() => {});
  }
}
