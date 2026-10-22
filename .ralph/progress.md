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

## T-006 done
- `approver.ts` (`loadApprover(env)`, `approverLines`), `approval-cards.ts` (`cardView` pure builder, `buildCard`, `readApprovals`; snake_case JSON, `ACTION_WORDS`, `CANNOT_EXECUTE`), `approvals-api.ts` (`mountApprovals`, `APPROVAL_MESSAGES`), mounted in `createApp`. `Principals` gained `mandates` so cards narrow checks to the matched rules' `require` (plus `shipment.status` when a matched rule's `when` tests it); a step-up whose mandate hash isn't loaded shows the whole trace. Tests: `apps/gate/test/approvals-api.test.ts`.
- API answers: bad ID -> 404, bad/oversized body -> 400 (never 413), no db / unreadable log / recording failure -> 503. A POST approve with no PayPal rail -> 503 before anything is written; a deny works without the rail (a throwing `NO_RAIL` proxy). Answered POST body: `{ outcome, code, step_up_id, intent_id, approval_seq, execution: { outcome, refund, invoice, error: { name, issues } } | null }`.
- Recent summaries: `outcome` approved|denied|expired, `at`, `channel`, and for approved `execution.outcome` executed|failed|unknown|pending with refund/invoice records.
- Gotcha: createApp now logs an approver-key line whenever the key is unset; tests counting startup lines must set `COUNTERSIGN_APPROVER_KEY` (mcp.test did).

### For the human
- T-006: `.env.example` couldn't be read in this loop (permission denied); add `COUNTERSIGN_APPROVER_KEY` to it if it isn't there.

## T-007 done
- `apps/gate/src/approvals-cli.ts` (`runApprovals(args, env, deps)`; deps: `rail`, `fetch`, `now`, `mandates`) and `approvals-main.ts`; root `approvals` script. Tests: `apps/gate/test/approvals-cli.test.ts`.
- Gotcha: `deny` takes no hash, so the CLI reads the step-up and sends its own stored hash. An approval with an `unknown` or missing execution result exits 1 ("PayPal hasn't confirmed it yet"). PayPal variables are only required for `approve`; `list`, `show` and `deny` run without them.
- Gotcha: test step-ups need a ticket with an image attachment, or beat 5 is denied rather than stepped up. Order numbers show only when `seed_orders` has the order (not seeded in these tests).

## T-008 done
- `apps/gate/test/step-up-mcp.test.ts`: one real gate (MCP client, approval API, webhook) with a mutable clock; beat 5 held 15 min, approved once (second tap ALREADY_ANSWERED), webhook reconciles, `verifyLog` intact; $241.00 hash (built with `hashIntent`, checked equal to the card's at $240.00) rejected HASH_MISMATCH; past expiry rejected EXPIRED and listed as expired in `recent`. Test-only: no source change was needed.
- Gotcha: the `pending_approval` agent response carries no `intent_hash`; the approver gets it from the card. The webhook route needs `PAYPAL_WEBHOOK_ID` in the gate's env.
