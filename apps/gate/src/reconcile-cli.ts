// The reconcile CLI: re-reads every executed refund the audit log hasn't reconciled, logs a
// reconciliation for each (source poll), re-reads every executed payout whose item isn't final
// and logs one when its status has changed (ADR 0039), and lists requests whose outcome is still
// open. It never moves money (ADR 0026). Returns the output and exit code rather than writing them.

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
import { formatMoney, type Money } from "@countersign/mandate";
import {
  createPayPalClient,
  type FetchLike,
  type PayPalClient,
  PayPalError,
  parsePayPalEnv,
} from "@countersign/rail-paypal";
import type { CliResult } from "./decide-cli";
import {
  type ExecutedIntent,
  type ExecutedPayoutIntent,
  PAYOUT_FINAL_STATUSES,
  readPayoutWork,
  readReconcileWork,
  reconciliationEntry,
} from "./execution-log";

export const RECONCILE_USAGE = "Usage: npm run reconcile [-- --pglite <dir>]";

export const EXIT_RECONCILED = 0;
export const EXIT_OPEN = 1;
export const EXIT_CANT_RUN = 2;

export type ReconcileCliOptions = {
  // A rail client to use instead of one built from the environment, for tests. The environment's
  // PayPal variables are still required.
  rail?: PayPalClient;
  fetch?: FetchLike;
  // The time requests' ages are measured to, and reconciliations are logged at. Defaults to the
  // system clock, read at this edge only.
  now?: () => Date;
};

function cantRun(error: string): CliResult {
  return { exitCode: EXIT_CANT_RUN, stdout: "", stderr: `${error.replace(/\s*\n\s*/g, " ")}\n` };
}

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

function paypalProblem(env: Environment): string | null {
  const parsed = parsePayPalEnv(env);
  if (parsed.ok) return null;
  const sentences = ["The reconcile CLI can't start."];
  if (parsed.missing.length > 0) sentences.push(`Set ${parsed.missing.join(", ")} in .env.local.`);
  sentences.push(...parsed.problems.filter((problem) => !problem.endsWith(" is missing.")));
  return sentences.join(" ");
}

function formatAge(from: string, to: Date): string {
  const minutes = Math.max(0, Math.floor((to.getTime() - new Date(from).getTime()) / 60_000));
  if (minutes < 60) return plural(minutes, "minute", "minutes");
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return plural(hours, "hour", "hours");
  return plural(Math.floor(hours / 24), "day", "days");
}

const sameMoney = (a: Money, b: Money) => a.minor === b.minor && a.currency === b.currency;

type Refund = { status: string; amount: Money };

// What is wrong with a re-read refund, or null when it matches its request.
function refundProblem(intent: ExecutedIntent, refund: Refund): string | null {
  if (refund.status === "FAILED" || refund.status === "CANCELLED") {
    return `Refund ${intent.refundId} for ${intent.intentId} is ${refund.status}, so no money moved.`;
  }
  if (!sameMoney(refund.amount, intent.amount)) {
    return `Refund ${intent.refundId} for ${intent.intentId} is ${formatMoney(refund.amount)}, but the request was ${formatMoney(intent.amount)}.`;
  }
  return null;
}

function readFailure(error: unknown): string {
  return error instanceof PayPalError ? error.message : "The read failed unexpectedly.";
}

// What one payout's re-read gave: a line saying where it is now, and what needs attention.
type PayoutRun = { line: string | null; problem: string | null };

type ReadItem = {
  batchId: string;
  itemId: string;
  status: string;
  amount: Money;
  senderBatchId: string | null;
};

const PAYOUT_STATUS_WORDS: Record<string, string> = {
  UNCLAIMED: ", waiting for the payee to claim it",
};

function payoutLine(payout: ExecutedPayoutIntent, what: string): string {
  return `Payout ${payout.intentId}${payout.payee === null ? "" : ` to ${payout.payee}`}: ${what}.`;
}

// Re-reads a payout's item, by its ID or, when none is known yet, through its batch, and logs a
// reconciliation when its status has changed. The item is read outside the ledger's lock.
async function reconcilePayout(
  db: Database,
  rail: PayPalClient,
  payout: ExecutedPayoutIntent,
  now: Date,
): Promise<PayoutRun> {
  let item: ReadItem | null;
  try {
    if (payout.item !== null) {
      item = await rail.getPayoutItem(payout.item.id);
    } else {
      const batch = await rail.getPayoutBatch(payout.batchId);
      const [first] = batch.items;
      item = first
        ? { ...first, batchId: batch.batchId, senderBatchId: batch.senderBatchId }
        : null;
    }
  } catch (error) {
    const what = payout.item ? `item ${payout.item.id}` : `batch ${payout.batchId}`;
    return { line: null, problem: `Couldn't re-read payout ${what}: ${readFailure(error)}` };
  }
  if (item === null) {
    return { line: payoutLine(payout, `batch ${payout.batchId} names no item yet`), problem: null };
  }
  if (item.batchId !== payout.batchId) {
    return {
      line: null,
      problem: `Payout item ${item.itemId} is in batch ${item.batchId}, not ${payout.intentId}'s batch ${payout.batchId}.`,
    };
  }
  if (item.senderBatchId !== null && item.senderBatchId !== payout.intentId) {
    return {
      line: null,
      problem: `Payout batch ${item.batchId} was sent as ${item.senderBatchId}, not ${payout.intentId}.`,
    };
  }
  const line = payoutLine(payout, `${item.status}${PAYOUT_STATUS_WORDS[item.status] ?? ""}`);
  if (payout.item !== null && payout.item.status === item.status) return { line, problem: null };

  const read = item;
  // Another run may have logged the payout since it was read.
  const logged = await withAuditLog(db, async (log) => {
    const again = await readPayoutWork(log.tx);
    if (!again.known) return false;
    const current = again.payouts.find((each) => each.intentId === payout.intentId);
    if (current === undefined) return true;
    if (current.item?.id !== payout.item?.id || current.item?.status !== payout.item?.status) {
      return true;
    }
    await log.append(
      reconciliationEntry({
        at: now.toISOString(),
        intentId: payout.intentId,
        source: "poll",
        payout: {
          batchId: read.batchId,
          itemId: read.itemId,
          status: read.status,
          amount: read.amount,
        },
        resultSeq: payout.resultSeq,
      }),
    );
    return true;
  });
  // Never silently skipped: an unreadable log leaves the payout unreconciled.
  return logged
    ? { line, problem: null }
    : {
        line,
        problem: `Payout item ${read.itemId} wasn't logged: the audit log has an entry that can't be read.`,
      };
}

async function reconcileAll(
  db: Database,
  rail: PayPalClient,
  now: Date,
): Promise<{ ok: true; result: CliResult } | { ok: false; error: string }> {
  const first = await readReconcileWork(db);
  if (!first.known) {
    return { ok: false, error: `The audit log has an entry that can't be read: ${first.detail}.` };
  }
  const payouts = await readPayoutWork(db);
  if (!payouts.known) {
    return {
      ok: false,
      error: `The audit log has an entry that can't be read: ${payouts.detail}.`,
    };
  }

  const done: string[] = [];
  const problems: string[] = [];
  let unreadable = 0;
  for (const intent of first.work.executed) {
    if (intent.reconciled !== null) {
      const problem = refundProblem(intent, intent.reconciled);
      if (problem) problems.push(problem);
      continue;
    }
    let refund: Awaited<ReturnType<PayPalClient["getRefund"]>>;
    try {
      refund = await rail.getRefund(intent.refundId);
    } catch (error) {
      unreadable += 1;
      problems.push(`Couldn't re-read refund ${intent.refundId}: ${readFailure(error)}`);
      continue;
    }
    // The refund was read outside the lock; another run may have logged it since.
    const logged = await withAuditLog(db, async (log) => {
      const again = await readReconcileWork(log.tx);
      if (!again.known) return "unknown" as const;
      const current = again.work.executed.find((item) => item.refundId === intent.refundId);
      if (current === undefined || current.reconciled !== null) return "skipped" as const;
      await log.append(
        reconciliationEntry({
          at: now.toISOString(),
          intentId: intent.intentId,
          source: "poll",
          refund: {
            id: refund.id,
            captureId: refund.captureId,
            status: refund.status,
            amount: refund.amount,
          },
          resultSeq: intent.resultSeq,
        }),
      );
      return "logged" as const;
    });
    if (logged === "unknown") {
      // Never silently skipped: an unreadable log leaves the refund unreconciled.
      unreadable += 1;
      problems.push(
        `Refund ${intent.refundId} wasn't logged: the audit log has an entry that can't be read.`,
      );
      continue;
    }
    if (logged === "skipped") continue;
    done.push(
      `  ${intent.intentId}  ${refund.id}  ${refund.status}  ${formatMoney(refund.amount)}`,
    );
    const problem = refundProblem(intent, refund);
    if (problem) problems.push(problem);
  }

  // A payout whose item is final isn't re-read; one still open at PayPal needs no attention.
  const payoutLines: string[] = [];
  for (const payout of payouts.payouts) {
    if (payout.item !== null && PAYOUT_FINAL_STATUSES.includes(payout.item.status)) continue;
    const { line, problem } = await reconcilePayout(db, rail, payout, now);
    if (line) payoutLines.push(`  ${line}`);
    if (problem) problems.push(problem);
  }

  const lines: string[] = [];
  lines.push(
    first.work.executed.length === 0 && payouts.payouts.length === 0
      ? "Nothing to reconcile."
      : done.length === 0
        ? "No refunds to reconcile."
        : `Reconciled ${plural(done.length, "refund", "refunds")}.`,
    ...done,
  );
  if (payoutLines.length > 0) {
    lines.push("", `Re-read ${plural(payoutLines.length, "payout", "payouts")}.`, ...payoutLines);
  }
  if (problems.length > 0) lines.push("", "Needs attention", ...problems.map((p) => `  ${p}`));
  const open = first.work.open;
  if (open.length > 0) {
    lines.push("", "Requests with no outcome, oldest first");
    for (const request of open) {
      const target =
        request.payee === undefined
          ? `capture ${request.captureId ?? "none"}`
          : `payee ${request.payee}`;
      lines.push(`  ${request.intentId}  ${target}  ${formatAge(request.at, now)} old`);
    }
    if (open.some((request) => request.payee === undefined)) {
      lines.push("Replay the proposal to finish a request, or check PayPal for its refund.");
    }
    if (open.some((request) => request.payee !== undefined)) {
      lines.push("The gate never sends a payout twice, so check PayPal for the payout's batch.");
    }
  }
  const clean = problems.length === 0 && open.length === 0 && unreadable === 0;
  return {
    ok: true,
    result: {
      exitCode: clean ? EXIT_RECONCILED : EXIT_OPEN,
      stdout: `${lines.join("\n")}\n`,
      stderr: "",
    },
  };
}

/** Runs the reconcile CLI. Exit 0 when all is reconciled, 1 when something needs attention, 2 when it can't run. */
export async function runReconcile(
  args: readonly string[],
  env: Environment,
  options: ReconcileCliOptions = {},
): Promise<CliResult> {
  const option = takePgliteOption(args);
  if (!option.ok) return cantRun(`${option.error} ${RECONCILE_USAGE}`);
  if (option.rest.length > 0) {
    const [extra] = option.rest;
    return cantRun(
      `${extra?.startsWith("-") ? `Unknown option ${extra}.` : `Unexpected argument ${extra}.`} ${RECONCILE_USAGE}`,
    );
  }
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
    const run = await reconcileAll(handle.db, rail, now());
    return run.ok ? run.result : cantRun(run.error);
  } catch (error) {
    return cantRun(
      `Couldn't use the audit log at ${targetName(target)}: ${failureReason(error, target)}`,
    );
  } finally {
    await handle.close().catch(() => {});
  }
}
