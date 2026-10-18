# Progress: phase 8, Resolve, protected and baseline (specs/features/08-resolve-protected-and-baseline)

## T-001 (done)
- `@countersign/db` gains `tickets.thread_id` and `ticket_attachments` (migration `0003_striped_ikaris.sql`, hand-edited to add the column nullable, backfill `thread_id = id`, then set NOT NULL), plus `readThread`, `listThreads`, `writeAttachment`, `readAttachment` and the `ThreadTicket`, `ThreadSummary`, `Attachment`, `StoredAttachment` types.
- Gotcha: `readTicket` still returns the old `Ticket` shape (no `threadId`) so existing `toEqual` tests hold; use `readThread`/`listThreads` to get the thread. `writeTicket` stores `threadId ?? id` and refuses a rewrite with another thread.
- Gotcha: received times are text with any offset; thread order uses `received_at::timestamptz`. `listThreads` reports `latestActivityAt` as the latest ticket's stored text (T-002 may want run times too).
- Gotcha: drizzle-kit writes `ADD COLUMN ... NOT NULL` with no backfill; hand-edit any NOT NULL column added to a table with rows. Migration tests that slice the journal should count `journal.entries.length - N`, not a constant.
- bytea is a `customType` in `schema.ts` (Buffer to the driver, Uint8Array back).

### For the human
- `packages/db/test/tickets.test.ts`'s phase 6 migration test expected exactly 1 migration to apply; it now expects every migration after phase 6 (`journal.entries.length - 2`). Same strictness, but it's an edit to an existing test.
