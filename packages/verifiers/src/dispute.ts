// dispute.none_open: no open PayPal dispute on the capture.

import type { Intent, TraceEntry } from "@countersign/mandate";
import { entryFor } from "./entry";
import { captureTargetOf, notACapture } from "./lookups";
import { CALLS, type RecordSnapshots, recordRefOr } from "./snapshots";

// The only dispute status that isn't open.
const RESOLVED = "RESOLVED";

// Only a lookup run for this capture counts. Every dispute in it is on the capture, so any that
// isn't RESOLVED is open.
export function disputeNoneOpen(intent: Intent, records: RecordSnapshots): TraceEntry {
  const target = captureTargetOf(intent);
  if (!target) return notACapture("dispute.none_open", intent);
  const { captureId } = target;
  const lookup = records.disputes?.find((record) => record.id === captureId);
  const entry = entryFor("dispute.none_open", [
    recordRefOr(lookup, { call: CALLS.disputes, id: captureId }),
  ]);
  if (!lookup) return entry("unknown", `No disputes lookup for capture ${captureId}`);
  const open = lookup.disputes.find((dispute) => dispute.status !== RESOLVED);
  return open
    ? entry("fail", `Dispute ${open.id} is ${open.status} on capture ${captureId}`)
    : entry("pass", `No open dispute on capture ${captureId}`);
}
