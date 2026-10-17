# Phase 4 validation: tamper-evident audit log

## Automated checks

All run from the repo root and are part of the Feedback commands, except check 11, which is live.

1. `npm run typecheck`, `npm run lint`, `npm test` and `npm run build` pass.
2. **Migrations:** the migrations apply to a fresh in-memory PGlite. The table has the columns, keys and UNIQUE constraints in requirements.md. A second `npm run db:generate` reports no schema changes.
3. **Backstops:** inserting a row with an existing `seq` fails, and so does one with an existing `prev_hash` (a fork). UPDATE and DELETE on `audit_log` fail with the trigger's message. TRUNCATE works.
4. **Chain, pure:** `verifyChain` passes on an empty list and on a valid chain. It reports each problem in requirements.md's table on a hand-built row list, at the right `seq`:
   - an edited payload, entry type, ref, time or hash;
   - an edit with its hash recomputed;
   - a deleted middle row;
   - two swapped rows;
   - a non-canonical payload with the same value;
   - an unknown entry type;
   - a bad timestamp;
   - payload text that isn't JSON.

   It never throws.
5. **Hash reference:** one hand-written envelope canonical string for a known entry hashes to the entry's stored hash, so the format in ADR 0022 is pinned.
6. **Payload preparation:** a lone surrogate becomes U+FFFD, absent fields are left out, and a proposal text over 16,384 characters is cut without splitting a surrogate pair, with `proposalTruncated` true.
7. **Appending:** three appends make a chain that `verifyLog` passes, with `seq` 1 to 3 and entry 1 linked to genesis. Twenty concurrent appends on one PGlite give `seq` 1 to 20 with no gap, and the chain verifies. An unknown entry type, a bad time or an unpreparable payload writes nothing.
8. **Tamper test (brief §11):** on a real PGlite table, with the trigger disabled the way an attacker with owner rights would, editing one row's payload makes `ledger verify` exit 1 and name that row's `seq`. Recomputing that row's hash moves the report to the next row as `BROKEN_LINK`. Deleting a middle row gives `SEQ_GAP`. Re-enabling the trigger and restoring the row makes it pass again.
9. **Recording:** recording beat 3's case gives one `mandate.version` entry and five `decision` entries, and the chain verifies.
   - Recording it again adds five decisions and no second mandate entry.
   - A mandate changed under the same ID and version is refused with `MANDATE_VERSION_CONFLICT`, and nothing is written.
   - An invalid proposal, one with a fractional amount and one with an unknown tool are each recorded with ref null and their text intact.
   - A proposal whose ticket ID holds a lone surrogate is denied `INVALID_PROPOSAL` and recorded.
10. **CLIs:** child-process runs on a temporary PGlite directory:
    - `ledger verify` exits 0 on an empty log and on a recorded one, and 1 after a tamper;
    - `ledger tail` lists the entries;
    - `decide --record` on beat 3 prints the phase 3 output, then "Recorded 6 entries";
    - `decide --record --json` keeps stdout valid JSON;
    - no output contains the value of `DATABASE_URL` when it's set to a dummy value with a password.
11. **Live (`LIVE=1`, needs `DATABASE_URL`):** in a throwaway schema on a real Postgres 18, 20 concurrent appends over a pool of at least 5 connections give `seq` 1 to 20 with no gap. `verifyLog` passes, and the schema is dropped afterwards. Run it with `LIVE=1 npm test -- packages/ledger` once the Render database exists.
12. The "no AI in the decision path" test still covers `@countersign/ledger` and passes.

## Manual checks for the human

1. Run `npm run decide -- apps/gate/fixtures/cases/beat-3-attack-email.json --record`, then `npm run ledger -- tail` and `npm run ledger -- verify`. Check that a stranger could read the tail and the verify line.
2. Open `.countersign/pglite` with any Postgres client, or run `npm run ledger -- tail`. Pick one decision entry and confirm that its payload shows the proposal exactly as sent, the reasons and the verifier trace.
3. On the hosted database (phase 13): `npm run db:migrate` as the Render pre-deploy command, then `npm run ledger -- verify` with `DATABASE_URL` set. Brief §12 needs it to pass there.
4. Read the README's audit-log section. Check that it says plainly what the chain can't show: rows cut off its end.
5. Gate G1 needs phases 5 and 6 as well. This phase covers "the audit log verifies".
