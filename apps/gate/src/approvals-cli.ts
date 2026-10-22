// The approvals CLI: lists the open step-up cards, shows one, and answers one from the terminal
// (channel `cli`). Every answer goes through answerStepUp(), so the same checks, entries and
// executors apply as on the approvals page (ADR 0032). No AI. Returns the output and exit code
// rather than writing them.

import {
  type Database,
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
import type { Mandate } from "@countersign/mandate";
import {
  createPayPalClient,
  type FetchLike,
  type PayPalClient,
  parsePayPalEnv,
} from "@countersign/rail-paypal";
import { type AnswerStepUpResult, answerStepUp } from "./answer-step-up";
import {
  buildCard,
  type Card,
  type CardCheck,
  type CardExecution,
  type RecentSummary,
  readApprovals,
} from "./approval-cards";
import { type ApprovalRejectionCode, readStepUp } from "./approval-log";
import type { CliResult } from "./decide-cli";
import type { Execution } from "./executors";
import { loadPrincipals } from "./principals";

export const APPROVALS_USAGE =
  "Usage: npm run approvals -- list | show <id> | approve <id> --hash <intent hash> | deny <id> [--json] [--pglite <dir>]";

export const EXIT_ANSWERED = 0;
export const EXIT_NOT_DONE = 1;
export const EXIT_CANT_RUN = 2;

export type ApprovalsCliDeps = {
  // A rail client to use instead of one built from the environment, for tests. An approval still
  // needs the environment's PayPal variables.
  rail?: PayPalClient;
  fetch?: FetchLike;
  // The time left on cards is measured from it, and answers are made at it. Defaults to the
  // system clock, read at this edge only.
  now?: () => Date;
  // The mandates card checks are narrowed by. Defaults to the shipped support agent's.
  mandates?: readonly Mandate[];
};

const cantRun = (error: string): CliResult => ({
  exitCode: EXIT_CANT_RUN,
  stdout: "",
  stderr: `${error.replace(/\s*\n\s*/g, " ")}\n`,
});

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

const REJECTIONS: Record<ApprovalRejectionCode, string> = {
  HASH_MISMATCH: "This card changed. Nothing was sent.",
  ALREADY_ANSWERED: "This was already answered.",
  EXPIRED: "This card expired, so it counts as denied.",
  ALREADY_REQUESTED: "This was already carried out.",
  ACTION_UNAVAILABLE: "Countersign can't carry out this action yet.",
  DUPLICATE_REFUND: "Another refund already went to this payment.",
};

type Command =
  | { kind: "list" }
  | { kind: "show"; id: number }
  | { kind: "approve"; id: number; hash: string }
  | { kind: "deny"; id: number };

type Parsed =
  | { ok: true; command: Command; json: boolean; pgliteDir: string | undefined }
  | { ok: false; error: string };

const usageError = (what: string): Parsed => ({ ok: false, error: `${what} ${APPROVALS_USAGE}` });

function parseArgs(args: readonly string[]): Parsed {
  const option = takePgliteOption(args);
  if (!option.ok) return usageError(option.error);
  let json = false;
  let hash: string | undefined;
  const words: string[] = [];
  for (let i = 0; i < option.rest.length; i += 1) {
    const arg = option.rest[i] as string;
    if (arg === "--json") json = true;
    else if (arg === "--hash") {
      const value = option.rest[i + 1];
      if (value === undefined || value.startsWith("-")) return usageError("--hash needs a value.");
      hash = value;
      i += 1;
    } else if (arg.startsWith("-")) return usageError(`Unknown option ${arg}.`);
    else words.push(arg);
  }
  const [name, idText, ...extra] = words;
  if (name === undefined) return usageError("Say what to do.");
  if (extra.length > 0) return usageError(`Unexpected argument ${extra[0]}.`);
  const pgliteDir = option.pgliteDir;
  if (name === "list") {
    if (idText !== undefined) return usageError(`Unexpected argument ${idText}.`);
    if (hash !== undefined) return usageError("--hash only goes with approve.");
    return { ok: true, command: { kind: "list" }, json, pgliteDir };
  }
  if (name !== "show" && name !== "approve" && name !== "deny") {
    return usageError(`Unknown command ${name}.`);
  }
  if (idText === undefined) return usageError(`${name} needs a step-up ID.`);
  if (!/^[1-9][0-9]{0,15}$/.test(idText)) {
    return { ok: false, error: `${idText} isn't a step-up ID.` };
  }
  const id = Number(idText);
  if (name === "approve") {
    if (hash === undefined) return usageError("approve needs --hash <intent hash>.");
    return { ok: true, command: { kind: "approve", id, hash }, json, pgliteDir };
  }
  if (hash !== undefined) return usageError("--hash only goes with approve.");
  return { ok: true, command: { kind: name, id }, json, pgliteDir };
}

function paypalProblem(env: Environment): string | null {
  const parsed = parsePayPalEnv(env);
  if (parsed.ok) return null;
  const sentences = ["The approvals CLI can't approve without PayPal."];
  if (parsed.missing.length > 0) sentences.push(`Set ${parsed.missing.join(", ")} in .env.local.`);
  sentences.push(...parsed.problems.filter((problem) => !problem.endsWith(" is missing.")));
  return sentences.join(" ");
}

function timeLeft(expiresAt: string, now: Date): string {
  const ms = new Date(expiresAt).getTime() - now.getTime();
  if (ms <= 0) return "Expired";
  const minutes = Math.ceil(ms / 60_000);
  return `Expires in ${minutes} min`;
}

function checkLine(check: CardCheck): string {
  const value = check.value === null ? "" : ` (${check.value})`;
  const records = check.records
    .map(({ call, id }) => (id === null ? call : `${call} ${id}`))
    .join(", ");
  return `  ${check.verifier}: ${check.result}${value}${records ? `, from ${records}` : ""}`;
}

function cardLine(card: Card, now: Date): string {
  const order = card.order_number === null ? "no order" : `order ${card.order_number}`;
  const reasons = card.reasons.map(({ words, code }) => `${words} (${code})`).join("; ");
  return `  ${card.step_up_id}  ${card.action_words} ${card.amount.display}  ${order}  ${reasons}  ${timeLeft(card.expires_at, now)}`;
}

function executionWords(execution: CardExecution | null): string {
  if (execution === null) return "";
  if (execution.refund) return `, refund ${execution.refund.id} ${execution.refund.status}`;
  if (execution.invoice) return `, invoice ${execution.invoice.id} ${execution.invoice.status}`;
  return execution.outcome === "executed" ? "" : `, ${execution.outcome}`;
}

function recentLine(item: RecentSummary): string {
  const order = item.order_number === null ? "no order" : `order ${item.order_number}`;
  return `  ${item.step_up_id}  ${item.action_words} ${item.amount.display}  ${order}  ${item.outcome} at ${item.at}${executionWords(item.execution)}`;
}

function showCard(card: Card, now: Date): string {
  const lines = [
    `${card.action_words} ${card.amount.display}`,
    `Step-up ${card.step_up_id}, intent ${card.intent_id}`,
    `Intent hash ${card.intent_hash}`,
    `${card.target.kind} ${card.target.id}${card.order_number === null ? "" : `, order ${card.order_number}`}`,
  ];
  if (card.ticket) {
    const { sender, subject, excerpt } = card.ticket;
    lines.push(`From ${sender ?? "unknown"}: ${subject ?? "no subject"}`, excerpt);
  }
  lines.push("", "Why it's waiting");
  for (const reason of card.reasons) lines.push(`  ${reason.words} (${reason.code})`);
  lines.push("", "What the records say", ...card.checks.map(checkLine), "");
  if (card.state === "open") lines.push(timeLeft(card.expires_at, now));
  else lines.push(card.answer ? `Answered: ${card.answer.outcome}.` : "Expired.");
  if (card.cannot_execute) lines.push(card.cannot_execute);
  return `${lines.join("\n")}\n`;
}

function refusalWords(execution: Execution): string {
  const { error } = execution;
  const parts = [error?.name, ...(error?.issues ?? [])].filter(Boolean);
  return parts.length > 0 ? parts.join(", ") : "no reason given";
}

function answerOutput(result: Extract<AnswerStepUpResult, { kind: "answered" }>): {
  sentence: string;
  exitCode: number;
} {
  if (result.outcome === "denied") return { sentence: "Denied. Nothing was sent.", exitCode: 0 };
  if (result.outcome === "rejected") {
    const code = result.code as ApprovalRejectionCode;
    return { sentence: `${REJECTIONS[code]} (${code})`, exitCode: EXIT_NOT_DONE };
  }
  const { execution } = result;
  if (execution === null) {
    return { sentence: "Approved. PayPal hasn't confirmed it yet.", exitCode: EXIT_NOT_DONE };
  }
  if (execution.outcome === "failed") {
    return {
      sentence: `Approved, but PayPal refused it: ${refusalWords(execution)}.`,
      exitCode: EXIT_NOT_DONE,
    };
  }
  if (execution.outcome === "executed") {
    if (execution.invoice) {
      const state = execution.invoice.status === "SENT" ? "sent" : "scheduled";
      return {
        sentence: `Approved. Invoice ${execution.invoice.id} is ${state}.`,
        exitCode: EXIT_ANSWERED,
      };
    }
    if (execution.refund) {
      return {
        sentence: `Approved. Refund ${execution.refund.id} is ${execution.refund.status === "COMPLETED" ? "done" : execution.refund.status}.`,
        exitCode: EXIT_ANSWERED,
      };
    }
  }
  return { sentence: "Approved. PayPal hasn't confirmed it yet.", exitCode: EXIT_NOT_DONE };
}

function answeredJson(result: Extract<AnswerStepUpResult, { kind: "answered" }>) {
  const { execution } = result;
  return {
    outcome: result.outcome,
    code: result.code,
    step_up_id: result.stepUpSeq,
    intent_id: result.intentId,
    approval_seq: result.approvalSeq,
    execution:
      execution === null
        ? null
        : {
            outcome: execution.outcome,
            refund: execution.refund,
            invoice: execution.invoice ?? null,
            error:
              execution.error === null
                ? null
                : { name: execution.error.name, issues: execution.error.issues },
          },
  };
}

const ok = (stdout: string, exitCode = EXIT_ANSWERED): CliResult => ({
  exitCode,
  stdout,
  stderr: "",
});

const jsonOut = (value: unknown, exitCode = EXIT_ANSWERED) =>
  ok(`${JSON.stringify(value, null, 2)}\n`, exitCode);

const UNREADABLE = "The audit log has an entry that can't be read, so nothing can be approved.";
const NOT_FOUND = "There's no step-up with that ID.";

type Context = {
  db: Database;
  command: Command;
  json: boolean;
  now: Date;
  clock: () => Date;
  mandates: readonly Mandate[];
  rail: PayPalClient | null;
};

async function runCommand(context: Context): Promise<CliResult> {
  const { db, command, json, now, mandates } = context;
  if (command.kind === "list") {
    const read = await readApprovals(db, now, mandates);
    if (!read.known) return cantRun(UNREADABLE);
    const { open, recent } = read.view;
    if (json) return jsonOut(read.view);
    const lines = [
      open.length === 0 ? "No open cards." : `${plural(open.length, "open card", "open cards")}`,
      ...open.map((card) => cardLine(card, now)),
      "",
      recent.length === 0 ? "No recent answers." : "Recent",
      ...recent.map(recentLine),
    ];
    return ok(`${lines.join("\n")}\n`);
  }
  if (command.kind === "show") {
    const read = await readStepUp(db, command.id, now);
    if (!read.known) return cantRun(UNREADABLE);
    if (read.stepUp === null) return cantRun(NOT_FOUND);
    const card = await buildCard(db, read.stepUp, mandates);
    return json ? jsonOut(card) : ok(showCard(card, now));
  }
  const approving = command.kind === "approve";
  let intentHash = approving ? command.hash : "";
  if (!approving) {
    // A deny carries no hash from the operator; it is bound to the card's own.
    const read = await readStepUp(db, command.id, now);
    if (!read.known) return cantRun(UNREADABLE);
    if (read.stepUp === null) return cantRun(NOT_FOUND);
    intentHash = read.stepUp.intentHash;
  }
  const result = await answerStepUp({
    db,
    // A deny never reaches PayPal.
    rail: context.rail as PayPalClient,
    stepUpSeq: command.id,
    answer: approving ? "approve" : "deny",
    intentHash,
    channel: "cli",
    now,
    clock: context.clock,
  });
  switch (result.kind) {
    case "answered": {
      const { sentence, exitCode } = answerOutput(result);
      return json ? jsonOut(answeredJson(result), exitCode) : ok(`${sentence}\n`, exitCode);
    }
    case "not_found":
      return cantRun(NOT_FOUND);
    case "input_error":
      return cantRun(approving ? "The intent hash isn't valid." : result.detail);
    case "unknown":
      return cantRun(UNREADABLE);
    case "recording_failed":
      return cantRun("Countersign couldn't record the answer, so nothing was done.");
  }
}

// A deny never reaches PayPal, so it runs without a rail; this one refuses any use.
const NO_RAIL = new Proxy({} as PayPalClient, {
  get() {
    throw new Error("PayPal isn't set up.");
  },
});

/** Runs the approvals CLI. Exit 0 when answered or listed, 1 when rejected or not carried out, 2 when it can't run. */
export async function runApprovals(
  args: readonly string[],
  env: Environment,
  deps: ApprovalsCliDeps = {},
): Promise<CliResult> {
  const parsed = parseArgs(args);
  if (!parsed.ok) return cantRun(parsed.error);
  const { command, json, pgliteDir } = parsed;

  let rail: PayPalClient = NO_RAIL;
  if (command.kind === "approve") {
    const missing = paypalProblem(env);
    if (missing) return cantRun(missing);
    rail = deps.rail ?? createPayPalClient({ env, ...(deps.fetch ? { fetch: deps.fetch } : {}) });
  }
  const clock = deps.now ?? (() => new Date());
  const mandates = deps.mandates ?? loadPrincipals({ env }).mandates;

  const target = resolveDatabaseTarget(env, pgliteDir);
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
    return await runCommand({ db: handle.db, command, json, now: clock(), clock, mandates, rail });
  } catch (error) {
    return cantRun(
      `Couldn't use the audit log at ${targetName(target)}: ${failureReason(error, target)}`,
    );
  } finally {
    await handle.close().catch(() => {});
  }
}
