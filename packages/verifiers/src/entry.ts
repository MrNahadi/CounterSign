// Building a verifier's trace entry.

import type {
  RecordRef,
  ShipmentStatus,
  TraceEntry,
  VerifierName,
  VerifierResult,
} from "@countersign/mandate";

// One verifier's trace entries over the records it read. A verifier may add records to the list
// as it reads them. Each entry takes a copy of the list as it stands, so a later addition never
// changes an entry already made.
export function entryFor(verifier: VerifierName, records: RecordRef[]) {
  return (result: VerifierResult, detail: string, value?: ShipmentStatus): TraceEntry => ({
    verifier,
    result,
    records: [...records],
    detail,
    ...(value ? { value } : {}),
  });
}
