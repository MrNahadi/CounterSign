# 0037. Failed dispute drafts are kept as history rows and every draft counts against the daily run cap; Resolve reads drafts by dispute ID

Status: accepted, refines ADR 0035 (Resolve's `dispute_drafts`)
Decided-by: answerer (inferred)
Question: T-009 (specs/features/11-dispute-evidence/tickets.md, Resolve's dispute intake). `dispute_drafts.dispute_id` is UNIQUE (T-003), so a new draft after a failed one would overwrite the failed row, and that row's attempt would drop out of the day's count. Unauthenticated, repeated `POST /disputes` on a dispute whose drafts fail after the model call (for example `proposal_rejected`) could then make unbounded Gemini calls under RESOLVE_DAILY_RUN_CAP. Overwrite in place, or keep failed drafts as rows? And does `GET /disputes/:id` take the dispute ID or the draft ID?
Decision:
- A new migration replaces the `dispute_drafts_dispute_id_unique` constraint with a partial unique index on `dispute_id` `WHERE status <> 'failed'`. Failed drafts are never updated into a new draft or deleted. A redraft inserts a new row with a new draft ID. A dispute has at most one draft that isn't `failed`, so drafting stays idempotent per dispute (ADR 0035).
- The daily run cap counts every `dispute_drafts` row queued on the UTC date, every status included, plus every `agent_runs` row as `countRunsOnDate` counts it now.
- `POST /disputes` does check-then-insert. If the insert hits the partial unique index (a concurrent request won), it re-reads the draft that isn't `failed` and answers 200 with it.
- `GET /disputes` answers the latest draft (highest `seq`) for each dispute, newest first, and carries each draft's `draft_id`. `GET /disputes/:id` takes the dispute ID (for example `PP-D-12345`), checked with the same zod schema as `POST /disputes`' `dispute_id`. It answers that dispute's latest draft, or 404 when the dispute has no draft.
Basis:
- Brief §8: "The public demo can't run up unbounded AI cost: each session is rate-limited, and AI spend has a daily cap." Overwriting failed rows leaves the cap open to an unauthenticated caller, so that option breaks a non-negotiable.
- Brief §10 trade-off 1: fail-closed money safety. On cost, fail closed means every attempt that could have made a model call is counted.
- requirements.md, "Resolve's dispute drafts": "otherwise 202 with the new draft" and "`GET /disputes`: drafts newest first". CONTEXT.md: a dispute draft is "One Resolve run". Message runs already keep every run, failed ones included, and `countRunsOnDate` counts "every status included".
- The lookup key matches the rest of the dispute surface, which uses the dispute ID: `POST /disputes { dispute_id }`, `npm run resolve -- dispute <id>`, the console's Disputes page (one row per dispute PayPal opened) and "Draft again". Brief §10 trade-off 4 (a stranger understands it in 60 seconds) favours one row per dispute on the page over a list of attempts.
Consequences:
- `@countersign/db` gains a migration after `0005_absent_screwball.sql`, and the schema swaps `.unique()` on `disputeId` for a partial `uniqueIndex(...).where(...)`. Migrations must still apply on a fresh PGlite and on a database at phase 10's schema.
- The T-009 helpers read "the draft for a dispute" as the latest by `seq`. T-010 and T-014 read that view. A failed draft followed by a newer one shows only the newer one on the Disputes page.
- Failed attempts stay in the table as an audit trail of model spend. The demo reset truncates the table as it does `agent_runs`.
- Not decided here: requirements.md treats a `not_run` (`daily_cap`) draft as live, so `POST /disputes` answers 200 with it and never redrafts it. ADR 0035 says a draft over the cap uses the template instead. T-009 follows requirements.md and its acceptance criteria. The mismatch is for T-010 or the owner to settle.
