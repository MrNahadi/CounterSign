# Review B2: implementation readiness re-audit

*   **Target:** `specs/features/13-hosted-judge-path/design.md`, items 12b and 8 to 19a, against `reviews/B-readiness.md` and `reviews/resolution.md` (Round B).
*   **Mode:** REVIEW, re-audit. Scope: is the one Blocker from `B-readiness.md` resolved, and did the round B fixes add a Blocker? Majors and Nits are not raised.
*   **Read:** the design (all 709 lines), `apps/gate/src/app.ts`, `apps/gate/src/approvals-api.ts`, and a search for `app.use` and `app.all` across `apps/gate/src`.

--------------------------------------------------------------------------------

## The original Blocker: route order breaking the QR sign-in

**Resolved.**

*   `design.md` item 12b (line 426) says `createApp` calls `mountPairing(app, { approver, clock: webhookDeps.clock })` before `mountApprovals`, with a comment saying why. It names both failures: `POST /approvals/pair` hitting the `:id` key check, and `/approvals/pairing-codes` hitting its 404.
*   The code confirms the hazard was real and the fix targets it. `mountApprovals` registers `GET` and `POST /approvals/:id` behind `approverOnly` (`approvals-api.ts:136,150`), and `createApp` calls it at `app.ts:96`.
*   Nothing else in the gate could shadow the pairing routes. The only `app.use` or `app.all` in `apps/gate/src` is `app.all("/mcp")` (`mcp.ts:235`), which doesn't match `/approvals/*`. `/approvals/documents/:id` is a `GET`, so it doesn't overlap either pairing `POST`.
*   The test requirement now matches the failure. `test/pairing.test.ts` runs through `createApp`, not `mountPairing` alone. It checks `POST /approvals/pair` with no key answers 200 for a valid code, `POST /approvals/pairing-codes` with the approver key answers 201, and `GET`/`POST /approvals/<real step-up ID>` still behave as before. An implementer who mounts in the wrong order would fail that test.
*   The implementer has no design choice left: the position is "before `mountApprovals`" and the call's arguments are given.

## New Blockers from the round B fixes

**None found.** I read each round B change for something an implementer could not build without making a design choice or that cannot work as written.

*   **Item 8, rail timeout and `RAIL_WORST_CALL_MS`.** The formula, the constants and the source of the "2" (`MAX_RAIL_CALLS_PER_EXECUTION`) are given. 600 s > 2 × 200 s holds. `FetchLike` gains `signal?`, `read` is wrapped, and the retry wording is corrected.
*   **Item 14, supplied tokens.** `SuppliedTokens` (`hold`, `take`) has a stated owner (`serve.ts`) and consumers (`createApp`, `createModeRunner`). `take` comes first, so every exit drops the token. `hold` is called only on the enqueue path. The rerun carry-over and its 60-second life check are specified, with tests. `AppDeps.canMintTokens` (default true) closes the gap on whether Resolve can mint.
*   **Items 16, 19, 19a, limiter composition.** `Refusal["status"]` gains 429, and `limitSession` returns a `Refusal | null` inside the sign-in callback. The check order is fixed: key cookie, gate check, session, limit. `resetRoute` runs the limiter right after `withKey`. `json()` takes an array and appends. `callGate`'s `key` may be null.
*   **Items 9 step 8, 12a and 1.** The dispute-sync throw is caught as `{ error }`. The launch handler uses `resolveAgentUrl(env)` and shows the token mapping and the global `fetch`. `@countersign/seed` is added to the gate manifest.
*   **Item 21.** The pairing-code request is a POST with a body and counts only an exact 201.

Nothing here leaves a decision to the implementer or contradicts the code I read.

--------------------------------------------------------------------------------

## Summary

Blocker resolved. 0 new blockers.

GO
