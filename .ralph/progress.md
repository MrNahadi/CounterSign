# Progress: phase 7, the gate over MCP (specs/features/07-gate-over-mcp)

## T-001 (done)
- `IntentTarget` is now a union with a `kind` discriminant (`capture`, `dispute`, `invoice`, `order`, `payee`); `Intent.ticketId` is `string | null`; optional `Intent.params` (`IntentParams`) holds hashed parameters, with fixed keys per action in `HASHED_PARAMS` (refund `null` = no `params` key, so refund canonical JSON is unchanged). `describeTarget()` and `normalizePayeeEmail()` exported from `@countersign/mandate`.
- Gotcha: hashed target omits `kind` (`{ captureId }`, `{ disputeId }`, `{ invoiceId }`, `{ orderId }`, `{ email }`); params keys are camelCase (`offerType`, `sendToRecipient`, `additionalRecipients`, evidence items `{ evidenceType, notes, trackingNumbers }`). Normalizers (T-003/T-004) must map snake_case MCP args into these.
- Verifiers: `captureTargetOf`/`notACapture` in `packages/verifiers/src/lookups.ts`; `orderFor` now takes a `CaptureTarget`; `ticketFor` returns a `missing` reason ("No ticket for this proposal" when `ticketId` is null).
- `propose.ts` throws if an allowed decision targets a non-capture; T-004's `ACTION_UNAVAILABLE` makes that unreachable.
