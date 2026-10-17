// The verifier trace: each verifier run for an intent, its result and the records it read.

import type { VerifierName } from "./mandate";

export const VERIFIER_RESULTS = ["pass", "fail", "unknown"] as const;
export type VerifierResult = (typeof VERIFIER_RESULTS)[number];

// A record a verifier read: the call it came from, such as `GET /v2/payments/captures/{id}`,
// and that record's ID. The ID is null when there was no ID to look the record up by.
export type RecordRef = { call: string; id: string | null };

export type TraceEntry = {
  verifier: VerifierName;
  result: VerifierResult;
  // Named even when the record is missing, so the trace shows what was looked for.
  records: RecordRef[];
  // What the records showed, in words. Never a credential or a full token.
  detail: string;
};

export type VerifierTrace = readonly TraceEntry[];
