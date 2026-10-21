# Progress: phase 9, phone step-up approvals (specs/features/09-phone-step-up-approvals)

## T-001 done
- `approval` added to `ENTRY_TYPES`; `apps/gate/src/approval-log.ts` holds `ApprovalPayloadSchema`, `approvalEntry` and the step-up reader (`readStepUps(reader, now)`, `readStepUp(reader, seq, now)`, unknown on any unreadable decision or approval entry).
- Gotcha: ledger tests used `approval` as their example unknown type; they now use `payout.batch`.
- Gotcha: the reader parses every `decision` entry (needs `record.decision` and `record.intentId`, ref must equal the intent ID), so hand-written decision payloads like `{ note }` make it unknown. An approval whose `stepUpSeq` is not an earlier step-up of its ref intent is unreadable too.
- `StepUp` has no execution info yet; T-006/T-012 add the execution outcome and PayPal record for recent ones.

## T-002 done
- `execution-log.ts`: `execution.requested` has a third shape (`replay: false`, `approvalSeq`) and an optional hashed `target` (`requestTarget(intent.target)`); `execution.result` has an executed `invoice: { id, status: SENT|SCHEDULED }` variant. Both schemas are now `z.union`, not discriminated unions. `IntentRecord.executed` is `ExecutedRecord` (`{ seq, refund }` or `{ seq, invoice }`). Fixture of a phase 8 log: `apps/gate/test/fixtures/phase8-execution-log.ts`.
- Gotcha: the writer takes `target` instead of `captureId` (capture derived from it) and requires it. `requestId` is null for `paypal.invoice.send` (no PayPal-Request-Id, ADR 0033) and the intent hash for every other action; the schema enforces both, and that the capture matches the target.
- Gotcha: an invoice request with no result yet shows in `readReconcileWork().open` (the reconcile CLI lists it as a request with no outcome, capture "none"). Left as is: it's the fail-closed side.
