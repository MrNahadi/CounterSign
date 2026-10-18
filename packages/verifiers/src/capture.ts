// capture.refundable: the capture can still be refunded for the intent's amount.

import { formatMoney, type Intent, isMinorUnits, type TraceEntry } from "@countersign/mandate";
import { entryFor } from "./entry";
import { captureFor, captureTargetOf, notACapture } from "./lookups";
import { CALLS, type RecordSnapshots, recordRefOr } from "./snapshots";

const REFUNDABLE_STATUSES = new Set(["COMPLETED", "PARTIALLY_REFUNDED"]);

// The right status and currency, and no more than captured minus already refunded.
export function captureRefundable(intent: Intent, records: RecordSnapshots): TraceEntry {
  const target = captureTargetOf(intent);
  if (!target) return notACapture("capture.refundable", intent);
  const { captureId } = target;
  const capture = captureFor(captureId, records);
  const entry = entryFor("capture.refundable", [
    recordRefOr(capture, { call: CALLS.capture, id: captureId }),
  ]);
  if (!capture) return entry("unknown", `No record of capture ${captureId}`);
  const { amount, refundedMinor } = capture;
  // A record we can't do arithmetic on proves nothing.
  if (!isMinorUnits(amount.minor) || !isMinorUnits(refundedMinor) || refundedMinor > amount.minor) {
    return entry("unknown", `The record of capture ${captureId} has malformed amounts`);
  }
  const asked = formatMoney(intent.amount);
  if (amount.currency !== intent.amount.currency) {
    return entry("fail", `${asked} asked for, capture is in ${amount.currency}`);
  }
  const leftMinor = amount.minor - refundedMinor;
  const left = formatMoney({ minor: leftMinor, currency: amount.currency });
  const fits = REFUNDABLE_STATUSES.has(capture.status) && intent.amount.minor <= leftMinor;
  return entry(
    fits ? "pass" : "fail",
    `${asked} asked for, ${left} of ${formatMoney(amount)} left to refund, capture ${capture.status}`,
  );
}
