# Progress: phase 6, a refund executes once, live (specs/features/06-refund-executes-once)

## T-001 (done)
- `@countersign/rail-paypal` gains `refundCapture({ captureId, amount, customId, requestId })` (call `refund-capture`), `getRefund(id)` (call `get-refund`), `PayPalRefund` records (status is the enum `REFUND_STATUSES`; capture ID from the `up` link, else null), `refunds` on every purchase unit, and `refundedTotal(order, captureId): number | null`.
- Gotcha: `refundedTotal` returns null (unknown) when the capture isn't on the order, a counted refund's currency differs, or an unattributable counted refund sits in a multi-capture unit. T-004 should leave the capture snapshot out on null.
- Gotcha: an order refund with an unknown status makes the whole order unreadable (`invalid_response`), which is fail closed. Fixtures: `refund-capture-completed`, `get-refund-pending`, `get-order-refunded`, `error-422-capture-fully-refunded`.

## T-002 (done)
- `@countersign/rail-paypal` gains `listDisputes(captureId)` (call `list-disputes`, returns `{ disputes: { id, status }[], complete }`), `verifyWebhookSignature({ webhookId, transmission: { transmissionId, transmissionTime, certUrl, authAlgo, transmissionSig }, rawBody })` (call `verify-webhook-signature`, returns `"pass" | "fail"`), and `parsePayPalWebhookId(env)` (`{ ok, webhookId }` or `{ ok: false, missing, problems }`).
- Gotcha: disputes next links are followed only to `/v1/customer/disputes` on a sandbox host (`api-m.sandbox` or `api.sandbox`); anything else is `invalid_response`. After 5 pages with a next link, `complete: false` (T-004 leaves the disputes snapshot out).
- Gotcha: verification refuses a `rawBody` that isn't a JSON object as `invalid_request` before any call (the gate should answer 400 for that, not 503). It has no request ID, so it's never retried on 5xx; a 401 still triggers the one token refresh. Fixtures: `list-disputes-page-1`/`-2`, `verify-webhook-signature-success`/`-failure`.
