# Progress: phase 6, a refund executes once, live (specs/features/06-refund-executes-once)

## T-001 (done)
- `@countersign/rail-paypal` gains `refundCapture({ captureId, amount, customId, requestId })` (call `refund-capture`), `getRefund(id)` (call `get-refund`), `PayPalRefund` records (status is the enum `REFUND_STATUSES`; capture ID from the `up` link, else null), `refunds` on every purchase unit, and `refundedTotal(order, captureId): number | null`.
- Gotcha: `refundedTotal` returns null (unknown) when the capture isn't on the order, a counted refund's currency differs, or an unattributable counted refund sits in a multi-capture unit. T-004 should leave the capture snapshot out on null.
- Gotcha: an order refund with an unknown status makes the whole order unreadable (`invalid_response`), which is fail closed. Fixtures: `refund-capture-completed`, `get-refund-pending`, `get-order-refunded`, `error-422-capture-fully-refunded`.
