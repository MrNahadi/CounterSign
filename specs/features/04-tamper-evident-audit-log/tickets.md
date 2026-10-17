# Phase 4 tickets: tamper-evident audit log

## T-001: IDs with a lone surrogate are invalid, so decide never throws

Status: done
Tier: simple
Blocked by:
Slice: A `create_refund` proposal whose capture ID or ticket ID holds a lone surrogate is denied `INVALID_PROPOSAL`, instead of `hashIntent` throwing inside `decide`.
Test seam: `IdSchema` in `@countersign/mandate`, and the `decide` function in `apps/gate/src/`
Acceptance:
- [x] The shared ID rule rejects a string that isn't well-formed UTF-16, with a message that says so. Every parser that uses the shared ID schema (mandate, case file, proposal) gets the check with no change of its own
- [x] `decide` on a proposal whose `ticket_id` or `capture_id` holds a lone surrogate returns a denial `INVALID_PROPOSAL` and doesn't throw. Build the string with `String.fromCharCode(0xd800)` (phase 3 gotcha: the Write tool decodes `\u` escapes)
- [x] Every existing test passes unchanged
Notes: Found while planning phase 4. `canonicalJson` throws on lone surrogates (RFC 8785 requires I-JSON), and `IdSchema` let them through, which broke phase 3's "decide never throws on input that passed its schemas".

## T-002: The audit_log table, its migration and the database clients

Status: done
Tier: standard
Blocked by:
Slice: A fresh in-memory PGlite gets the `audit_log` table from the committed migration, and the table refuses a forked row, a repeated `seq`, and any UPDATE or DELETE.
Test seam: the exports of `@countersign/db`: the schema, the test-database factory, and the open-and-migrate function
Acceptance:
- [x] The Drizzle schema has `audit_log` with the columns, primary key and UNIQUE constraints in requirements.md. `payload` and `at` are text, and `seq` is a bigint in number mode
- [x] `packages/db/drizzle.config.ts` and a root `db:generate` script exist. The first migration was generated with `npm run db:generate`, and is committed with its meta files
- [x] The first migration ends with hand-added SQL: a trigger function and a `BEFORE UPDATE OR DELETE ... FOR EACH ROW` trigger on `audit_log` that raise "audit_log is append-only". Running `npm run db:generate` again reports no changes
- [x] The package exports a factory for a migrated in-memory PGlite, a client for a PGlite directory, and a postgres.js client for a connection string, all as Drizzle databases of one type
- [x] Tests on a fresh PGlite show that a repeated `seq` fails, a repeated `prev_hash` fails, UPDATE and DELETE fail with the trigger's message, and TRUNCATE works
Notes:

## T-003: The chain itself: entry hash, payload preparation and verifyChain

Status: done
Tier: standard
Blocked by:
Slice: Given plain audit-log rows, with no database, the ledger computes each entry's hash, prepares payloads into canonical text, and says whether the chain is intact, or names every bad row by `seq` and problem.
Test seam: the chain exports of `@countersign/ledger`: entry types, the genesis hash, payload preparation, the entry hash and `verifyChain`
Acceptance:
- [x] The entry hash is the SHA-256 of the canonical JSON of `{ seq, entryType, refId, at, prevHash, payload }`, using `@countersign/mandate`'s canonical JSON. A hand-written expected envelope string for one entry hashes to the same value
- [x] Payload preparation makes every string well-formed (a lone surrogate becomes U+FFFD), drops absent fields, and returns the canonical text. It reports, without throwing, a number that isn't a safe integer
- [x] `verifyChain` passes an empty list (head: the genesis hash) and a valid chain (head: the last `seq` and hash). It reports `SEQ_GAP`, `BROKEN_LINK`, `UNKNOWN_ENTRY_TYPE`, `BAD_TIMESTAMP`, `NOT_CANONICAL` and `HASH_MISMATCH` at the right `seq` for each tamper case in validation.md, check 4
- [x] An edited row is reported once, at its own `seq`. An edited row whose hash was recomputed shows as `BROKEN_LINK` on the next row. `verifyChain` never throws, even on a payload that isn't JSON
- [x] The entry types are `mandate.version` and `decision`, in one list that later phases extend
Notes:

## T-004: Append and verify against the table

Status: done
Tier: standard
Blocked by: T-002, T-003
Slice: Entries appended to a PGlite `audit_log` form a chain that `verifyLog` passes, even when 20 appends race. Bad input writes nothing.
Test seam: the append and `verifyLog` exports of `@countersign/ledger`, over a database from `@countersign/db`
Acceptance:
- [x] An append takes `pg_advisory_xact_lock` on the ledger's exported fixed key, reads the tail, and inserts at `seq` + 1, all in one transaction. Several appends can share one transaction
- [x] Three appends give `seq` 1 to 3, with entry 1 linked to the genesis hash, and `verifyLog` passes with head #3
- [x] Twenty concurrent appends on one PGlite give `seq` 1 to 20 with no gap, and `verifyLog` passes
- [x] An unknown entry type, a time that fails the shared timestamp rule, or a payload that can't be prepared is rejected, and the table is unchanged
- [x] `verifyLog` reads the table in `seq` order in pages (a test uses a page size smaller than the log), validates each row's shape with zod, and gives the same result as `verifyChain` over the same rows
Notes:

## T-005: The tamper test

Status: done
Tier: standard
Blocked by: T-004
Slice: On a real table, an attacker who disables the trigger and edits, re-hashes, deletes or swaps rows is caught by `verifyLog` at the right `seq`. That's brief §11's tamper test.
Test seam: `verifyLog` in `@countersign/ledger`, on a PGlite table edited with raw SQL
Acceptance:
- [x] With the trigger disabled, editing one row's payload gives `HASH_MISMATCH` at that `seq`, and nothing else
- [x] Editing a row's payload and recomputing its hash with the ledger's own function gives `BROKEN_LINK` at the next `seq`
- [x] Deleting a middle row gives `SEQ_GAP` and `BROKEN_LINK`. Swapping two rows' payloads is caught at both positions
- [x] Rewriting a payload into the same JSON value with different spacing or key order gives `NOT_CANONICAL`
- [x] Restoring the original row and re-enabling the trigger makes `verifyLog` pass again, and UPDATE fails once more
Notes:

## T-006: Record each decision in the audit log

Status: done
Tier: standard
Blocked by: T-001, T-004
Slice: After `decide()`, `recordDecision` writes the mandate's version entry (once per version) and the decision entry in one locked transaction. Recording beat 3 gives one mandate entry and five decision entries, and the chain verifies.
Test seam: `recordDecision` in `apps/gate/src/`, over a migrated in-memory PGlite, read back through the ledger's exports
Acceptance:
- [x] A decision entry's payload holds the principal, `mandateSeq`, the raw proposal's JSON text with `proposalTruncated`, the decision record and the agent response. Its ref is the intent ID, and its `at` is `decidedAt`
- [x] Recording beat 3's five proposals gives one `mandate.version` entry (ref `kikapu-studio@v3`, payload `{ mandate, hash }`) and five `decision` entries. Recording them again adds five decisions and no second mandate entry
- [x] A mandate changed under the same ID and version is refused with `MANDATE_VERSION_CONFLICT`, naming both hashes, and nothing is written
- [x] Proposals that never became an intent (invalid, unknown tool, fractional amount) are recorded with ref null and their text exactly as sent. A proposal text over 16,384 characters is cut, with `proposalTruncated` true
- [x] `decide()` is unchanged and imports no database or ledger code. A source check in the tests keeps it that way
Notes:

## T-007: The ledger CLI and db:migrate

Status: open
Tier: standard
Blocked by: T-004
Slice: `npm run ledger -- verify` says whether the audit log is intact and prints its head, or lists every problem. `npm run ledger -- tail` shows the last entries. `npm run db:migrate` prepares the database the CLIs open.
Test seam: the ledger CLI's exported run function, plus one child-process run of the real entry point with `node --import tsx`
Acceptance:
- [ ] `verify` exits 0 with "Audit log intact: N entries. Head #N <hash>." on an intact log, including an empty one. It exits 1 with "Audit log broken: K problems in N entries." and one `#<seq> <PROBLEM> <detail>` line per problem after a tamper. It exits 2 when the database can't be opened or has no `audit_log` table
- [ ] `tail [count]` prints the last entries (10 by default) with `seq`, time, entry type, ref and a 12-character hash prefix
- [ ] The database is `DATABASE_URL` when it's set, otherwise `--pglite <dir>` or `.countersign/pglite`. Opening a PGlite directory migrates it. `.countersign/` is in `.gitignore`
- [ ] Root scripts `ledger` and `db:migrate` exist and load env with `--env-file-if-exists=.env.local`. `db:migrate` reports how many migrations it applied
- [ ] With `DATABASE_URL` set to an unreachable dummy URL that holds a password, the CLI exits 2, and neither stdout nor stderr contains the URL or the password
Notes:

## T-008: decide --record, and the README

Status: open
Tier: simple
Blocked by: T-006, T-007
Slice: `npm run decide -- <case> --record` decides and then records every proposal. The README shows how to record a decision and check the log, and says what the chain can't show.
Test seam: the decide CLI's exported run function with `--record` and a temporary `--pglite` directory, then the ledger CLI's run function on the same directory
Acceptance:
- [ ] `--record` on beat 3, into an empty directory, prints phase 3's output and then "Recorded 6 entries. Head #6 <hash>.", and `ledger verify` on that directory exits 0
- [ ] With `--record --json`, stdout is still valid JSON, and the summary goes to stderr
- [ ] A `MANDATE_VERSION_CONFLICT` exits 2 with one line naming it, and nothing from that case file is recorded
- [ ] Phase 3's decide CLI tests pass unchanged without `--record`
- [ ] The README gains a "Check the audit log" section (record, tail, verify, and plain words on cut-off tails) and `DATABASE_URL` in its environment table
Notes:

## T-009: Live check: concurrent appends on real Postgres

Status: open
Tier: standard
Blocked by: T-005
Slice: Under `LIVE=1` with `DATABASE_URL` set, 20 concurrent appends over a real connection pool chain without a gap, which proves ADR 0003's advisory lock where PGlite can't.
Test seam: the append and `verifyLog` exports of `@countersign/ledger`, over `@countersign/db`'s postgres.js client
Acceptance:
- [ ] The test is skipped unless `LIVE=1` and `DATABASE_URL` are both set, so `npm test` never runs it
- [ ] It creates a throwaway schema with a random name, runs the migrations into it (Drizzle's migrations table included), and drops it afterwards, even when the test fails. It never touches existing tables
- [ ] Twenty concurrent appends over a pool of at least 5 connections give `seq` 1 to 20 with no gap, and `verifyLog` passes
- [ ] The test prints no connection string, and the skip message names only the variables it needs
Notes: The live run waits for the Render database (`.ralph/human.md`). The build is complete when the test is written, skips cleanly, and typechecks.
