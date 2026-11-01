// Dispute sync as a function (ADR 0035): polls the merchant's disputes waiting for the seller,
// records each one the audit log doesn't hold yet as `dispute.received` (source poll), then nudges
// Resolve. The disputes CLI formats the result for the terminal; the demo reset uses the counts.
// It never moves money. No AI. The clock comes in through `deps.now`.

import type { Database, Environment } from "@countersign/db";
import { withAuditLog } from "@countersign/ledger";
import { formatMoney } from "@countersign/mandate";
import { type PayPalClient, type PayPalDisputeDetail, PayPalError } from "@countersign/rail-paypal";
import { disputeReceivedEntry, readDisputeState } from "./dispute-log";
import { type NudgeFetch, nudgeResolve } from "./nudge";

// The largest page PayPal's dispute list answers.
export const DISPUTE_PAGE_SIZE = 50;

export type DisputeSyncDeps = { now: () => Date; env: Environment; nudgeFetch?: NudgeFetch };

export type DisputeSync =
  | {
      ok: true;
      lines: string[];
      recorded: number;
      alreadyRecorded: number;
      problems: number;
    }
  // `lines` holds what was recorded before the sync stopped; `error` says why it stopped.
  | { ok: false; error: string; lines: string[] };

function failure(error: unknown): string {
  return error instanceof PayPalError ? error.message : "The call failed unexpectedly.";
}

export async function syncDisputes(
  db: Database,
  rail: PayPalClient,
  deps: DisputeSyncDeps,
): Promise<DisputeSync> {
  const before = await readDisputeState(db);
  if (!before.known) {
    return {
      ok: false,
      error: `The audit log has an entry that can't be read: ${before.detail}.`,
      lines: [],
    };
  }
  let page: Awaited<ReturnType<PayPalClient["listMerchantDisputes"]>>;
  try {
    page = await rail.listMerchantDisputes({
      pageSize: DISPUTE_PAGE_SIZE,
      disputeState: "REQUIRED_ACTION",
    });
  } catch (error) {
    return {
      ok: false,
      error: `Couldn't list the merchant's disputes: ${failure(error)}`,
      lines: [],
    };
  }

  const lines: string[] = [];
  let recorded = 0;
  let alreadyRecorded = 0;
  let problems = 0;
  for (const { id } of page.disputes) {
    if (before.state.disputes.has(id)) {
      alreadyRecorded += 1;
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
      return {
        ok: false,
        error: `${id} wasn't recorded: the audit log has an entry that can't be read.`,
        lines,
      };
    }
    if (logged === "skipped") {
      alreadyRecorded += 1;
      lines.push(`Already recorded ${id}.`);
      continue;
    }
    recorded += 1;
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
    lines.push(`PayPal had more pages of disputes. Only the first ${DISPUTE_PAGE_SIZE} were read.`);
  }
  return { ok: true, lines, recorded, alreadyRecorded, problems };
}
