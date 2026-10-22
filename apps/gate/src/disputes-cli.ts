// The disputes CLI (ADR 0035): `sync` polls the merchant's disputes waiting for the seller and
// records each one the audit log doesn't hold yet as `dispute.received` (source poll), then nudges
// Resolve; `list` and `show` read disputes; `require-evidence` and `adjudicate` call PayPal's
// sandbox-only helpers to move a test dispute along. It never moves money. No AI. Returns the
// output and exit code rather than writing them.

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
import { withAuditLog } from "@countersign/ledger";
import { formatMoney } from "@countersign/mandate";
import {
  createPayPalClient,
  type FetchLike,
  type PayPalClient,
  type PayPalDisputeDetail,
  PayPalError,
  parsePayPalEnv,
} from "@countersign/rail-paypal";
import { z } from "zod";
import type { CliResult } from "./decide-cli";
import { type DisputeState, disputeReceivedEntry, readDisputeState } from "./dispute-log";
import { type NudgeFetch, nudgeResolve } from "./nudge";

export const DISPUTES_USAGE = [
  "Usage: npm run disputes -- <command> [--pglite <dir>]",
  "  sync                                  Record the disputes waiting for the seller that the audit log doesn't hold yet.",
  "  list                                  List the merchant's disputes.",
  "  show <id>                             Show one dispute and its dispute.received entry.",
  "  require-evidence <id> [--buyer]       Sandbox only. Ask for the seller's (or the buyer's) evidence.",
  "  adjudicate <id> --favor seller|buyer  Sandbox only. Settle a dispute under review.",
].join("\n");

export const EXIT_OK = 0;
export const EXIT_NEGATIVE = 1;
export const EXIT_CANT_RUN = 2;

// The largest page PayPal's dispute list answers.
const PAGE_SIZE = 50;

export type DisputesCliDeps = {
  // A rail client to use instead of one built from the environment, for tests. The environment's
  // PayPal variables are still required.
  rail?: PayPalClient;
  fetch?: FetchLike;
  // What the nudge to Resolve is sent with, for tests.
  nudgeFetch?: NudgeFetch;
  // The time `dispute.received` entries are logged at. Defaults to the system clock, read at
  // this edge only.
  now?: () => Date;
};

const DisputeIdSchema = z.string().regex(/^[A-Za-z0-9-]{1,255}$/);

const CommandSchema = z.union([
  z.tuple([z.enum(["sync", "list"])]).transform(([command]) => ({ command })),
  z.tuple([z.literal("show"), DisputeIdSchema]).transform(([command, id]) => ({ command, id })),
  z
    .union([
      z.tuple([z.literal("require-evidence"), DisputeIdSchema]),
      z.tuple([z.literal("require-evidence"), DisputeIdSchema, z.literal("--buyer")]),
    ])
    .transform(([command, id, buyer]) => ({
      command,
      id,
      action: buyer ? ("BUYER_EVIDENCE" as const) : ("SELLER_EVIDENCE" as const),
    })),
  z
    .tuple([
      z.literal("adjudicate"),
      DisputeIdSchema,
      z.literal("--favor"),
      z.enum(["seller", "buyer"]),
    ])
    .transform(([command, id, , favor]) => ({
      command,
      id,
      outcome: favor === "seller" ? ("SELLER_FAVOR" as const) : ("BUYER_FAVOR" as const),
    })),
]);
type Command = z.infer<typeof CommandSchema>;

function cantRun(error: string): CliResult {
  return { exitCode: EXIT_CANT_RUN, stdout: "", stderr: `${error.replace(/\s*\n\s*/g, " ")}\n` };
}

const usageError = (error: string): CliResult => ({
  exitCode: EXIT_CANT_RUN,
  stdout: "",
  stderr: `${error}\n${DISPUTES_USAGE}\n`,
});

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

const output = (exitCode: number, lines: readonly string[]): CliResult => ({
  exitCode,
  stdout: lines.length === 0 ? "" : `${lines.join("\n")}\n`,
  stderr: "",
});

function paypalProblem(env: Environment): string | null {
  const parsed = parsePayPalEnv(env);
  if (parsed.ok) return null;
  const sentences = ["The disputes CLI can't start."];
  if (parsed.missing.length > 0) sentences.push(`Set ${parsed.missing.join(", ")} in .env.local.`);
  sentences.push(...parsed.problems.filter((problem) => !problem.endsWith(" is missing.")));
  return sentences.join(" ");
}

function failure(error: unknown): string {
  return error instanceof PayPalError ? error.message : "The call failed unexpectedly.";
}

// PayPal said no: a 4xx answer. Anything else leaves the outcome unknown.
const refused = (error: unknown) =>
  error instanceof PayPalError &&
  error.kind === "http" &&
  error.status !== null &&
  error.status >= 400 &&
  error.status < 500;

function dueDate(dispute: PayPalDisputeDetail): string {
  const due = dispute.sellerResponseDueDate;
  if (due === null) return "no due date";
  return `due ${/^\d{4}-\d{2}-\d{2}/.test(due) ? due.slice(0, 10) : due}`;
}

type LogRead = { ok: true; state: DisputeState } | { ok: false; error: string };

async function readState(db: Database): Promise<LogRead> {
  const read = await readDisputeState(db);
  return read.known
    ? { ok: true, state: read.state }
    : { ok: false, error: `The audit log has an entry that can't be read: ${read.detail}.` };
}

type SyncDeps = { now: () => Date; env: Environment; nudgeFetch?: NudgeFetch };

async function sync(db: Database, rail: PayPalClient, deps: SyncDeps): Promise<CliResult> {
  const before = await readState(db);
  if (!before.ok) return cantRun(before.error);
  let page: Awaited<ReturnType<PayPalClient["listMerchantDisputes"]>>;
  try {
    page = await rail.listMerchantDisputes({
      pageSize: PAGE_SIZE,
      disputeState: "REQUIRED_ACTION",
    });
  } catch (error) {
    return cantRun(`Couldn't list the merchant's disputes: ${failure(error)}`);
  }

  const lines: string[] = [];
  let problems = 0;
  for (const { id } of page.disputes) {
    if (before.state.disputes.has(id)) {
      lines.push(`Already recorded ${id}.`);
      continue;
    }
    let dispute: PayPalDisputeDetail;
    try {
      dispute = await rail.getDispute(id);
    } catch (error) {
      problems += 1;
      lines.push(`Couldn't re-read ${id}: ${failure(error)}`);
      continue;
    }
    let entry: ReturnType<typeof disputeReceivedEntry>;
    try {
      entry = disputeReceivedEntry({ at: deps.now().toISOString(), source: "poll", dispute });
    } catch {
      problems += 1;
      lines.push(`Couldn't record ${id}: PayPal's dispute doesn't fit a dispute.received entry.`);
      continue;
    }
    // The dispute was read outside the lock; another run or a webhook may have logged it since.
    const logged = await withAuditLog(db, async (log) => {
      const again = await readDisputeState(log.tx);
      if (!again.known) return "unknown" as const;
      if (again.state.disputes.has(dispute.id)) return "skipped" as const;
      await log.append(entry);
      return "logged" as const;
    });
    if (logged === "unknown") {
      // What was recorded before stays in the output.
      return {
        ...output(EXIT_CANT_RUN, lines),
        stderr: `${id} wasn't recorded: the audit log has an entry that can't be read.\n`,
      };
    }
    if (logged === "skipped") {
      lines.push(`Already recorded ${id}.`);
      continue;
    }
    const [capture] = dispute.captureIds;
    lines.push(
      capture === undefined
        ? `Recorded dispute ${dispute.id} for ${formatMoney(dispute.amount)}. It names no capture.`
        : `Recorded dispute ${dispute.id} on capture ${capture} for ${formatMoney(dispute.amount)}.`,
    );
    const nudged = await nudgeResolve(dispute.id, {
      env: deps.env,
      ...(deps.nudgeFetch ? { fetch: deps.nudgeFetch } : {}),
    });
    if (!nudged) {
      lines.push(`Resolve wasn't reachable; run npm run resolve -- dispute ${dispute.id}.`);
    }
  }
  if (page.disputes.length === 0) lines.push("No disputes are waiting for the seller.");
  if (!page.complete) {
    lines.push(`PayPal had more pages of disputes. Only the first ${PAGE_SIZE} were read.`);
  }
  return output(problems === 0 ? EXIT_OK : EXIT_NEGATIVE, lines);
}

async function list(db: Database, rail: PayPalClient): Promise<CliResult> {
  const state = await readState(db);
  if (!state.ok) return cantRun(state.error);
  let page: Awaited<ReturnType<PayPalClient["listMerchantDisputes"]>>;
  try {
    page = await rail.listMerchantDisputes({ pageSize: PAGE_SIZE });
  } catch (error) {
    return cantRun(`Couldn't list the merchant's disputes: ${failure(error)}`);
  }
  if (page.disputes.length === 0) return output(EXIT_OK, ["No disputes."]);
  const lines = [`${plural(page.disputes.length, "dispute", "disputes")}.`];
  let problems = 0;
  for (const { id, status } of page.disputes) {
    const recorded = state.state.disputes.has(id) ? "recorded" : "not recorded";
    let dispute: PayPalDisputeDetail;
    try {
      dispute = await rail.getDispute(id);
    } catch (error) {
      problems += 1;
      lines.push(`  ${id}  ${status}  couldn't read it: ${failure(error)}  ${recorded}`);
      continue;
    }
    lines.push(
      `  ${dispute.id}  ${dispute.status}  ${dispute.reason}  ${formatMoney(dispute.amount)}  ${dueDate(dispute)}  ${recorded}`,
    );
  }
  if (!page.complete) {
    lines.push(`PayPal had more pages of disputes. Only the first ${PAGE_SIZE} are shown.`);
  }
  return output(problems === 0 ? EXIT_OK : EXIT_NEGATIVE, lines);
}

async function show(db: Database, rail: PayPalClient, id: string): Promise<CliResult> {
  const state = await readState(db);
  if (!state.ok) return cantRun(state.error);
  let dispute: PayPalDisputeDetail;
  try {
    dispute = await rail.getDispute(id);
  } catch (error) {
    const line = `Couldn't read ${id}: ${failure(error)}`;
    return refused(error) ? output(EXIT_NEGATIVE, [line]) : cantRun(line);
  }
  const seq = state.state.firstSeqs.get(dispute.id);
  return output(EXIT_OK, [
    `Dispute ${dispute.id}`,
    `  Status    ${dispute.status}`,
    `  Reason    ${dispute.reason}`,
    `  Stage     ${dispute.lifeCycleStage}`,
    `  Amount    ${formatMoney(dispute.amount)}`,
    `  Due       ${dispute.sellerResponseDueDate ?? "no due date"}`,
    `  Captures  ${dispute.captureIds.length > 0 ? dispute.captureIds.join(", ") : "none"}`,
    `  Actions   ${dispute.linkNames.length > 0 ? dispute.linkNames.join(", ") : "none"}`,
    seq === undefined
      ? "  Recorded  not yet; run npm run disputes -- sync to record it."
      : `  Recorded  dispute.received #${seq}`,
  ]);
}

// The sandbox-only helpers. Each is sent once and never retried; only a 4xx is a refusal.
async function sandboxHelper(
  rail: PayPalClient,
  command: Extract<Command, { command: "require-evidence" | "adjudicate" }>,
): Promise<CliResult> {
  try {
    if (command.command === "require-evidence") {
      const status = await rail.requireEvidence({ disputeId: command.id, action: command.action });
      const party = command.action === "BUYER_EVIDENCE" ? "buyer's" : "seller's";
      return output(EXIT_OK, [
        `Sandbox only. PayPal now asks for the ${party} evidence on ${command.id} (HTTP ${status}).`,
      ]);
    }
    const status = await rail.adjudicate({ disputeId: command.id, outcome: command.outcome });
    const party = command.outcome === "BUYER_FAVOR" ? "buyer's" : "seller's";
    return output(EXIT_OK, [
      `Sandbox only. PayPal settled ${command.id} in the ${party} favour (HTTP ${status}).`,
    ]);
  } catch (error) {
    if (refused(error))
      return output(EXIT_NEGATIVE, [`Sandbox only. PayPal refused it: ${failure(error)}`]);
    return cantRun(
      `Sandbox only. PayPal's answer is unknown: ${failure(error)} Check it with npm run disputes -- show ${command.id}.`,
    );
  }
}

/** Runs the disputes CLI. Exit 0 on success, 1 for a negative result such as a refusal, 2 when it can't run. */
export async function runDisputes(
  args: readonly string[],
  env: Environment,
  deps: DisputesCliDeps = {},
): Promise<CliResult> {
  const option = takePgliteOption(args);
  if (!option.ok) return usageError(option.error);
  const parsed = CommandSchema.safeParse(option.rest);
  if (!parsed.success) {
    const [first] = option.rest;
    return usageError(
      first === undefined
        ? "Name a command."
        : `The arguments ${option.rest.join(" ")} aren't a disputes command.`,
    );
  }
  const command = parsed.data;
  const missing = paypalProblem(env);
  if (missing) return cantRun(missing);
  const rail =
    deps.rail ?? createPayPalClient({ env, ...(deps.fetch ? { fetch: deps.fetch } : {}) });
  if (command.command === "require-evidence" || command.command === "adjudicate") {
    return sandboxHelper(rail, command);
  }
  const now = deps.now ?? (() => new Date());

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
    switch (command.command) {
      case "sync":
        return await sync(handle.db, rail, {
          now,
          env,
          ...(deps.nudgeFetch ? { nudgeFetch: deps.nudgeFetch } : {}),
        });
      case "list":
        return await list(handle.db, rail);
      case "show":
        return await show(handle.db, rail, command.id);
    }
  } catch (error) {
    return cantRun(
      `Couldn't use the audit log at ${targetName(target)}: ${failureReason(error, target)}`,
    );
  } finally {
    await handle.close().catch(() => {});
  }
}
