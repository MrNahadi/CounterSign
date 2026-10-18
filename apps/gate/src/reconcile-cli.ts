// The reconcile CLI: re-reads every executed refund the audit log hasn't reconciled, logs a
// reconciliation for each (source poll), and lists requests whose outcome is still open. It never
// moves money (ADR 0026). Returns the output and exit code rather than writing them.

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
import { type ExecutedIntent, readReconcileWork, reconciliationEntry } from "./execution-log";

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

async function reconcileAll(
  db: Database,
  rail: PayPalClient,
  now: Date,
): Promise<{ ok: true; result: CliResult } | { ok: false; error: string }> {
  const first = await readReconcileWork(db);
  if (!first.known) {
    return { ok: false, error: `The audit log has an entry that can't be read: ${first.detail}.` };
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
      if (!again.known) return false;
      const current = again.work.executed.find((item) => item.refundId === intent.refundId);
      if (current === undefined || current.reconciled !== null) return false;
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
      return true;
    });
    if (!logged) continue;
    done.push(
      `  ${intent.intentId}  ${refund.id}  ${refund.status}  ${formatMoney(refund.amount)}`,
    );
    const problem = refundProblem(intent, refund);
    if (problem) problems.push(problem);
  }

  const lines: string[] = [];
  lines.push(
    done.length === 0
      ? "No refunds to reconcile."
      : `Reconciled ${plural(done.length, "refund", "refunds")}.`,
    ...done,
  );
  if (problems.length > 0) lines.push("", "Needs attention", ...problems.map((p) => `  ${p}`));
  const open = first.work.open;
  if (open.length > 0) {
    lines.push("", "Requests with no outcome, oldest first");
    for (const request of open) {
      lines.push(
        `  ${request.intentId}  capture ${request.captureId ?? "none"}  ${formatAge(request.at, now)} old`,
      );
    }
    lines.push("Replay the proposal to finish a request, or check PayPal for its refund.");
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
