// The `resolve` CLI: runs one scenario file through Resolve in-process. Each message is checked
// and stored as a simulated ticket the way `POST /messages` stores it (senders resolved from
// `seed_orders`), then run by the same mode runner the server uses, one at a time, so a
// follow-up sees the earlier reply. Prints each run's mode, model, tool calls (with the gate's
// decision and reason codes for guarded calls), outcome and reply, or the runs as JSON with
// --json. Returns the output and exit code rather than writing them, so tests can call it.

import { readFileSync } from "node:fs";
import { dirname, resolve as resolvePath } from "node:path";
import {
  type AgentRun,
  asc,
  type Database,
  type DatabaseHandle,
  type Environment,
  eq,
  failureReason,
  finishRun,
  openDatabase,
  openFailure,
  readRun,
  resolveDatabaseTarget,
  seedOrders,
  takePgliteOption,
  targetName,
} from "@countersign/db";
import { firstIssueMessage, REASON_CODES, REASONS, type ReasonCode } from "@countersign/mandate";
import { parsePayPalEnv } from "@countersign/rail-paypal";
import { z } from "zod";
import { paypalTokenIssuer, type TokenIssuer, type TransportFactory } from "./baseline";
import type { ToolStep } from "./harness";
import { storeMessage } from "./intake";
import { overDailyCap, parseDailyCap } from "./limits";
import { checkMessage, sniffImageType } from "./messages";
import { createGenerateContent, type GenerateContent, parseModelEnv } from "./model";
import { type ProtectedEnv, parseProtectedEnv } from "./protected";
import { createModeRunner } from "./queue";
import type { RunMode, RunTrace } from "./runs";

export const RESOLVE_USAGE =
  "Usage: npm run resolve -- <message file> [--mode protected|baseline] [--json] [--pglite <dir>]";

export const EXIT_REPLIED = 0;
export const EXIT_NOT_REPLIED = 1;
export const EXIT_CANT_RUN = 2;

export type CliResult = { exitCode: number; stdout: string; stderr: string };

export type ResolveCliOptions = {
  /** A database to use instead of opening one, for tests that share it with a gate in-process. */
  db?: Database;
  /** The model call. Defaults to Gemini with `GEMINI_API_KEY`. */
  generateContent?: GenerateContent;
  /** Baseline mode's token issuer. Defaults to the sandbox client built from the PayPal variables. */
  issueToken?: TokenIssuer;
  /** Starts PayPal's server for baseline mode. Defaults to spawning it over stdio. */
  createTransport?: TransportFactory;
  /** Wall-clock time for received, queued, started and finished times. Read at this edge. */
  clock?: () => Date;
};

// ---- The message file ----

const OrderNumber = /^KIK-\d{4}$/;

const Sender = z.union([
  z.literal("buyer:A"),
  z.literal("buyer:B"),
  z.string().regex(/^payer:KIK-\d{4}$/),
  z.email({ error: "must be buyer:A, buyer:B, payer:<order number> or an email address" }),
]);
type Sender = z.infer<typeof Sender>;

const FileMessage = z.strictObject({
  channel: z.enum(["email", "chat"]),
  sender: Sender,
  subject: z.string().min(1).optional(),
  body: z.string().min(1),
  // Photo paths, relative to the message file.
  attachments: z.array(z.string().min(1)).max(3).optional(),
  // The index of an earlier message in this file whose thread this one continues.
  follow_up_of: z.int().min(0).optional(),
});

export const MessageFileSchema = z
  .strictObject({
    // Says the people are illustrative and the messages simulated.
    description: z.string().min(1),
    messages: z.array(FileMessage).min(1),
  })
  .superRefine((file, ctx) => {
    file.messages.forEach((message, index) => {
      if (message.follow_up_of !== undefined && message.follow_up_of >= index) {
        ctx.addIssue({
          code: "custom",
          path: ["messages", index, "follow_up_of"],
          message: "must be the index of an earlier message",
        });
      }
    });
  });

export type MessageFile = z.infer<typeof MessageFileSchema>;
type FileMessage = z.infer<typeof FileMessage>;

// ---- Small helpers ----

const oneLine = (text: string) => text.replace(/\s*\n\s*/g, " ");

function cantRun(error: string): CliResult {
  return { exitCode: EXIT_CANT_RUN, stdout: "", stderr: `${oneLine(error)}\n` };
}

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

type Options = { json: boolean; mode: RunMode; pgliteDir: string | undefined; path: string };

function parseArgs(args: readonly string[]): { ok: true; options: Options } | CliResult {
  const option = takePgliteOption(args);
  if (!option.ok) return cantRun(`${option.error} ${RESOLVE_USAGE}`);
  let json = false;
  let mode: RunMode | undefined;
  const rest: string[] = [];
  for (let index = 0; index < option.rest.length; index++) {
    const arg = option.rest[index] as string;
    if (arg === "--json") json = true;
    else if (arg === "--mode") {
      if (mode !== undefined) return cantRun(`--mode is given twice. ${RESOLVE_USAGE}`);
      const value = option.rest[index + 1];
      if (value !== "protected" && value !== "baseline")
        return cantRun(`--mode needs protected or baseline. ${RESOLVE_USAGE}`);
      mode = value;
      index++;
    } else if (arg.startsWith("-")) return cantRun(`Unknown option ${arg}. ${RESOLVE_USAGE}`);
    else rest.push(arg);
  }
  const [path, ...extra] = rest;
  if (path === undefined || extra.length > 0) return cantRun(RESOLVE_USAGE);
  return {
    ok: true,
    options: { json, mode: mode ?? "protected", pgliteDir: option.pgliteDir, path },
  };
}

type Photo = { contentType: string; data: string };
type Loaded = { file: MessageFile; photos: Photo[][] };

// Reads and checks the file, and reads every photo, before anything is stored.
function loadFile(path: string): { ok: true; loaded: Loaded } | { ok: false; error: string } {
  let json: unknown;
  try {
    json = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    return {
      ok: false,
      error: error instanceof SyntaxError ? `${path} isn't valid JSON.` : `Can't read ${path}.`,
    };
  }
  const parsed = MessageFileSchema.safeParse(json);
  if (!parsed.success) return { ok: false, error: firstIssueMessage("Message file", parsed.error) };
  const photos: Photo[][] = [];
  for (const [index, message] of parsed.data.messages.entries()) {
    const read: Photo[] = [];
    for (const relative of message.attachments ?? []) {
      const photoPath = resolvePath(dirname(path), relative);
      let bytes: Buffer;
      try {
        bytes = readFileSync(photoPath);
      } catch {
        return { ok: false, error: `Message ${index + 1}: can't read the photo ${relative}.` };
      }
      const contentType = sniffImageType(new Uint8Array(bytes));
      if (contentType === null) {
        return {
          ok: false,
          error: `Message ${index + 1}: the photo ${relative} isn't a JPEG, PNG or WebP image.`,
        };
      }
      read.push({ contentType, data: bytes.toString("base64") });
    }
    photos.push(read);
  }
  return { ok: true, loaded: { file: parsed.data, photos } };
}

// ---- The environment ----

type Setup = {
  generateContent: GenerateContent;
  model: string;
  fallbackModel: string | null;
  dailyCap: number;
  protectedEnv: ProtectedEnv;
  issueToken: TokenIssuer;
};

// Every variable the mode needs, named when missing or wrong, never shown.
function readEnv(
  env: Environment,
  mode: RunMode,
  cliOptions: ResolveCliOptions,
): { ok: true; setup: Setup } | { ok: false; error: string } {
  const problems: string[] = [];
  const protectedEnv = parseProtectedEnv(env);
  const modelEnv = parseModelEnv(env);
  if (!modelEnv.ok) {
    if (modelEnv.missing.length > 0) problems.push(`Set ${modelEnv.missing.join(", ")}.`);
    problems.push(...modelEnv.problems.filter((line) => !line.startsWith("GEMINI_API_KEY")));
  }
  if (mode === "protected") {
    if (protectedEnv.key === null)
      problems.push("Set COUNTERSIGN_SUPPORT_AGENT_KEY, 32 or more characters.");
    if (protectedEnv.gateUrl === null) problems.push("GATE_MCP_URL must be an http or https URL.");
  } else if (cliOptions.issueToken === undefined) {
    const paypal = parsePayPalEnv(env);
    if (!paypal.ok) {
      if (paypal.missing.length > 0) problems.push(`Set ${paypal.missing.join(", ")}.`);
      problems.push(...paypal.problems.filter((line) => !line.endsWith("is missing.")));
    }
  }
  let dailyCap = 0;
  try {
    dailyCap = parseDailyCap(env);
  } catch (error) {
    problems.push(error instanceof Error ? error.message : "RESOLVE_DAILY_RUN_CAP isn't valid.");
  }
  if (problems.length > 0 || !modelEnv.ok) {
    const named = new Set(problems.join(" ").match(/\b[A-Z][A-Z0-9]*_[A-Z0-9_]+\b/g));
    return {
      ok: false,
      error: `The resolve CLI can't start in ${mode} mode. ${problems.join(" ")} Put ${named.size === 1 ? "it" : "them"} in .env.local.`,
    };
  }
  return {
    ok: true,
    setup: {
      generateContent: cliOptions.generateContent ?? createGenerateContent(modelEnv.config.apiKey),
      model: modelEnv.config.model,
      fallbackModel: modelEnv.config.fallbackModel,
      dailyCap,
      protectedEnv,
      issueToken: cliOptions.issueToken ?? paypalTokenIssuer(env),
    },
  };
}

// ---- Senders ----

const notSeeded = (what: string) => `${what} isn't seeded. Run npm run seed first.`;

async function senderEmail(
  db: Database,
  sender: Sender,
): Promise<{ ok: true; email: string } | { ok: false; error: string }> {
  if (sender === "buyer:A" || sender === "buyer:B") {
    const buyer = sender.slice("buyer:".length);
    const [row] = await db
      .select()
      .from(seedOrders)
      .where(eq(seedOrders.buyer, buyer))
      .orderBy(asc(seedOrders.orderNumber))
      .limit(1);
    return row
      ? { ok: true, email: row.payerEmail }
      : { ok: false, error: notSeeded(`Buyer ${buyer}`) };
  }
  if (sender.startsWith("payer:")) {
    const order = sender.slice("payer:".length);
    if (!OrderNumber.test(order)) return { ok: false, error: `${sender} isn't an order number.` };
    const [row] = await db
      .select()
      .from(seedOrders)
      .where(eq(seedOrders.orderNumber, order))
      .limit(1);
    return row
      ? { ok: true, email: row.payerEmail }
      : { ok: false, error: notSeeded(`Order ${order}`) };
  }
  return { ok: true, email: sender };
}

// Every sender, and every follow-up's match with the message that starts its thread.
async function resolveSenders(
  db: Database,
  messages: readonly FileMessage[],
): Promise<{ ok: true; emails: string[] } | { ok: false; error: string }> {
  const emails: string[] = [];
  for (const [index, message] of messages.entries()) {
    const resolved = await senderEmail(db, message.sender);
    if (!resolved.ok) return { ok: false, error: `Message ${index + 1}: ${resolved.error}` };
    emails.push(resolved.email);
    let first = index;
    while (messages[first]?.follow_up_of !== undefined)
      first = messages[first]?.follow_up_of as number;
    if (
      first !== index &&
      (messages[first]?.channel !== message.channel || emails[first] !== resolved.email)
    ) {
      return {
        ok: false,
        error: `Message ${index + 1}: a follow-up must have the same channel and sender as message ${first + 1}.`,
      };
    }
  }
  return { ok: true, emails };
}

// ---- Output ----

const GuardedResponse = z.discriminatedUnion("decision", [
  z.object({ decision: z.literal("allowed"), intent_id: z.string() }),
  z.object({
    decision: z.literal("pending_approval"),
    reasons: z.array(z.object({ code: z.string() })),
  }),
  z.object({ decision: z.literal("denied"), reasons: z.array(z.object({ code: z.string() })) }),
]);

const ToolResult = z.object({
  content: z.array(z.object({ type: z.string(), text: z.string().optional() })).optional(),
  structuredContent: z.record(z.string(), z.unknown()).optional(),
  isError: z.boolean().optional(),
});

const FoundOrder = z.object({
  order_number: z.string(),
  capture_id: z.string(),
  amount: z.object({ value: z.string(), currency_code: z.string() }),
});

const DECISION_WORDS = {
  allowed: "Allowed",
  pending_approval: "Waiting for approval",
  denied: "Denied",
} as const;

const isReasonCode = (code: string): code is ReasonCode =>
  (REASON_CODES as readonly string[]).includes(code);

const reasonText = (code: string) =>
  isReasonCode(code) ? `${REASONS[code].words} (${code})` : `(${code})`;

const clip = (text: string, length = 100) =>
  text.length > length ? `${text.slice(0, length - 1)}…` : text;

// The arguments a person scans for: order, capture, dispute or object ID, and amount.
function keyArgs(args: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const key of ["order_number", "capture_id", "dispute_id", "id"]) {
    const value = args[key];
    if (typeof value === "string") parts.push(value);
  }
  const amount = z.object({ value: z.string(), currency_code: z.string() }).safeParse(args.amount);
  if (amount.success) parts.push(`${amount.data.value} ${amount.data.currency_code}`);
  return parts.length === 0 ? "" : ` ${parts.join(", ")}`;
}

function resultWords(step: ToolStep, mode: RunMode): string {
  const parsed = ToolResult.safeParse(step.result);
  if (!parsed.success) return "No answer: the connection failed.";
  const { content, structuredContent, isError } = parsed.data;
  const text = (content ?? [])
    .map((part) => part.text ?? "")
    .join(" ")
    .trim();
  if (isError === true) return `Error. ${clip(oneLine(text) || "No details.")}`;
  if (step.local) {
    const found = FoundOrder.safeParse(structuredContent);
    return found.success
      ? `Found ${found.data.order_number}, capture ${found.data.capture_id}, ${found.data.amount.value} ${found.data.amount.currency_code}.`
      : "Answered.";
  }
  if (mode === "protected") {
    const guarded = GuardedResponse.safeParse(structuredContent);
    if (guarded.success) {
      const response = guarded.data;
      const words = DECISION_WORDS[response.decision];
      if (response.decision === "allowed") return `${words}. Intent ${response.intent_id}.`;
      return `${words}. ${response.reasons.map((reason) => reasonText(reason.code)).join(" ")}`;
    }
    return "Answered.";
  }
  const record = z
    .object({ id: z.string(), status: z.string().optional() })
    .safeParse(structuredContent);
  const answer = record.success
    ? `PayPal answered ${record.data.id}${record.data.status ? `, ${record.data.status}` : ""}.`
    : "PayPal answered.";
  return `No checks: straight to PayPal. ${answer}`;
}

const toolSteps = (trace: unknown): ToolStep[] => {
  const steps = (trace as Partial<RunTrace> | null)?.steps;
  return Array.isArray(steps) ? steps.filter((step): step is ToolStep => step.kind === "tool") : [];
};

function runLines(run: AgentRun): string[] {
  const versions = run.modelVersions.length > 0 ? [...new Set(run.modelVersions)].join(", ") : null;
  const lines = [
    `  Run       ${run.id}`,
    `  Mode      ${run.mode === "protected" ? "Protected" : "Baseline"}`,
    `  Model     ${run.model}${versions ? ` (reported ${versions})` : ""}`,
  ];
  const tools = toolSteps(run.trace);
  if (tools.length === 0) lines.push("  Tools     None called");
  else {
    lines.push(`  Tools     ${plural(tools.length, "call", "calls")}`);
    for (const step of tools) {
      lines.push(`    ${step.name}${keyArgs(step.args)}: ${resultWords(step, run.mode)}`);
    }
  }
  lines.push(`  Outcome   ${run.status}, ${run.outcome ?? "none"}`);
  lines.push(`  Reply     ${run.reply === null ? "None" : oneLine(run.reply)}`);
  return lines;
}

type Ran = { index: number; ticketId: string; threadId: string; runs: AgentRun[] };

function render(json: boolean, file: MessageFile, emails: string[], ran: Ran[]): CliResult {
  const runs = ran.flatMap((item) => item.runs);
  // The last run of each message decides it: a fallback rerun may have replied.
  const unreplied = ran.filter((item) => item.runs.at(-1)?.status !== "replied").length;
  const exitCode = unreplied > 0 ? EXIT_NOT_REPLIED : EXIT_REPLIED;
  const summary =
    unreplied > 0
      ? [`${plural(unreplied, "message", "messages")} got no reply.`]
      : [`${plural(ran.length, "message", "messages")} replied.`];
  if (json) {
    return {
      exitCode,
      stdout: `${JSON.stringify(runs, null, 2)}\n`,
      stderr: unreplied > 0 ? `${summary.join("\n")}\n` : "",
    };
  }
  const lines = [file.description];
  for (const item of ran) {
    const message = file.messages[item.index] as FileMessage;
    lines.push(
      "",
      `Message ${item.index + 1} of ${file.messages.length}: ${message.channel} from ${emails[item.index]} (simulated)`,
      `  Ticket    ${item.ticketId}${item.threadId === item.ticketId ? "" : `, thread ${item.threadId}`}`,
    );
    for (const run of item.runs) lines.push(...runLines(run));
  }
  lines.push("", ...summary);
  return { exitCode, stdout: `${lines.join("\n")}\n`, stderr: "" };
}

// ---- Running ----

type Store = { db: Database; failure: (error: unknown) => string };

async function runWith(
  store: Store,
  loaded: Loaded,
  options: Options,
  setup: Setup,
  cliOptions: ResolveCliOptions,
): Promise<CliResult> {
  const { db } = store;
  const clock = cliOptions.clock ?? (() => new Date());
  const { file, photos } = loaded;

  let senders: Awaited<ReturnType<typeof resolveSenders>>;
  try {
    senders = await resolveSenders(db, file.messages);
  } catch (error) {
    return cantRun(store.failure(error));
  }
  if (!senders.ok) return cantRun(senders.error);
  const { emails } = senders;

  const runner = createModeRunner({
    db,
    generateContent: setup.generateContent,
    protectedEnv: setup.protectedEnv,
    issueToken: setup.issueToken,
    ...(cliOptions.createTransport ? { createTransport: cliOptions.createTransport } : {}),
    clock,
    fallbackModel: setup.fallbackModel,
  });
  return runMessages({ db, store, file, photos, emails, options, setup, clock, runner });
}

async function runMessages(input: {
  db: Database;
  store: Store;
  file: MessageFile;
  photos: Photo[][];
  emails: string[];
  options: Options;
  setup: Setup;
  clock: () => Date;
  runner: ReturnType<typeof createModeRunner>;
}): Promise<CliResult> {
  const { db, store, file, photos, emails, options, setup, clock, runner } = input;
  const ran: Ran[] = [];
  for (const [index, message] of file.messages.entries()) {
    const earlier = (count: number) =>
      count === 0
        ? "No earlier message ran."
        : `${plural(count, "earlier message", "earlier messages")} ran first.`;
    try {
      const threadId =
        message.follow_up_of === undefined ? undefined : ran[message.follow_up_of]?.threadId;
      const checked = await checkMessage(db, {
        channel: message.channel,
        ...(threadId === undefined ? {} : { thread_id: threadId }),
        sender_email: emails[index],
        ...(message.subject === undefined ? {} : { subject: message.subject }),
        body: message.body,
        attachments: (photos[index] ?? []).map((photo) => ({
          content_type: photo.contentType,
          data: photo.data,
        })),
        mode: options.mode,
      });
      if (!checked.ok) {
        return cantRun(`Message ${index + 1}: ${checked.problem} ${earlier(index)}`);
      }
      const arrivedAt = clock();
      const capped = await overDailyCap(db, arrivedAt, setup.dailyCap);
      const stored = await storeMessage(db, checked.value.message, {
        mode: options.mode,
        model: setup.model,
        clock: () => arrivedAt,
      });
      const runs: AgentRun[] = [];
      if (capped) {
        await finishRun(db, stored.runId, {
          status: "not_run",
          outcome: "daily_cap",
          reply: null,
          modelVersions: [],
          trace: null,
          finishedAt: clock().toISOString(),
        });
        runs.push((await readRun(db, stored.runId)) as AgentRun);
      } else {
        let next: string | undefined = stored.runId;
        while (next !== undefined) {
          const runId: string = next;
          const followUp = await runner(runId);
          runs.push((await readRun(db, runId)) as AgentRun);
          next = typeof followUp === "string" ? followUp : undefined;
        }
      }
      ran.push({ index, ticketId: stored.ticketId, threadId: stored.threadId, runs });
    } catch (error) {
      return cantRun(`Message ${index + 1}: ${store.failure(error)} ${earlier(index)}`);
    }
  }
  return render(options.json, file, emails, ran);
}

/**
 * Runs a scenario file through Resolve. Exit 0 when every message got a reply, 1 when any run
 * stopped, failed or didn't run, 2 when it can't run.
 */
export async function runResolve(
  args: readonly string[],
  env: Environment,
  cliOptions: ResolveCliOptions = {},
): Promise<CliResult> {
  const parsed = parseArgs(args);
  if (!("ok" in parsed)) return parsed;
  const { options } = parsed;
  const loaded = loadFile(options.path);
  if (!loaded.ok) return cantRun(loaded.error);
  const read = readEnv(env, options.mode, cliOptions);
  if (!read.ok) return cantRun(read.error);

  if (cliOptions.db !== undefined) {
    const store: Store = {
      db: cliOptions.db,
      failure: () => "Couldn't read or write the ticket store.",
    };
    return runWith(store, loaded.loaded, options, read.setup, cliOptions);
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
    failure: (error) =>
      `Couldn't use the database at ${targetName(target)}: ${failureReason(error, target)}. Run npm run db:migrate and npm run seed first.`,
  };
  try {
    return await runWith(store, loaded.loaded, options, read.setup, cliOptions);
  } finally {
    await handle.close().catch(() => {});
  }
}
