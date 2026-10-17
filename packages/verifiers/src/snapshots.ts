// Record snapshots: the fields a verifier needs from a record, plus the call it came from and
// its record ID (ADR 0019). Phase 6 maps raw PayPal responses into these.

import type { Money, RecordRef } from "@countersign/mandate";

// The calls each kind of record comes from. A verifier names the call even when the record is
// missing, so the trace shows what was looked for.
export const CALLS = {
  capture: "GET /v2/payments/captures/{id}",
  order: "GET /v2/checkout/orders/{id}",
  ticket: "ticket",
} as const;

// Where a snapshot came from.
export type SnapshotSource = { call: string; id: string };

export type CaptureSnapshot = SnapshotSource & {
  // The order the capture belongs to. The intent's order ID comes from here.
  orderId: string | null;
  // PayPal's capture status, such as COMPLETED or PARTIALLY_REFUNDED.
  status: string;
  amount: Money;
  // The total already refunded from this capture, in the capture's currency.
  refundedMinor: number;
};

export type OrderSnapshot = SnapshotSource & {
  // `payer.email_address`. Card orders may lack it.
  payerEmail: string | null;
};

export type TicketSnapshot = SnapshotSource & {
  // Null when the ticket didn't come by email.
  senderEmail: string | null;
};

// Everything the verifiers may read for one intent. A missing record is never a pass.
export type RecordSnapshots = {
  captures?: readonly CaptureSnapshot[];
  orders?: readonly OrderSnapshot[];
  ticket?: TicketSnapshot;
};

// The trace's reference to a snapshot that was read.
export function recordRef(snapshot: SnapshotSource): RecordRef {
  return { call: snapshot.call, id: snapshot.id };
}
