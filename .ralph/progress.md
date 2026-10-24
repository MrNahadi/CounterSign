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
