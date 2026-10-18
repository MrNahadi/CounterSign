// Record snapshots: the fields a verifier needs from a record, plus the call it came from and
// its record ID (ADR 0019). Phase 6 maps raw PayPal responses into these.

import type { Money, RecordRef, ShipmentStatus } from "@countersign/mandate";

// The calls each kind of record comes from. A verifier names the call even when the record is
// missing, so the trace shows what was looked for.
export const CALLS = {
  capture: "GET /v2/payments/captures/{id}",
  order: "GET /v2/checkout/orders/{id}",
  disputes: "GET /v1/customer/disputes",
  dispute: "GET /v1/customer/disputes/{id}",
  invoice: "GET /v2/invoicing/invoices/{id}",
  carrier: "carrier GET /shipments/{tracking_number}",
  ticket: "ticket",
  executions: "audit log executions",
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

// One of the order's `purchase_units[].shipping.trackers`. Its ID is the capture ID, a hyphen
// and the tracking number (spike S2), which ties the tracker to its capture.
export type TrackerSnapshot = {
  id: string;
  trackingNumber: string;
  // PayPal's tracker status: SHIPPED or CANCELLED. Delivery comes from the carrier.
  status: string;
};

// An amount as a record states it, with PayPal's currency code unchecked, so the gate can deny an
// unsupported currency by name.
export type RecordAmount = { minor: number; currency: string };

export type OrderSnapshot = SnapshotSource & {
  // `payer.email_address`. Card orders may lack it.
  payerEmail: string | null;
  trackers: readonly TrackerSnapshot[];
  // Each purchase unit's amount, in order, for capturing the order (ADR 0027). Absent when it
  // wasn't read, which leaves the order's amount unknown.
  amounts?: readonly RecordAmount[];
};

export type DisputeSnapshot = {
  id: string;
  // PayPal's dispute status. Anything but RESOLVED is open.
  status: string;
};

// One disputes lookup, filtered by `disputed_transaction_id`, so every dispute in it is on that
// transaction. Its ID is the transaction it was run for, so a lookup for another capture proves
// nothing about this one.
export type DisputesSnapshot = SnapshotSource & {
  disputes: readonly DisputeSnapshot[];
};

// One dispute's own record, read by its ID, for the actions that target it (ADR 0027).
export type DisputeRecordSnapshot = SnapshotSource & {
  // PayPal's dispute status, such as WAITING_FOR_SELLER_RESPONSE.
  status: string;
  amount: RecordAmount;
};

// One invoice's record, read by its ID, for sending it (ADR 0027).
export type InvoiceSnapshot = SnapshotSource & {
  // PayPal's invoice status, such as DRAFT.
  status: string;
  amount: RecordAmount;
};

// The carrier's record for one tracking number, which is its ID.
export type ShipmentSnapshot = SnapshotSource & {
  status: ShipmentStatus;
};

export type AttachmentSnapshot = {
  id: string;
  // The MIME type, such as image/jpeg.
  contentType: string;
};

export type TicketSnapshot = SnapshotSource & {
  // Null when the ticket didn't come by email.
  senderEmail: string | null;
  attachments: readonly AttachmentSnapshot[];
};

// One executed money action from the audit log. Its ID is the execution's.
export type ExecutionSnapshot = SnapshotSource & {
  principal: string;
  // The capture it refunded. Null for an action with no capture, such as a payout.
  captureId: string | null;
  amount: Money;
  // When it executed, as an ISO 8601 timestamp with an offset, such as 2026-10-17T09:12:00Z.
  executedAt: string;
};

// Everything the verifiers may read for one intent. A missing record is never a pass.
export type RecordSnapshots = {
  captures?: readonly CaptureSnapshot[];
  orders?: readonly OrderSnapshot[];
  disputes?: readonly DisputesSnapshot[];
  disputeRecords?: readonly DisputeRecordSnapshot[];
  invoices?: readonly InvoiceSnapshot[];
  shipments?: readonly ShipmentSnapshot[];
  ticket?: TicketSnapshot;
  // The whole execution history, for every principal and every day: ledger.not_duplicate passes
  // on anything left out. Absent means it wasn't read, so nothing about it is known; an empty
  // list means nothing has executed.
  executions?: readonly ExecutionSnapshot[];
};

// The trace's reference to a snapshot that was read.
export function recordRef(snapshot: SnapshotSource): RecordRef {
  return { call: snapshot.call, id: snapshot.id };
}

// The trace's reference to the snapshot a verifier read or, when it's missing, to the call and ID
// it looked for, so an unknown result still names the record that wasn't there.
export function recordRefOr(
  snapshot: SnapshotSource | null | undefined,
  sought: RecordRef,
): RecordRef {
  return snapshot ? recordRef(snapshot) : sought;
}
