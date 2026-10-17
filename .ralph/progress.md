# Progress: phase 4, tamper-evident audit log (specs/features/04-tamper-evident-audit-log)

## T-001
IdSchema now rejects lone surrogates (isWellFormed refine), so mandate, case file and proposal parsers deny them and decide never throws in hashIntent.
Gotcha: build lone-surrogate strings in tests with String.fromCharCode(0xd800); `\u` escapes get decoded by the Write tool.

## T-002
@countersign/db: audit_log schema, first migration (0000_known_mentallo.sql) with the hand-added append-only trigger, and clients createTestDatabase / openPgliteDirectory / openPostgres / openDatabase, each a DatabaseHandle { kind, db: Database, migrate(): Promise<number> (count applied), close() }.
Gotchas: Drizzle wraps driver errors in DrizzleQueryError; the Postgres message (constraint name, "audit_log is append-only") is on `error.cause`. A fresh PGlite takes about 2s to start, so share one per describe block and TRUNCATE between tests. openPostgres never migrates and connects lazily; it doesn't yet scrub DATABASE_URL from connection errors (T-007's job). `.countersign/` is not in .gitignore yet (T-007).
