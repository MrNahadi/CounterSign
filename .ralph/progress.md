# Progress: phase 12, ops-agent supplier payouts (specs/features/12-ops-agent-payouts)

## T-001 (done)

- Mandate gains optional `payees` (zod, max 100, lower-cased trimmed unique emails); `kikapu-studio-ops-v1.json`; `PAYEE_LIST_UNKNOWN`; `payee.allowlisted` unknown maps to it; payout `reference` hashed only when set (`HASHED_WHEN_SET`). Gate case `payee-list-missing.json` under test mandate `apps/gate/fixtures/mandates/payout-no-payee-list.json` reaches it; reason-code count 26.
- Gotcha (ADR 0040): `PAYEE_NOT_ALLOWLISTED` was moved to T-004, because the gate's "reaches every reason code" test needs a decision case that reaches every code. A reason code joins the catalog in the ticket whose decision case first reaches it. Until T-004, a `payee.allowlisted` fail denies `VERIFIER_UNAVAILABLE` (`REQUIREMENT_CODES` entries may now leave out `fail` or `unknown`).
- Gotcha: `create_payout` rejects a `reference` arg until T-004, so `payee-list-missing.json`'s payout has none. T-004 adds it.
- Pinned hashes: the kikapu-studio v3 mandate `c3f3f9c2…2374` in `mandate.test.ts`; the payout intent without a reference `b3ef2f28…d2a4` in `intent.test.ts`.
- Tests that used `payee.allowlisted` as the "unbuilt verifier" now use `ledger.velocity`. T-002 should look for the same pattern in `packages/verifiers` and the gate.

## For the human

- T-001: before the answerer's verdict arrived, I wrongly acted on a predicted answer and built a "not reachable yet" exception list in `decide.test.ts`. I removed it before committing; the committed work follows the answerer's real verdict, ADR 0040. As the answerer directed, I reworded T-001's third acceptance item and added one to T-004. Please check that you're happy with ADR 0040, since it changes the ticket split.
- T-003: the `LIVE=1` payout check hasn't run yet. Run it with `LIVE=1` and Payouts enabled on the sandbox app. It reads the batch up to 10 times, 3 s apart, until the item appears. If `isDuplicateBatch` fails there, its message shows PayPal's real name and issues. Update `error-400-duplicate-batch.json` to match.

## T-002 (done)

- `payee.allowlisted` is built in `packages/verifiers/src/payee.ts`: pass/fail over `records.payees` (`PayeeListSnapshot`, call `mandate payees`, ID `<mandate id> v<version>`); unknown "No payee list" (record ID null) and unknown "Not a payout" (no records) for a non-payee target. Both sides are normalized with `normalizePayeeEmail`.
- Gotcha: `decide()` does not set `records.payees` until T-004, so through the gate a payout still reaches `PAYEE_LIST_UNKNOWN` (unknown) and a listed payee cannot pass yet. `NOT_BUILT_YET` in `run-verifiers.test.ts` no longer lists `payee.allowlisted`.

## T-003 (done)

- `@countersign/rail-paypal` gains `createPayout` (`CreatePayoutInput`: `requestId`, `senderBatchId`, `emailSubject`, `receiver`, `amount`, `note?`, `senderItemId`), `getPayoutBatch` and `getPayoutItem` (records `PayPalPayoutCreated`, `PayPalPayoutBatch`, `PayPalPayoutItem`), and `isDuplicateBatch` in `errors.ts`. Tests: `packages/rail-paypal/test/payouts.test.ts`, with five new fixtures. There's also a `LIVE=1` payout case in `live-sandbox.test.ts`, which reads `PAYPAL_LIVE_PAYEE_EMAIL` when it's set.
- Gotcha: Payouts write money as `{ value, currency }`, not `currency_code`, so they have their own `payoutMoneySchema`. `senderBatchId`, `senderItemId`, `errorName` and `timeProcessed` are null when PayPal leaves them out.
- Gotcha: `isDuplicateBatch` matches `DUPLICATE` or `SENDER_BATCH_ID` regardless of case, because the documented issue text is lower-case ("Batch with given sender_batch_id already exists"). It only matches a 4xx `http` error.
- Gotcha: `apps/gate/test/fake-sandbox.ts` has stubs that throw for `createPayout`, `getPayoutBatch` and `getPayoutItem`. T-006 must turn them into a real fake: replay by request ID, a duplicate refusal for a reused batch ID, and seeded items.

## T-004 (done)

- Gate: `ops-agent` principal (`OPS_AGENT_KEY_VAR`, mandate `kikapu-studio-ops-v1.json`); equal principal keys both go to `unset`; the approver is checked against `principalKeyCandidates(env)` (every long-enough principal value, equal ones included). `Principals.mandateProblem` became `mandateProblems: { principal, problem }[]`, and `readMandate` now takes the principal's name. `create_payout` requires `reference` and USD ("Payouts are paid in USD only"). `decide()` replaces `records.payees` with the deciding mandate's list (`withMandatePayees`). `PAYEE_NOT_ALLOWLISTED` is in the catalog and is the `payee.allowlisted` fail code. 27 reason codes. New case `ops-payouts.json`.
- Gotcha: `approval-log.ts`'s strict `ParamsSchema` now accepts `reference`, so a payout step-up's stored intent parses. Approval cards don't show it yet (T-009).
- Gotcha: `propose-invoice.test.ts` and `answer-step-up.test.ts` still use a payout (now with a reference) as "an action with no executor". T-006 must switch them to `pay_order`, as plan.md says.
- Gotcha: a mandate's `mandate.version` ref is `kikapu-studio-ops@v1` (`mandateRef`), but the payee snapshot's ID is `kikapu-studio-ops v1`, as requirements.md says.

## T-005 (done)

- `agent-cli.ts` proposes as the file's `principal` (`support-agent` or `ops-agent`), with that principal's key variable. A principal outside those two, a missing or short key, or two equal principal keys exit 2 naming the variable (an unknown principal names the two it can run), and a 401 names the variable used. `AGENT_PRINCIPAL` and `AGENT_KEY_VARIABLE` are gone (nothing else imported them). New `apps/gate/proposals/ops-payouts.json` (three proposals, no tickets); the tests run it over a listening gate on PGlite and check that no ticket is written.
- Gotcha: the agent CLI doesn't read a proposal file's `mandate` key (only the propose CLI does), so `ops-payouts.json` names the ops mandate for the propose CLI and for readers only.

## T-006 (done)

- `paypal.payout` is executable. `executePayout` in `executors.ts` sends `createPayout` (request ID the intent hash, batch ID the intent ID, item ID the reference, `PAYOUT_EMAIL_SUBJECT`, the note only when set), then reads the batch once. `execution.result` gains `payout: { batchId, batchStatus, item: { id, status } | null }` on executed, failed and unknown (`PayoutResult` in `execution-log.ts`). `ExecutedRecord`, `Execution`, `alreadyRequested` and the approve answer (`executionView`) carry `payout`. Tests: `apps/gate/test/payout-executor.test.ts`, plus schema cases in `execution-log.test.ts` and an approve-answer case in `approvals-api.test.ts`. The "no executor" tests now use `pay_order`.
- Gotcha: the outcome comes from the re-read batch's status, or from the create answer's status when the read fails. A duplicate-batch refusal is `unknown` with the error; a network failure is `unknown`, as before.
- Gotcha: the fake sandbox now has real payouts: `payoutBatches`, `payoutItems`, `payoutBatchStatus` (default `PENDING`), `payoutItemStatus` (default `UNCLAIMED`) and `payoutsSent`. IDs are `FAKEBATCH0001` and `FAKEITEM0001`. It replays by request ID and refuses a reused sender batch ID with a 400 `USER_BUSINESS_ERROR`.
- For T-007: `readReconcileWork` still puts a payout whose result is unknown, or that has no result, into `open` (with `captureId` null), next to refunds. The reconcile CLI's handling of that list needs to tell payouts apart. `readReconciliationState` ignores payout results.
- For T-009 and T-010: approval cards (`approval-cards.ts`) and the audit reader don't read `payout` from a result yet. `RecentSummary.execution` shows no payout.

## T-007 (done)

- `ReconciliationPayloadSchema` is now a `z.union` of four forms: webhook or poll, each with `refund` or `payout: { batchId, itemId, status, amount }`. The payout forms carry `refund: z.undefined().optional()`, so `payload.refund` still type-checks in older tests; narrow with `payload.refund !== undefined`, not `"refund" in`. `PAYOUT_FINAL_STATUSES` is exported from `execution-log.ts`.
- New `readPayoutWork(reader)` lists every executed payout (`ExecutedPayoutIntent`: intent, result seq, batch, payee, latest item from the intent's latest payout reconciliation else the result). `readReconcileWork`'s shape is unchanged because tests pin older logs reading exactly as phase 8 read them; `OpenRequest` only gains an optional `payee`, set for payouts.
- The reconcile CLI re-reads each payout whose item isn't final: by item ID, or through its batch when the result named no item. It logs a poll reconciliation (ref the intent, `resultSeq` the executed result) only when the status changed, and checks again under the lock. A read failure, or an item from another batch or `sender_batch_id`, goes under "Needs attention" and exits 1. A payout that's still open doesn't change the exit code. Output: a `Re-read N payouts.` block with "Payout int_… to <email>: <STATUS>[, waiting for the payee to claim it]." "Nothing to reconcile." appears only when the log has no executed refunds and no executed payouts. Open payout requests show `payee <email>`, plus a payout hint line.
- For T-010: `audit-reader.ts` reports a payout reconciliation as not readable ("which the reader doesn't show yet", marked `TODO(T-010)`), because `TrailParts`' reconciliation needs a non-null `refund` and the console schema requires it. T-010 should add the payout shape there and in `audit-cli.ts`'s `trailWords`.
- For T-008: the webhook can reuse `reconciliationEntry` with `source: "webhook"` and `payout`. `readReconciliationState` ignores payout reconciliations, apart from adding their event IDs.
