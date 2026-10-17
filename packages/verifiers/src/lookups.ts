// Finding the intent's own records among the snapshots, with the reference the trace names.

import type { Intent, RecordRef } from "@countersign/mandate";
import {
  CALLS,
  type CaptureSnapshot,
  type OrderSnapshot,
  type RecordSnapshots,
  recordRef,
  recordRefOr,
  type TicketSnapshot,
} from "./snapshots";

export type OrderLookup =
  | { order: OrderSnapshot; ref: RecordRef }
  | { order: null; ref: RecordRef; missing: string };

// The capture's record, if the records hold it.
export function captureFor(captureId: string, records: RecordSnapshots): CaptureSnapshot | null {
  return records.captures?.find((record) => record.id === captureId) ?? null;
}

// The intent's order, as long as the capture's record says the money was captured on it.
// Otherwise, the reason it's missing.
export function orderFor(intent: Intent, records: RecordSnapshots): OrderLookup {
  const { captureId, orderId } = intent.target;
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

// The intent's ticket, if the records hold it, and its reference either way.
export function ticketFor(
  intent: Intent,
  records: RecordSnapshots,
): { ticket: TicketSnapshot | null; ref: RecordRef } {
  const ticket = records.ticket?.id === intent.ticketId ? records.ticket : null;
  return { ticket, ref: recordRefOr(ticket, { call: CALLS.ticket, id: intent.ticketId }) };
}
