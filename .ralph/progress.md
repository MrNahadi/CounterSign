# Progress: phase 8, Resolve, protected and baseline (specs/features/08-resolve-protected-and-baseline)

## T-001 (done)
- `@countersign/db` gains `tickets.thread_id` and `ticket_attachments` (migration `0003_striped_ikaris.sql`, hand-edited to add the column nullable, backfill `thread_id = id`, then set NOT NULL), plus `readThread`, `listThreads`, `writeAttachment`, `readAttachment` and the `ThreadTicket`, `ThreadSummary`, `Attachment`, `StoredAttachment` types.
- Gotcha: `readTicket` still returns the old `Ticket` shape (no `threadId`) so existing `toEqual` tests hold; use `readThread`/`listThreads` to get the thread. `writeTicket` stores `threadId ?? id` and refuses a rewrite with another thread.
- Gotcha: received times are text with any offset; thread order uses `received_at::timestamptz`. `listThreads` reports `latestActivityAt` as the latest ticket's stored text (T-002 may want run times too).
- Gotcha: drizzle-kit writes `ADD COLUMN ... NOT NULL` with no backfill; hand-edit any NOT NULL column added to a table with rows. Migration tests that slice the journal should count `journal.entries.length - N`, not a constant.
- bytea is a `customType` in `schema.ts` (Buffer to the driver, Uint8Array back).

### For the human
- `packages/db/test/tickets.test.ts`'s phase 6 migration test expected exactly 1 migration to apply; it now expects every migration after phase 6 (`journal.entries.length - 2`). Same strictness, but it's an edit to an existing test.

## T-002 (done)
- `@countersign/db` gains `agent_runs` (migration `0004_stale_beyonder.sql`) and `createRun`, `startRun`, `finishRun`, `readRun`, `readRunsByThread`, `countRunsOnDate(db, "YYYY-MM-DD")`, `markUnfinishedRunsInterrupted(db, finishedAt)`, with `AgentRun`, `NewRun`, `RunResult` types and `RUN_MODES`/`RUN_STATUSES`.
- Gotcha: `finishRun` accepts a `queued` or `running` run (so `not_run` needs no start) and throws `AgentRunConflictError` on a final one, `AgentRunNotFoundError` on an unknown ID. `createRun` is always `queued`; `trace` is any JSON value (null when none). A `seq` bigserial column keeps creation order. The daily count uses the queued time as a UTC date.

## T-003 (done)
- `apps/resolve-agent/src/model.ts`: `SYSTEM_INSTRUCTION`, `parseModelEnv`, `geminiClientOptions`, `createGenerateContent(apiKey)`, `buildModelRequest({ model, contents, declarations })` (sorts by name), `checkResponse` and `callModel({ generateContent, request, sleep? })` returning `{ ok, response, content }` or `{ ok: false, outcome, response? }`.
- Gotcha: stop reasons are the block or finish reason as given (if it matches `^[A-Z][A-Z0-9_]{0,63}$`, else `UNKNOWN`), plus `NO_CANDIDATE`, `FINISH_REASON_MISSING` and `NO_PARTS`. The console (T-012) needs words for those three.
- Gotcha: a 429 retry delay is read from the `ApiError` message JSON (`error.details[]` RetryInfo `retryDelay: "Ns"`); no readable delay means `model_unavailable`. A non-API error (e.g. `fetch failed`) is `model_error`; DOMException `TimeoutError`/`AbortError` is `model_unavailable`. `callModel` does not time calls; T-005 measures latency.
- zod resolves from the root `package.json` (4.6.7); resolve-agent does not list it, same as the other workspaces.
