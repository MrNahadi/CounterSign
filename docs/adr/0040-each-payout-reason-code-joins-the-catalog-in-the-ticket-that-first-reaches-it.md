# 0040. Each payout reason code joins the catalog in the ticket whose decision case first reaches it

Status: accepted, refines the ticket order for ADR 0039 (no change to its decisions)
Decided-by: answerer (inferred)
Question: T-001 (specs/features/12-ops-agent-payouts/tickets.md) adds `PAYEE_NOT_ALLOWLISTED` and `PAYEE_LIST_UNKNOWN` to `@countersign/mandate`. `apps/gate/test/decide.test.ts` ("the fixture suite > reaches every reason code") needs every code in `REASON_CODES` reached by a decision case. `PAYEE_NOT_ALLOWLISTED` can't be reached through `decide()` until T-002 (the verifier) and T-004 (the payee snapshot in `decide()`, and `ops-payouts.json`). The loop must not weaken a test, must stay inside one ticket, and must pass every Feedback command. Which gives?
Decision: Neither the test nor the ticket scope gives way. The ticket split changes instead. `PAYEE_LIST_UNKNOWN` stays in T-001, reached by a new decision case under a test mandate whose payout rule requires `payee.allowlisted` but which has no `payees` list. That case stays unknown through T-002 and T-004, because no list means no snapshot. `PAYEE_NOT_ALLOWLISTED`, the `payee.allowlisted` fail mapping and its evaluator test move to T-004, where `ops-payouts.json` first reaches it. The pinned count goes to 26 in T-001 and 27 in T-004. The test never gets a "not reachable yet" list.
Basis:
- `.ralph/PROMPT.md`, Never: "Weaken, skip or delete a test to make it pass." Section 1: "Do exactly one ticket." Section 4: all four Feedback commands must pass.
- Phase 12 validation.md, automated check 2: "`PAYEE_NOT_ALLOWLISTED` and `PAYEE_LIST_UNKNOWN` have words and hints and the 'every code is reached' test covers them". This is checked when the feature is validated, not per ticket.
- Phase 7 precedent: the acceptance item "The 'every code is reached' test covers 25 codes" sits in 07 T-004, the ticket whose cases reached the last new code.
- Phase 12 requirements.md, Constraints: "Fail closed: no payee list ... never allows". The new case is that check.
- `packages/mandate/src/evaluate.ts`: a requirement result with no mapped code already falls back to `VERIFIER_UNAVAILABLE` (still a deny). So a `payee.allowlisted` fail between T-001 and T-004 denies. No `decide()` path can produce that fail before T-004.
Consequences:
- T-001: no `PAYEE_NOT_ALLOWLISTED` in `REASONS` or the catalog test yet. `REQUIREMENT_CODES` entries may leave out `fail` or `unknown`, and `payee.allowlisted` maps only `unknown`. A test fixture mandate goes in `apps/gate/fixtures/mandates/` and a new case in `apps/gate/fixtures/cases/`. The count becomes 26.
- T-004 gains an acceptance item: `PAYEE_NOT_ALLOWLISTED` with requirements.md's words and hint, the fail mapping, the evaluator's fail case changed from `VERIFIER_UNAVAILABLE` to it, and the count at 27. T-004's `reference` change also covers the new case's payout proposal.
- From here on, a reason code joins the catalog in the ticket whose decision case first reaches it.
