// A $18 refund on a $48 capture, with the records that back it.

import type { Intent } from "@countersign/mandate";
import type {
  CaptureSnapshot,
  DisputesSnapshot,
  ExecutionSnapshot,
  OrderSnapshot,
  ShipmentSnapshot,
  TicketSnapshot,
} from "../src/index";

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
  trackers: [{ id: "7YL89768KH2865638-KIK0042", trackingNumber: "KIK0042", status: "SHIPPED" }],
};

export const ticket: TicketSnapshot = {
  call: "ticket",
  id: "tkt_0042",
  senderEmail: "sb-87z5x@personal.example.com",
  attachments: [],
};

export const disputes: DisputesSnapshot = {
  call: "GET /v1/customer/disputes",
  id: "7YL89768KH2865638",
  disputes: [],
};

export const shipment: ShipmentSnapshot = {
  call: "carrier GET /shipments/{tracking_number}",
  id: "KIK0042",
  status: "stalled_10d",
};

// An earlier $25.00 refund by the same principal, on another capture.
export const execution: ExecutionSnapshot = {
  call: "audit log executions",
  id: "exe_0007",
  principal: "support-agent",
  captureId: "8YL89768KH2865639",
  amount: { minor: 2500, currency: "USD" },
  executedAt: "2026-10-17T06:40:00Z",
};
