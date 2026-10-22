// The records the gate decides on: the verifiers' snapshots plus what only the gate's own
// normalization reads. Types only, with no database code, so the decision path stays pure.

import type { RecordSnapshots } from "@countersign/verifiers";

// The read that lists a proposal's evidence documents, for problems and snapshots.
export const EVIDENCE_DOCUMENTS_CALL = "evidence-documents";

// One stored evidence document an evidence submission names (ADR 0035), without its bytes. Its
// SHA-256 is worked out from the bytes as read, never taken from the row.
export type EvidenceDocumentSnapshot = {
  call: typeof EVIDENCE_DOCUMENTS_CALL;
  id: string;
  disputeId: string;
  name: string;
  contentType: string;
  sha256: string;
};

// The verifiers' snapshots plus what only the gate's normalization reads: the evidence documents
// a proposal names. Absent when the store couldn't be read, so they're unknown; a document
// that isn't stored is simply not in the list.
export type GateRecords = RecordSnapshots & {
  evidenceDocuments?: readonly EvidenceDocumentSnapshot[];
};
