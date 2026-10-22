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

## T-003 done
- `sendInvoice` (200 -> `SENT`, 202 -> `SCHEDULED`, other 2xx throws `invalid_response`; no request ID, never retried) and `createDraftInvoice` (returns the invoice ID from an `id` or an `href`) in `@countersign/rail-paypal`; tests in `packages/rail-paypal/test/invoice-send.test.ts`.
- Gotcha: `apps/gate/test/fake-sandbox.ts` got minimal `sendInvoice`/`createDraftInvoice` (records calls, `invoiceSendStatus`, `failures`) only to satisfy the `PayPalClient` type. T-004 must extend it (4xx, network failure, recording the request) as the requirements say.
- The one lint warning (`apps/resolve-agent/src/queue.ts` void type) predates this ticket.

## T-004 done
- `apps/gate/src/executors.ts`: `EXECUTORS` (refund, invoice send), `execute(rail, db, job, clock)` runs one `ExecutionJob` and appends `execution.result`; `Execution`/`RailRefusal` moved there (re-exported from `propose.ts`). `Execution.invoice` is optional (absent for refunds) so existing `toEqual` tests pass unchanged. `EXECUTABLE_ACTIONS` is a const tuple with `ExecutableAction`; `isExecutable` is a type guard. T-005 should build an `ExecutionJob` from the stored intent and call `execute`.
- Invoice send: absent `sendToRecipient` is sent as `true` (PayPal's default); an empty recipients list is left out. 4xx or invalid_request -> failed, anything else -> unknown.
- A re-proposed allowed invoice intent is decided again (decision entry written, allow) but gets no second `execution.requested`; `execution` reports the trail with `sent: false` (unreadable trail -> unknown, not sent). Decided without the answerer (no Agent tool in this run); see "For the human".
- Fake sandbox: `invoiceSendAnswer` / `invoiceSendAnswers` queue (`"SENT" | "SCHEDULED" | { status, name?, issues? } | "network"`) and an `invoiceSends` log; `invoiceSendStatus` is gone.
- Tests: `apps/gate/test/propose-invoice.test.ts` (mandate = shipped v3 with invoice send and accept-claim allowed).

### For the human
- T-004: no reason code covers "this invoice intent was already sent", so a re-proposed allowed invoice intent answers `allowed` again with no second send (ADR 0033 says "decided again but can't execute"). Revisit if the agent should get a deny instead. Only reachable under a mandate that allows invoice sends outright (the shipped one steps them up).

## T-005 done
- `apps/gate/src/answer-step-up.ts`: `answerStepUp({ db, rail, stepUpSeq, answer, intentHash, channel, now, clock? })` returns `{ kind: "answered", outcome, code, stepUpSeq, intentId, approvalSeq, requestSeq, execution }` or `not_found` / `input_error` / `unknown` (step-up log unreadable, nothing written) / `recording_failed`. `answer` and `intentHash` are `unknown` and zod-read; a malformed hash is an input error (the approval schema can't store it). Tests: `apps/gate/test/answer-step-up.test.ts`.
- HASH_MISMATCH also checks `hashIntent(stored intent)` hash and ID. An unreadable intent trail rejects ALREADY_REQUESTED (counts as requested). The approved refund's later replay through `propose()` already works (first request carries `target`).
- Gotcha: in tests, a "changed amount" refund on CAP-1037 must stay within the $240 capture ($230 works); $250 is denied, not stepped up. A $30 refund on CAP-1037 is allowed and executes.
