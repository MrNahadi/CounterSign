# Progress: phase 7, the gate over MCP (specs/features/07-gate-over-mcp)

## T-001 (done)
- `IntentTarget` is now a union with a `kind` discriminant (`capture`, `dispute`, `invoice`, `order`, `payee`); `Intent.ticketId` is `string | null`; optional `Intent.params` (`IntentParams`) holds hashed parameters, with fixed keys per action in `HASHED_PARAMS` (refund `null` = no `params` key, so refund canonical JSON is unchanged). `describeTarget()` and `normalizePayeeEmail()` exported from `@countersign/mandate`.
- Gotcha: hashed target omits `kind` (`{ captureId }`, `{ disputeId }`, `{ invoiceId }`, `{ orderId }`, `{ email }`); params keys are camelCase (`offerType`, `sendToRecipient`, `additionalRecipients`, evidence items `{ evidenceType, notes, trackingNumbers }`). Normalizers (T-003/T-004) must map snake_case MCP args into these.
- Verifiers: `captureTargetOf`/`notACapture` in `packages/verifiers/src/lookups.ts`; `orderFor` now takes a `CaptureTarget`; `ticketFor` returns a `missing` reason ("No ticket for this proposal" when `ticketId` is null).
- `propose.ts` throws if an allowed decision targets a non-capture; T-004's `ACTION_UNAVAILABLE` makes that unreachable.

## T-002 (done)
- `@countersign/rail-paypal` gains `getDispute` (`PayPalDisputeDetail`: id, status, amount, `captureIds` from `disputed_transactions[].seller_transaction_id`), `getInvoice` (`PayPalInvoice`: id, status, amount, `invoiceNumber` or null, `recipientEmails` primary then additional) and `searchTransactions({ startDate, endDate, transactionId? })` (`PayPalTransactionPage`: `transactions`, `complete`). Tests in `packages/rail-paypal/test/reads.test.ts`, fixtures `get-dispute`, `get-invoice`, `search-transactions`, `error-403-not-authorized`.
- Gotcha: a transaction's `amount` is unsigned Money plus `direction: "credit" | "debit"` (PayPal sends money out as a negative value), and `initiatedAt` is normalized ISO UTC. Search always sends `fields=transaction_info&page_size=100&page=1`; the client has no default range, so T-009 must compute "the last 31 days" from the injected clock. Dates accept an ISO date-time with offset or a plain date.
- The gate's fake sandbox (`apps/gate/test/fake-sandbox.ts`) gained `disputeDetails`, `invoices` and `transactions`.

## T-003 (done)
- Dispute tools normalize in `apps/gate/src/proposal.ts` (per-tool zod schemas in `PROPOSALS`, `EVIDENCE_TYPES`, `OFFER_TYPES`); non-refund `justification` is optional with optional `ticket_id`. `create_refund` accepts and ignores `invoice_id`. Reason codes `TARGET_UNKNOWN` and `ACTION_UNAVAILABLE` added. Verifiers gain `DisputeRecordSnapshot` (`RecordSnapshots.disputeRecords`, `CALLS.dispute`, `disputeRecordFor`); its amount currency is an unchecked string so the gate can deny an unsupported currency by name. Fixture case `dispute-actions.json`.
- Gotcha: the "reaches every reason code" test in `apps/gate/test/decide.test.ts` now pins `["ACTION_UNAVAILABLE"]` as the only unreached code (25 total); T-004 must flip it back to `[]` once its fixture mandate reaches it. `proposal.test.ts` still uses `create_payout` as an unknown tool; T-004 must replace it.
- Add new tools by extending `TOOLS`, `PROPOSALS` and the `normalizeArgs` switch; helpers `invalid`/`targetUnknown` return `Denial`.
