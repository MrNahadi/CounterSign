// Running the verifiers for an intent into its verifier trace.

import type { Intent, TraceEntry, VerifierName, VerifierTrace } from "@countersign/mandate";
import { captureRefundable } from "./capture";
import { disputeNoneOpen } from "./dispute";
import { entryFor } from "./entry";
import { ledgerNotDuplicate } from "./ledger";
import { payeeAllowlisted } from "./payee";
import { shipmentStatus } from "./shipment";
import type { RecordSnapshots } from "./snapshots";
import { evidencePhotoPresent, ticketFromPayer } from "./ticket";

type Verifier = (intent: Intent, records: RecordSnapshots) => TraceEntry;

const BUILT_VERIFIERS: Partial<Record<VerifierName, Verifier>> = {
  "capture.refundable": captureRefundable,
  "ticket.from_payer": ticketFromPayer,
  "dispute.none_open": disputeNoneOpen,
  "shipment.status": shipmentStatus,
  "evidence.photo_present": evidencePhotoPresent,
  "ledger.not_duplicate": ledgerNotDuplicate,
  "payee.allowlisted": payeeAllowlisted,
};

// Every verifier that runs for a refund, whatever the rules need, so the trace is complete.
export const REFUND_VERIFIERS = [
  "capture.refundable",
  "ticket.from_payer",
  "dispute.none_open",
  "shipment.status",
  "evidence.photo_present",
  "ledger.not_duplicate",
] as const satisfies readonly VerifierName[];

// A verifier named in the schema but not built yet is unknown, so a rule that requires it
// denies until its phase builds it (ADR 0019).
function notBuilt(verifier: VerifierName): TraceEntry {
  return entryFor(verifier, [])("unknown", "Countersign can't check this yet");
}

// Runs the intent's verifiers over the record snapshots, plus the ones the mandate's rules
// require. Each verifier runs once, in a stable order.
export function runVerifiers(
  intent: Intent,
  records: RecordSnapshots,
  requiredVerifiers: readonly VerifierName[] = [],
): VerifierTrace {
  const names = new Set<VerifierName>(intent.action === "paypal.refund" ? REFUND_VERIFIERS : []);
  for (const name of requiredVerifiers) names.add(name);
  return [...names].map((name) => BUILT_VERIFIERS[name]?.(intent, records) ?? notBuilt(name));
}
