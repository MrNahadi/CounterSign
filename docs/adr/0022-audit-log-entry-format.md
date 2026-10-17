# 0022. The audit log's entry format: one table, canonical text payloads, an envelope hash, append-only by trigger, and the proposal kept as text

Status: accepted
Decided-by: autopilot (delegated), phase 4 feature spec, 17 Oct 2026, under brief §14 v1.4. The answerer's rules escalate it, because a stored data format is expensive to reverse. The owner can overturn it (`.ralph/human.md`, Decided for you)
Question: Phase 4 builds the hash-chained audit log. What does a row hold, what exactly is hashed, which entries does phase 4 write, how is the table protected, and what does `ledger verify` promise?
Decision:
- **One table, `audit_log`,** with the columns from original brief §12: `seq` (bigint, primary key, from 1), `entry_type`, `ref_id` (nullable), `at`, `payload`, `prev_hash` (UNIQUE) and `hash` (UNIQUE). Phase 4 adds no other tables. Intents, decisions and approvals live inside entry payloads until a later phase needs a table to query.
- **The payload is stored as text: the exact canonical JSON (RFC 8785) that was hashed.** It's never stored as jsonb, which reorders keys (ADR 0003). `at` is stored as the ISO 8601 string that was hashed.
- **The entry hash** is the SHA-256, in hex, of the canonical JSON of the envelope `{ seq, entryType, refId, at, prevHash, payload }`, where `payload` is the payload value itself. The first entry's `prevHash` is the genesis value, 64 zeros.
- **Recording never fails on content.** Before hashing, every string in a payload is made well-formed: a lone surrogate becomes U+FFFD. Fields that are absent are left out, never written as null.
- **Phase 4 writes two entry types:**
  - `mandate.version`: ref `<mandate id>@v<version>`, with the mandate and its hash. It's written once per version, the first time a decision uses it. If a version is already logged with a different hash, recording is refused and nothing is written.
  - `decision`: ref the intent ID, or null when the proposal never became an intent. It holds the principal, the decision record, the agent response, the `seq` of the mandate entry, and the raw proposal.
  - The raw proposal is kept as its JSON text, cut at 16,384 characters with a `proposalTruncated` flag. That way a proposal canonical JSON can't hold, such as one with a fractional amount, is still recorded exactly as the agent sent it.
  - Later phases add their own types, such as approvals in phase 9, executions and reconciliations in phase 6.
- **Appends run under the advisory lock from ADR 0003.** A mandate entry and the decision that uses it are written in one transaction.
- **Append-only in the database:** a trigger rejects every UPDATE and DELETE on `audit_log`. TRUNCATE stays possible for the demo reset (phase 13), and the chain then starts again from genesis.
- **What `ledger verify` promises.** It re-walks the whole chain in `seq` order, checking each row's sequence, link, entry type, timestamp, canonical payload and hash. It reports every bad row by `seq` and goes on checking the rows after it. It prints the head (the last `seq` and hash) on success.
  - A hash chain can't show that rows were cut off the end. The head is printed so it can be compared with a copy kept elsewhere, and the threat model says so.
- **Where the CLIs find the log:** `DATABASE_URL` (postgres.js) when it's set, otherwise a local PGlite directory, `.countersign/pglite`, which git ignores. The connection string is a secret and is never printed.
Basis:
- Brief §5 item 5 ("every proposal, decision, verifier trace and rail response in a tamper-evident audit log, check the hash chain"), §6 step 6, §8 (no AI; fail closed), §10 trade-offs 1 and 2 (safety, honest evidence), and §12 (`ledger verify` passes on the hosted database).
- Original brief §12: the `audit_log` columns, and "each audit-log entry hashes the one before it; `ledger verify` re-walks the chain".
- ADR 0003 (advisory lock, UNIQUE `prev_hash`, store exactly what was hashed, no jsonb re-hashing), ADR 0019 (canonical JSON in `@countersign/mandate`; ledger depends on mandate) and ADR 0020 (hashes keep their bytes).
- RFC 8785 requires I-JSON, which forbids lone surrogates, so `canonicalJson` throws on them: https://www.rfc-editor.org/rfc/rfc8785
- PostgreSQL row-level triggers don't fire on TRUNCATE: https://www.postgresql.org/docs/current/sql-createtrigger.html
- Checked with the pinned versions on 17 Oct 2026 (ADR 0021).
Consequences:
- Tamper tests have to disable the trigger before editing a row, which is exactly what an attacker with owner rights would do. `ledger verify` is what catches them.
- Phase 6 reads executions back from the log as `ExecutionSnapshot`s, for `ledger.not_duplicate` and today's usage. Phase 10's console reads payloads as text and parses them for display only. Neither ever re-hashes parsed JSON.
- The raw proposal can hold customer text and emails. It's merchant-only, like the decision record, and public pages mask it (ADR 0020, phase 15).
- Changing the envelope or the payload shapes after the first hosted entries exist means a new entry type or a versioned envelope, never a rewrite of old rows.
