// A $18 refund on a $48 capture, with the records that back it.

import type { Intent } from "@countersign/mandate";
import type { CaptureSnapshot, OrderSnapshot, TicketSnapshot } from "../src/index";

export const intent: Intent = {
  principal: "support-agent",
  rail: "paypal",
  action: "paypal.refund",
  amount: { minor: 1800, currency: "USD" },
  target: { captureId: "7YL89768KH2865638", orderId: "5O190127TN364715T" },
  ticketId: "tkt_0042",
  claim: "not_received",
  mandateVersion: 3,
};

export const capture: CaptureSnapshot = {
  call: "GET /v2/payments/captures/{id}",
  id: "7YL89768KH2865638",
  orderId: "5O190127TN364715T",
  status: "COMPLETED",
  amount: { minor: 4800, currency: "USD" },
  refundedMinor: 0,
};

export const order: OrderSnapshot = {
  call: "GET /v2/checkout/orders/{id}",
  id: "5O190127TN364715T",
  payerEmail: "sb-87z5x@personal.example.com",
};

export const ticket: TicketSnapshot = {
  call: "ticket",
  id: "tkt_0042",
  senderEmail: "sb-87z5x@personal.example.com",
};
