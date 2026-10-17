// capture.refundable: the capture can still be refunded for the intent's amount.

import { formatMoney, type Intent, type TraceEntry } from "@countersign/mandate";
import { CALLS, type RecordSnapshots, recordRef } from "./snapshots";

const REFUNDABLE_STATUSES = new Set(["COMPLETED", "PARTIALLY_REFUNDED"]);

function isMinor(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

// The right status and currency, and no more than captured minus already refunded.
export function captureRefundable(intent: Intent, records: RecordSnapshots): TraceEntry {
  const { captureId } = intent.target;
  const capture = records.captures?.find((record) => record.id === captureId);
  const result = (outcome: TraceEntry["result"], detail: string): TraceEntry => ({
    verifier: "capture.refundable",
    result: outcome,
    records: [capture ? recordRef(capture) : { call: CALLS.capture, id: captureId }],
    detail,
  });
  if (!capture) return result("unknown", `No record of capture ${captureId}`);
  const { amount, refundedMinor } = capture;
  // A record we can't do arithmetic on proves nothing.
  if (!isMinor(amount.minor) || !isMinor(refundedMinor) || refundedMinor > amount.minor) {
    return result("unknown", `The record of capture ${captureId} has malformed amounts`);
  }
  const asked = formatMoney(intent.amount);
  if (amount.currency !== intent.amount.currency) {
    return result("fail", `${asked} asked for, capture is in ${amount.currency}`);
  }
  const leftMinor = amount.minor - refundedMinor;
  const left = formatMoney({ minor: leftMinor, currency: amount.currency });
  const fits = REFUNDABLE_STATUSES.has(capture.status) && intent.amount.minor <= leftMinor;
  return result(
    fits ? "pass" : "fail",
    `${asked} asked for, ${left} of ${formatMoney(amount)} left to refund, capture ${capture.status}`,
  );
}
