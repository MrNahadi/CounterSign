// dispute.none_open: no open PayPal dispute on the capture.

import type { Intent, TraceEntry } from "@countersign/mandate";
import { CALLS, type RecordSnapshots, recordRef } from "./snapshots";

// The only dispute status that isn't open.
const RESOLVED = "RESOLVED";

// Only a lookup run for this capture counts. Every dispute in it is on the capture, so any that
// isn't RESOLVED is open.
export function disputeNoneOpen(intent: Intent, records: RecordSnapshots): TraceEntry {
  const { captureId } = intent.target;
  const lookup = records.disputes?.find((record) => record.id === captureId);
  const result = (outcome: TraceEntry["result"], detail: string): TraceEntry => ({
    verifier: "dispute.none_open",
    result: outcome,
    records: [lookup ? recordRef(lookup) : { call: CALLS.disputes, id: captureId }],
    detail,
  });
  if (!lookup) return result("unknown", `No disputes lookup for capture ${captureId}`);
  const open = lookup.disputes.find((dispute) => dispute.status !== RESOLVED);
  return open
    ? result("fail", `Dispute ${open.id} is ${open.status} on capture ${captureId}`)
    : result("pass", `No open dispute on capture ${captureId}`);
}
