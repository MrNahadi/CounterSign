// ticket.from_payer: the ticket came from the person who paid for the order.

import type { Intent, TraceEntry } from "@countersign/mandate";
import { CALLS, type RecordSnapshots, recordRef } from "./snapshots";

// Blank counts as missing, so two empty emails can never match.
function normalizeEmail(email: string | null): string | null {
  const trimmed = email?.trim().toLowerCase();
  return trimmed ? trimmed : null;
}

// The ticket's sender email is the order's payer email, ignoring case and outer spaces.
export function ticketFromPayer(intent: Intent, records: RecordSnapshots): TraceEntry {
  const { captureId, orderId } = intent.target;
  const order =
    orderId === null ? undefined : records.orders?.find((record) => record.id === orderId);
  const ticket = records.ticket?.id === intent.ticketId ? records.ticket : undefined;
  const recordsRead = [
    order ? recordRef(order) : { call: CALLS.order, id: orderId },
    ticket ? recordRef(ticket) : { call: CALLS.ticket, id: intent.ticketId },
  ];
  const result = (outcome: TraceEntry["result"], detail: string): TraceEntry => ({
    verifier: "ticket.from_payer",
    result: outcome,
    records: recordsRead,
    detail,
  });
  if (!order) {
    const missing =
      orderId === null ? "No order for this capture" : `No record of order ${orderId}`;
    return result("unknown", missing);
  }
  // The payer to check is the one on the order the money was captured for.
  const capture = records.captures?.find((record) => record.id === captureId);
  if (capture && capture.orderId !== order.id) {
    return result("unknown", `Capture ${captureId} isn't on order ${order.id}`);
  }
  if (!ticket) return result("unknown", `No record of ticket ${intent.ticketId}`);
  const payer = normalizeEmail(order.payerEmail);
  const sender = normalizeEmail(ticket.senderEmail);
  if (!payer) return result("unknown", `No payer email on order ${order.id}`);
  if (!sender) return result("unknown", `No sender email on ticket ${ticket.id}`);
  return result(sender === payer ? "pass" : "fail", `Sender ${sender}, payer ${payer}`);
}
