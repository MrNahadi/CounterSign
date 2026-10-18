// Finding the intent's own records among the snapshots, with the reference the trace names.

import {
  type CaptureTarget,
  describeTarget,
  type Intent,
  type RecordRef,
  type TraceEntry,
  type VerifierName,
} from "@countersign/mandate";
import { entryFor } from "./entry";
import {
  CALLS,
  type CaptureSnapshot,
  type DisputeRecordSnapshot,
  type InvoiceSnapshot,
  type OrderSnapshot,
  type RecordSnapshots,
  recordRef,
  recordRefOr,
  type TicketSnapshot,
} from "./snapshots";

export type OrderLookup =
  | { order: OrderSnapshot; ref: RecordRef }
  | { order: null; ref: RecordRef; missing: string };

// The intent's capture, for the verifiers that check one, or null when it targets something else.
export function captureTargetOf(intent: Intent): CaptureTarget | null {
  return intent.target.kind === "capture" ? intent.target : null;
}

// A capture-based verifier knows nothing about any other target (ADR 0027).
export function notACapture(verifier: VerifierName, intent: Intent): TraceEntry {
  return entryFor(verifier, [])(
    "unknown",
    `The target is ${describeTarget(intent.target)}, not a capture`,
  );
}

// The capture's record, if the records hold it.
export function captureFor(captureId: string, records: RecordSnapshots): CaptureSnapshot | null {
  return records.captures?.find((record) => record.id === captureId) ?? null;
}

// The dispute's own record, if the records hold it.
export function disputeRecordFor(
  disputeId: string,
  records: RecordSnapshots,
): DisputeRecordSnapshot | null {
  return records.disputeRecords?.find((record) => record.id === disputeId) ?? null;
}

// The invoice's record, if the records hold it.
export function invoiceFor(invoiceId: string, records: RecordSnapshots): InvoiceSnapshot | null {
  return records.invoices?.find((record) => record.id === invoiceId) ?? null;
}

// The order's record by its own ID, for an action that targets the order itself.
export function orderRecordFor(orderId: string, records: RecordSnapshots): OrderSnapshot | null {
  return records.orders?.find((record) => record.id === orderId) ?? null;
}

// The capture's order, as long as the capture's record says the money was captured on it.
// Otherwise, the reason it's missing.
export function orderFor(target: CaptureTarget, records: RecordSnapshots): OrderLookup {
  const { captureId, orderId } = target;
  const order =
    orderId === null ? undefined : records.orders?.find((record) => record.id === orderId);
  if (!order) {
    const missing =
      orderId === null ? "No order for this capture" : `No record of order ${orderId}`;
    return { order: null, ref: { call: CALLS.order, id: orderId }, missing };
  }
  const ref = recordRef(order);
  // Without the capture's record, nothing links the intent's order to its money.
  const capture = captureFor(captureId, records);
  if (!capture) return { order: null, ref, missing: `No record of capture ${captureId}` };
  if (capture.orderId !== order.id) {
    return { order: null, ref, missing: `Capture ${captureId} isn't on order ${order.id}` };
  }
  return { order, ref };
}

// The intent's ticket, if the records hold it, and its reference either way. Without a ticket ID
// there's nothing to find, so the reason it's missing says so.
export function ticketFor(
  intent: Intent,
  records: RecordSnapshots,
): { ticket: TicketSnapshot | null; ref: RecordRef; missing: string } {
  const { ticketId } = intent;
  const ticket = ticketId !== null && records.ticket?.id === ticketId ? records.ticket : null;
  const missing =
    ticketId === null ? "No ticket for this proposal" : `No record of ticket ${ticketId}`;
  return { ticket, ref: recordRefOr(ticket, { call: CALLS.ticket, id: ticketId }), missing };
}
