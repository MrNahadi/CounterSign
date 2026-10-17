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

## T-004
packages/ledger/src/log.ts: AUDIT_LOG_LOCK_KEY (bigint), withAuditLog(db, work) giving an AuditLogWriter { tx, append(input) } under the advisory lock in one READ COMMITTED transaction; appendEntries(db, inputs) -> { ok, entries } | { ok: false, index, rejection }; appendEntry(db, input) -> { ok, entry } | { ok: false, rejection }; verifyLog(db, { pageSize? = 500 }) with keyset paging. Rejection codes: BAD_INPUT, UNKNOWN_ENTRY_TYPE, BAD_TIMESTAMP, BAD_REF, BAD_PAYLOAD.
Gotchas: writer.append throws AppendRejectedError, which rolls back the whole withAuditLog transaction unless caught; T-006's recordDecision should pre-check or catch it. Use log.tx for reads inside the transaction (e.g. finding the mandate.version entry). @countersign/db now re-exports asc, desc, gt and sql from drizzle-orm, so other workspaces needn't declare drizzle-orm. Database.execute() returns unknown rows (generic HKT); use db.select({ n: sql<number>`...` }).from(sql`table`) for raw reads with types.

### For the human
- T-004 adds BAD_REF: a ref with a lone surrogate is rejected, since it goes into the hashed envelope as-is and would make entryHash throw. IDs can't hold one after T-001, so it's a fail-closed backstop. Also BAD_INPUT for an entry that isn't the right shape at all.

## T-005
packages/ledger/test/tamper.test.ts: brief 11 tamper suite. On PGlite, raw SQL with the trigger disabled edits, re-hashes, deletes, swaps and re-spaces rows; each case asserts the exact [seq, problem] list from verifyLog (page sizes 2 and 500), then restores the rows, re-enables the trigger and checks verifyLog passes and UPDATE/DELETE fail again. No source changes were needed.
Gotcha: `ALTER TABLE audit_log DISABLE TRIGGER audit_log_append_only` works in PGlite; the suite re-enables it in afterEach so a failing case cannot leave the table writable.

## T-006
apps/gate/src/record.ts: recordDecision(db, { proposal, principal, mandate, decided }) -> { ok, mandateSeq, mandateEntry (null when already logged), decision } | { ok: false, problem: "MANDATE_VERSION_CONFLICT" | AppendRejectionCode, detail }. One withAuditLog transaction: looks up the mandate.version entry by ref `<id>@v<version>` (mandateRef), compares the logged payload's hash, appends it if absent (at = decidedAt), then the decision entry. Also exports PROPOSAL_TEXT_LIMIT and proposalText. @countersign/db now also re-exports `and` and `eq`.
Gotchas: the proposal text is JSON.stringify of the parsed proposal (so a lone surrogate is stored escaped, as `\ud800`). recordDecision records one proposal per transaction; for T-008, a MANDATE_VERSION_CONFLICT surfaces on a case file's first proposal, since every proposal in a file shares one mandate, so nothing from the file is written. ChainVerdict uses `intact`, not `ok`. The test's source check walks decide.ts's relative imports and bans db/ledger/drizzle/pglite/postgres.

### For the human
- T-006: a proposal JSON.stringify can't serialize (BigInt, a cycle, undefined) is recorded as String(proposal), or "" if that throws too, so recording never fails on content. Proposals reach the gate as parsed JSON, so this shouldn't happen in practice.
- T-006: recordDecision throws (a programming error, not a reported problem) when the mandate passed in isn't the one in the decision record (id, version or hash differ).

## T-007
packages/ledger/src/cli.ts runLedgerCli(args, env) -> { exitCode, stdout, stderr } (verify: 0 intact / 1 broken / 2 no database; tail [count]), entry ledger-main.ts. packages/db/src/target.ts: DEFAULT_PGLITE_DIR, resolveDatabaseTarget(env, pgliteDir), takePgliteOption(args), targetName, redactSecrets, failureReason, openFailure ("Couldn't open the database at DATABASE_URL: <reason>"). packages/db/src/migrate-cli.ts runMigrateCli(args, env), entry migrate-main.ts. client.ts gains hasAuditLogTable(db) and openPgliteDirectory/openDatabase(target, { migrate?: false }). Root scripts ledger and db:migrate; .countersign/ ignored.
Gotchas: tests must pass env explicitly ({} or a copy of process.env without DATABASE_URL), since a cloud session may have DATABASE_URL set. For T-008, reuse takePgliteOption/resolveDatabaseTarget/openFailure/redactSecrets from @countersign/db so decide --record opens the same database and scrubs errors the same way. Node prints ".env.local not found. Continuing without it." on stderr under --env-file-if-exists when the file is missing; that's Node, not our output. An empty DATABASE_URL counts as unset.

### For the human
- T-007: CLI counts are pluralised ("1 entry", "1 problem", "Applied 1 migration."), otherwise the wording is exactly the requirements'. `tail` prints a heading "Last N entries of M." and "The audit log has no entries." on an empty log; the requirements don't fix tail's wording.
- T-007: DATABASE_URL wins even when `--pglite <dir>` is also given (the requirements' order), so `--pglite` is silently ignored then. Overturn if you'd rather refuse both together.
