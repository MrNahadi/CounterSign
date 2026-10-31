# Round A re-audit: comprehension review

*   **Reviewer:** Comprehension Goldfish (`.ralph/egm/agents/comprehension.md`, Mode: REVIEW)
*   **Standard:** `.ralph/egm/standards/re-implementation-standard.md`
*   **Target:** `specs/features/13-hosted-judge-path/design.md`, the whole document (682 lines)
*   **Scope of this audit:** whether Blocker B-1 of `reviews/A-comprehension.md` is resolved, and whether the fix introduced a new Blocker. Majors and Nits are not raised.
*   **Read:** the target; `reviews/A-comprehension.md`; `reviews/resolution.md`; `CONTEXT.md`; ADRs 0042 and 0044 (linked), and ADRs 0022, 0026, 0032 and 0039 (named by B-1 or by the fix); brief §8 and §10. For one point only, `apps/gate/src/record.ts`, to see whether the mandate entry is logged again after a reset. Nothing else.

Result: B-1 resolved. 0 new Blockers.

## B-1: resolved

*   **Severity:** none (was Blocker)
*   **Affected Scope:** Goals G-4; Technical Plan, "What a reset keeps and restarts (ADR 0044)"; item 8 (`countUnansweredRequests`, `requestedCaptureIds`); item 9 steps 4 to 7.
*   **Discrepancy & Rationale:** B-1 asked the design to name every guarantee that reads the audit log and to say, for each, whether the reset carries it forward, accepts losing it, or refuses to run. The new table does that, and G-4 now lists its measures (validation checks 3, 4, 5 and 8). Each of B-1's four questions has an answer a reader can act on without guessing:
    *   **Today's usage and the mandate's daily limits.** The table says they restart, as on a fresh seed. It gives the reason: only the approver key can reset, that key can already approve any stepped-up amount, and carrying usage over would step up beat 4 for later judges. Alternative I and ADR 0044 repeat it, so the choice is explicit and no implementer has to make it alone. The run cap is kept and its counting rule is stated (every status, UTC date of `queued_at`).
    *   **Open step-up cards.** The table says they are cleared with their `decision` entries and that a card still open on a phone fails when answered. Nothing is built for this. The failure comes from the hash binding in ADR 0032, so a reader has nothing to guess.
    *   **A payout that executed before the reset.** The table says PayPal still guards it. The same payout carries the same `PayPal-Request-Id` and `sender_batch_id`, which PayPal refuses (ADR 0039 says a reused `sender_batch_id` is rejected within 30 days, which covers the period to 22 Dec). A changed bill, amount or note is a new payout, and every payout is a step-up, so it needs a new approval. The ops agent is stated to be off the judge path.
    *   **`npm run reconcile`, the cron and webhooks.** The table says dedup and reconciliation restart, a late webhook for a replaced capture is logged as a refund nobody requested, and `reconcile` has no request left to match it to.

    The duplicate-refund guarantee, which B-1 did not list but which `ledger.not_duplicate` reads, is handled by a rule an implementer can build from the document:
    *   Item 8 gives the signatures and behaviour of `requestedCaptureIds` and `countUnansweredRequests`, including that an unreadable entry makes the answer unknown and fails closed.
    *   Item 9 step 5 replaces any seeded order whose capture an `execution.requested` names, and every order when the history is unknown.
    *   Step 7 checks again inside the lock.
    *   The table states the limits of the rule: a refund still pending at PayPal, and baseline refunds that never reach the log.

    The "refuse to run" cases are also pinned down. The busy checks before the order check and again inside the lock cover runs, drafts, unanswered execution requests from the last 10 minutes and the one-minute cooldown. Their order and their 409 keys are given. A 30-second rail timeout and a check that `EXECUTION_WINDOW_MS` exceeds 4 × `RAIL_WORST_CALL_MS` show why an execution can't outlast that window. The entry-1 and `seq` behaviour needed for the cooldown is covered by the ledger paragraph (`appendPrepared`, no sequence, no `RESTART IDENTITY`).

## New Blockers

None. I checked the places where the fix adds behaviour:

*   **`mandate.version` entries.** `TRUNCATE audit_log` also removes the logged mandate versions. ADR 0022 says a mandate entry is written the first time a decision uses a version, and `apps/gate/src/record.ts` writes it again when `findMandateEntry` finds none. The new chain therefore gets its mandate entry with the next decision, and a reader doesn't need to be told anything.
*   **The order of work in items 8 and 9.** Every function the steps call (`countUnfinishedWork`, `countUnansweredRequests`, `requestedCaptureIds`, `runsQueuedSince`, `seededCaptureTouched`, `lockDemoTables`, `clearDemoTables`) has a signature and a defined result in the document. The refusal keys match the `RESET_MESSAGES` list. Every failure branch has a status: 409 for `ResetRefused` and `55P03`, 503 for any other error, and 200 with `cleared: null` for a failed replacement.
*   **Terms the fix introduces.** `cleared_run_counts`, `demo.reset`, `EXECUTION_WINDOW_MS`, `RESET_COOLDOWN_MS` and "single-flight" are each defined inline, in the symbol table or in ADR 0044.
*   **Consistency of the fix across the document.** G-4, the reset diagram, the keep/restart table, Alternatives G, H and I, the Risks table, the CUJs (2, 4, 5) and item 24's `CONTEXT.md` change all say the same thing about the order (replace, then clear), usage (restarts) and in-flight work (read from the database). I found no contradiction that would let two implementers build different behaviour.
