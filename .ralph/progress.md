# Progress: phase 4, tamper-evident audit log (specs/features/04-tamper-evident-audit-log)

## T-001
IdSchema now rejects lone surrogates (isWellFormed refine), so mandate, case file and proposal parsers deny them and decide never throws in hashIntent.
Gotcha: build lone-surrogate strings in tests with String.fromCharCode(0xd800); `\u` escapes get decoded by the Write tool.

## T-002
@countersign/db: audit_log schema, first migration (0000_known_mentallo.sql) with the hand-added append-only trigger, and clients createTestDatabase / openPgliteDirectory / openPostgres / openDatabase, each a DatabaseHandle { kind, db: Database, migrate(): Promise<number> (count applied), close() }.
Gotchas: Drizzle wraps driver errors in DrizzleQueryError; the Postgres message (constraint name, "audit_log is append-only") is on `error.cause`. A fresh PGlite takes about 2s to start, so share one per describe block and TRUNCATE between tests. openPostgres never migrates and connects lazily; it doesn't yet scrub DATABASE_URL from connection errors (T-007's job). `.countersign/` is not in .gitignore yet (T-007).

## T-003
packages/ledger/src/chain.ts: ENTRY_TYPES/isEntryType, GENESIS_HASH, entryHash(envelope), preparePayload(unknown) -> { ok, value, canonical } | { ok: false, detail }, ChainRow (same shape as db's AuditLogRow), CHAIN_PROBLEMS, verifyChain(rows), and createChainVerifier() { add(row), verdict() } for T-004's paged verifyLog. An empty chain's head is { seq: 0, hash: GENESIS_HASH }.
Gotchas: entryHash throws on lone surrogates in envelope fields, so T-004's append must check entryType/at/refId first (refId may hold a lone surrogate from an ID; T-001 rejects those in IDs). A row may get several problems (a deleted middle row gives SEQ_GAP and BROKEN_LINK on the next row). A non-JSON payload gets NOT_CANONICAL only, since its hash can't be recomputed.

### For the human
- T-003 link rule: a row's prev_hash is accepted if it matches the previous row's stored hash, or, when that stored hash is itself wrong, the hash recomputed from the previous row's columns. Without this, an edited `hash` column would also show BROKEN_LINK on the next row, against validation check 4 and "an edited row is reported once, at its own seq". Two swapped rows still show a BROKEN_LINK on the row after them too, which a stored-hash chain can't avoid. Overturn if you'd rather link to the stored hash only.
