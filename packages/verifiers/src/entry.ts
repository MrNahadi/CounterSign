// Building a verifier's trace entry.

import type {
  RecordRef,
  ShipmentStatus,
  TraceEntry,
  VerifierName,
  VerifierResult,
} from "@countersign/mandate";

// One verifier's trace entries over the records it read. The list is shared, not copied, so a
// verifier may add the records it reads as it goes.
export function entryFor(verifier: VerifierName, records: RecordRef[]) {
  return (result: VerifierResult, detail: string, value?: ShipmentStatus): TraceEntry => ({
    verifier,
    result,
    records,
    detail,
    ...(value ? { value } : {}),
  });
}
