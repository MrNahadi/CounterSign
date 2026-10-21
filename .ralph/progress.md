# Progress: phase 9, phone step-up approvals (specs/features/09-phone-step-up-approvals)

## T-001 done
- `approval` added to `ENTRY_TYPES`; `apps/gate/src/approval-log.ts` holds `ApprovalPayloadSchema`, `approvalEntry` and the step-up reader (`readStepUps(reader, now)`, `readStepUp(reader, seq, now)`, unknown on any unreadable decision or approval entry).
- Gotcha: ledger tests used `approval` as their example unknown type; they now use `payout.batch`.
- Gotcha: the reader parses every `decision` entry (needs `record.decision` and `record.intentId`, ref must equal the intent ID), so hand-written decision payloads like `{ note }` make it unknown. An approval whose `stepUpSeq` is not an earlier step-up of its ref intent is unreadable too.
- `StepUp` has no execution info yet; T-006/T-012 add the execution outcome and PayPal record for recent ones.
