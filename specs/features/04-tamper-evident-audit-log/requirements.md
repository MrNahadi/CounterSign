# Phase 4 requirements: tamper-evident audit log

Brief §5 item 5, §6 step 6, §8 (no AI, fail closed, no secrets), §11 (the tamper test), §12 (`ledger verify` passes on the hosted database). Design baseline: original brief §12 (the `audit_log` columns, tamper evidence). Format: ADR 0022. Versions: ADR 0021. Storage and locking: ADR 0003. Where this file and the brief disagree, the brief wins.

## Behaviour

### What an entry is

- The audit log is one table, `audit_log`, with one row per entry:

| Column | Holds |
|---|---|
| `seq` | The entry's position, from 1, with no gaps. Primary key |
| `entry_type` | One of the known entry types |
| `ref_id` | What the entry is about, such as an intent ID. Nullable |
| `at` | When it happened, as the ISO 8601 string that was hashed (the shared timestamp rule from phase 3) |
| `payload` | The payload's canonical JSON (RFC 8785), exactly the text that was hashed. Text, never jsonb |
| `prev_hash` | The previous entry's hash, or the genesis value (64 zeros) for entry 1. UNIQUE |
| `hash` | SHA-256, in lowercase hex, of the canonical JSON of `{ seq, entryType, refId, at, prevHash, payload }`, where `payload` is the payload value. UNIQUE |

- Phase 4 knows two entry types:
  - `mandate.version`, with ref `<mandate id>@v<version>`, such as `kikapu-studio@v3`. Its payload is `{ mandate, hash }`: the mandate as parsed, and its hash from `hashMandate`.
  - `decision`, with ref the intent ID, or null when the proposal never became an intent. Its payload holds:
    - `principal`;
    - `mandateSeq`, the `seq` of the `mandate.version` entry the decision used;
    - `proposal`, the raw proposal's JSON text, at most 16,384 characters, and `proposalTruncated`, true when it was cut;
    - `record`, phase 3's decision record;
    - `response`, the agent response.

  Later phases add their own entry types. An entry type the ledger doesn't know is never appended.
- **Preparing a payload never fails on content.** Every string in it, keys included, is made well-formed: a lone surrogate becomes U+FFFD. Fields that are absent are left out, never written as null. Cutting the proposal text never splits a surrogate pair. Only a number that isn't a safe integer, or a value JSON can't hold, can make preparation fail. Phase 3's shapes contain neither.

### Appending

- An append takes an entry type, a ref, a time and a payload. It returns the stored entry, with its `seq` and hash.
- Appends run in one READ COMMITTED transaction:
  1. take `pg_advisory_xact_lock` on one fixed key;
  2. read the tail;
  3. compute the hash;
  4. insert at the tail's `seq` + 1 (ADR 0003).

  Several appends can share one transaction and one lock, so related entries are written together or not at all.
- An append is rejected, with nothing written, when:
  - the entry type is unknown;
  - the time doesn't pass the shared timestamp rule;
  - the payload can't be prepared.
- The table enforces the chain itself:
  - a second row with the same `seq` fails (primary key);
  - a row whose `prev_hash` another row already has fails, so the chain can't fork (UNIQUE);
  - every UPDATE and DELETE on `audit_log` is rejected by a trigger, whoever runs it;
  - TRUNCATE is allowed, for the demo reset in phase 13. The chain then starts again from genesis.

### Recording a decision

- `recordDecision` takes one decided proposal: the raw proposal, the principal, the mandate, and phase 3's `Decided`. In a single transaction under the lock, it:
  1. finds the `mandate.version` entry for the mandate's ID and version;
  2. appends one if there's none;
  3. appends the `decision` entry, pointing at the mandate entry's `seq`.

  The `decision` entry's `at` is the decision record's `decidedAt`.
- If the mandate's ID and version are already logged with a different hash, nothing is written. `recordDecision` reports `MANDATE_VERSION_CONFLICT`, naming the mandate, the version and both hashes. A signed version is immutable (brief §6), so a changed mandate under an old version number is never recorded as if it were the same.
- Every proposal is recorded, whatever it contains: an invalid proposal, an unknown tool, a fractional amount or a lone surrogate. The proposal text is what the agent sent, not what the gate made of it.
- The decision path stays pure. `decide()` is unchanged and still calls no database. Recording is a separate step that the caller runs after deciding.

### Verifying

- `verifyLog` re-walks the whole table in `seq` order, in pages, so a long log never loads at once. `verifyChain` does the same checks over a list of rows, with no database. Each row is checked for:

| Problem | When |
|---|---|
| `SEQ_GAP` | `seq` isn't the previous row's `seq` + 1, or the first row isn't 1 |
| `BROKEN_LINK` | `prev_hash` isn't the previous row's stored `hash`, or the genesis value for row 1 |
| `UNKNOWN_ENTRY_TYPE` | The entry type isn't one the ledger knows |
| `BAD_TIMESTAMP` | `at` fails the shared timestamp rule |
| `NOT_CANONICAL` | `payload` isn't valid JSON, or isn't byte-for-byte its own canonical JSON |
| `HASH_MISMATCH` | The hash recomputed from the row's columns isn't its stored `hash` |

- Verification reports every bad row, with its `seq`, the problem and a one-line detail. After a bad row it carries on against the stored hashes, so one edited row is reported once, at its own `seq`, and its neighbours stay clean.
  - An edited row whose hash was recomputed shows as `BROKEN_LINK` on the next row.
  - A deleted row in the middle shows as `SEQ_GAP` and `BROKEN_LINK`.
  - Two swapped rows show at both positions.
- Verification never throws on what it reads. A malformed row is a reported problem, not a crash.
- An intact log reports its entry count and its head: the last `seq` and hash. An empty log is intact, with no entries and the genesis hash as its head.
- A hash chain can't show that rows were cut off its end. The head is printed so it can be compared with a copy kept elsewhere. The README says so in plain words.

### The CLIs

- `npm run ledger -- verify` checks the log. Exit codes:
  - 0 when it's intact. It prints "Audit log intact: N entries. Head #N <hash>."
  - 1 when it's broken. It prints "Audit log broken: K problems in N entries.", then one line per problem: `#<seq> <PROBLEM> <detail>`.
  - 2 when the database can't be opened, or has no `audit_log` table.
- `npm run ledger -- tail [count]` prints the last entries, 10 by default: each one's `seq`, time, entry type, ref and the first 12 characters of its hash. The exit code is 0, or 2 as above.
- `npm run db:migrate` applies the migrations to the database the CLIs would open, and says how many it applied.
- `npm run decide -- <case file> --record` decides as in phase 3, prints the same output, then records every proposal in the case file. It ends with "Recorded N entries. Head #S <hash>." It works with `--json` too, and then the summary goes to stderr, so stdout stays valid JSON. A `MANDATE_VERSION_CONFLICT` exits 2 with one line that names it, and nothing from that case file is recorded.
- **Which database:** `DATABASE_URL`, through postgres.js, when it's set. Otherwise a PGlite directory, `.countersign/pglite` from the repo root, or the one named with `--pglite <dir>`. Git ignores `.countersign/`.
  - Opening a PGlite directory runs the migrations first.
  - `DATABASE_URL` is migrated only by `npm run db:migrate`. On Render that's the pre-deploy command.
- Root scripts load env with `--env-file-if-exists=.env.local`.
- No output or error message ever contains `DATABASE_URL`, a password or any other secret. A connection failure reads "Couldn't open the database at DATABASE_URL: <reason without the URL>".

## Constraints

- No AI in the decision path. `@countersign/ledger` imports no AI SDK; the existing repo test covers it.
- `@countersign/db` holds the schema, the migrations and the clients, and nothing about hashing. `@countersign/ledger` holds the chain, appending, verifying and its CLI. Hashing uses `canonicalJson` and `sha256Canonical` from `@countersign/mandate`, and never a second implementation.
- Never compute a hash from jsonb, or from JSON that was parsed and re-serialized in a different form. Verification re-parses the stored text only to check that it's canonical. The hash it recomputes covers the stored text's own value.
- Money stays integer minor units inside payloads. That already holds for every phase 3 shape.
- Validate every external input with zod 4: CLI arguments, `DATABASE_URL`'s presence, and rows read back from the database before they're checked.
- One migrations folder in `packages/db`, generated by `drizzle-kit generate` (ADR 0003). The trigger SQL is added by hand at the end of the first migration, before it's applied anywhere. After that, `npm run db:generate` reports no changes.
- Tests use in-memory PGlite. They need no Docker, network, secret or `.env.local`. A test that needs a real Postgres runs only under `LIVE=1` with `DATABASE_URL` set, and works in its own throwaway schema that it drops afterwards. It never touches existing tables.
- Words in CLI output follow the brand book: plain and short, no exclamation marks.

## Technical needs

- Drizzle 0.45 API: `drizzle({ client })`, and `migrate(db, { migrationsFolder })` from `drizzle-orm/pglite/migrator` and `drizzle-orm/postgres-js/migrator` (ADR 0003). `bigint` columns use number mode, since `seq` stays far below 2^53.
- The advisory lock key is one fixed bigint constant, exported by the ledger, so later phases' appends share it.
- `CONTEXT.md` already holds this phase's terms (audit-log entry, entry type, chain head, genesis hash). Keep them in step with the code.
- `tech-stack.md` already lists the pinned versions and the `.countersign/` folder.
