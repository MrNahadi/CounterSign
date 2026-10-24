# Progress: phase 12, ops-agent supplier payouts (specs/features/12-ops-agent-payouts)

## T-001 (done)

- Mandate gains optional `payees` (zod, max 100, lower-cased trimmed unique emails); `kikapu-studio-ops-v1.json`; `PAYEE_LIST_UNKNOWN`; `payee.allowlisted` unknown maps to it; payout `reference` hashed only when set (`HASHED_WHEN_SET`). Gate case `payee-list-missing.json` under test mandate `apps/gate/fixtures/mandates/payout-no-payee-list.json` reaches it; reason-code count 26.
- Gotcha (ADR 0040): `PAYEE_NOT_ALLOWLISTED` was moved to T-004, because the gate's "reaches every reason code" test needs a decision case that reaches every code. A reason code joins the catalog in the ticket whose decision case first reaches it. Until T-004, a `payee.allowlisted` fail denies `VERIFIER_UNAVAILABLE` (`REQUIREMENT_CODES` entries may now leave out `fail` or `unknown`).
- Gotcha: `create_payout` rejects a `reference` arg until T-004, so `payee-list-missing.json`'s payout has none. T-004 adds it.
- Pinned hashes: the kikapu-studio v3 mandate `c3f3f9c2…2374` in `mandate.test.ts`; the payout intent without a reference `b3ef2f28…d2a4` in `intent.test.ts`.
- Tests that used `payee.allowlisted` as the "unbuilt verifier" now use `ledger.velocity`. T-002 should look for the same pattern in `packages/verifiers` and the gate.

## For the human

- T-001: before the answerer's verdict arrived, I wrongly acted on a predicted answer and built a "not reachable yet" exception list in `decide.test.ts`. I removed it before committing; the committed work follows the answerer's real verdict, ADR 0040. As the answerer directed, I reworded T-001's third acceptance item and added one to T-004. Please check that you're happy with ADR 0040, since it changes the ticket split.
