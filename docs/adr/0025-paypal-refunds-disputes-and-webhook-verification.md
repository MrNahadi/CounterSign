# 0025. The PayPal rail client refunds with the intent hash as request ID, derives refunded amounts from the order, lists disputes by capture, and verifies webhooks against the raw body

Status: accepted
Decided-by: autopilot planner, phase 6 feature spec, 18 Oct 2026 (researched; a technical question inside the answerer's remit. The planner session couldn't reach the answerer agent, so it followed the answerer's rules itself)
Question: Phase 6 decides refunds on live sandbox records and executes them. Which PayPal calls does `@countersign/rail-paypal` add, how does a capture's refunded total reach `capture.refundable`, how is the dispute check read, and how are webhooks checked?
Decision:
- **Refund:** `POST /v2/payments/captures/{id}/refund` with the amount, `custom_id` set to the intent ID, and `PayPal-Request-Id` set to the intent hash (ADR 0003, spikes S1 and S5). The record is the refund's ID, status (`COMPLETED`, `PENDING`, `FAILED`, `CANCELLED`), amount and capture ID (from its `up` link). Only USD is sent.
- **Get refund:** `GET /v2/payments/refunds/{id}`, same record. Reconciliation always re-reads the refund this way and never trusts a webhook body's fields.
- **Refunded total:** a capture read on its own carries no refund total, so the order's `purchase_units[].payments.refunds[]` is parsed too. A refund counts against the capture its `up` link names. In a purchase unit with one capture, a refund with no readable link counts against that capture; with several captures, an unattributable refund makes the refunded total unknown, and the gate leaves the capture snapshot out, so `capture.refundable` is unknown. `PENDING` refunds count as refunded; `FAILED` and `CANCELLED` don't.
- **Disputes:** `GET /v1/customer/disputes?disputed_transaction_id={capture}`, following `next` links up to 5 pages. A lookup that didn't finish is not a lookup: the gate leaves the disputes snapshot out, so `dispute.none_open` is unknown.
- **Webhook signature:** `POST /v1/notifications/verify-webhook-signature` with the five `PAYPAL-*` transmission headers, `PAYPAL_WEBHOOK_ID`, and the event spliced in as the exact raw body text, never re-serialized, because re-serializing changes the bytes PayPal signed. Only `verification_status: SUCCESS` passes. The call is never retried; if it can't run, the gate answers 503 so PayPal redelivers.
Basis:
- PayPal Payments v2 reference (refund a captured payment, show refund details): https://developer.paypal.com/docs/api/payments/v2/
- PayPal Customer Disputes v1 schema, list disputes query parameters including `disputed_transaction_id`, `page_size` and HATEOAS next links: https://developer.paypal.com/api/customer-disputes/v1/schema.yaml
- PayPal Webhooks v1, verify webhook signature: https://developer.paypal.com/docs/api/webhooks/v1/#verify-webhook-signature
- `docs/spikes.md` S1 (replaying a refund's request ID returns the same refund, and the capture turns `PARTIALLY_REFUNDED`) and S5 (intent hash as request ID).
- Original brief §12 security controls ("PayPal webhooks are checked with `POST /v1/notifications/verify-webhook-signature`").
Consequences:
- A new variable, `PAYPAL_WEBHOOK_ID`, exists only once the sandbox app has a webhook on a public URL (phase 13). Until then the webhook route is tested against fixtures and a fake verifier, and reconciliation can also run by polling (`npm run reconcile`).
- The payload shape of a live `PAYMENT.CAPTURE.REFUNDED` event is confirmed in phase 6's live checks. Because the handler re-reads the refund by the resource's ID, a resource that isn't a refund just fails to match.
