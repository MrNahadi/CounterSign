# Phase 4 plan: tamper-evident audit log

Roadmap item 4, brief §5 item 5. Every intent and decision is appended to a hash-chained log. `ledger verify` passes, and fails on any edited row. Nothing here executes money or calls a rail. Executions and their reconciliation join the log in phase 6, approvals in phase 9, and the console's view and evidence export in phase 10.

## Approach

```text
decide() ─▶ decision record + agent response          (phase 3, unchanged)
                 │
recordDecision ──┴─▶ one transaction, under the advisory lock (ADR 0003)
                       ├─ mandate.version entry, the first time this version is used
                       └─ decision entry: proposal text, record, response, principal
                                │
                 audit_log: seq │ entry_type │ ref_id │ at │ payload (canonical text) │ prev_hash │ hash
                                │
ledger verify ─▶ re-walks the chain in seq order ─▶ intact + head, or every bad row by seq
```

The format follows ADR 0022:

- Each row's hash is the SHA-256 of its envelope's canonical JSON: `seq`, entry type, ref, time, previous hash and payload.
- Payloads are stored as the exact canonical text that was hashed, never as jsonb.
- A trigger rejects every UPDATE and DELETE.
- The chain logic is pure and has no database, so the tamper cases can be tested on plain rows as well as on a real table.

## Modules touched

| Module | What it gains |
|---|---|
| `packages/mandate` | IDs that hold a lone surrogate are rejected, so `decide` can't throw inside `hashIntent` (T-001) |
| `packages/db` | The `audit_log` Drizzle schema. The first migration, including the append-only trigger. `drizzle.config.ts`. An in-memory PGlite client for tests, a PGlite directory client for local use, a postgres.js client for `DATABASE_URL`, and one way to open whichever applies and run migrations |
| `packages/ledger` | Entry types; the genesis hash; payload preparation (well-formed strings, canonical text); the entry hash; `verifyChain` over rows; appending under the advisory lock; `verifyLog` over the table; the `ledger` CLI (`verify`, `tail`) |
| `apps/gate` | `recordDecision`, which writes the mandate and decision entries for one decided proposal. The decide CLI's `--record` flag |
| root | `db:generate`, `db:migrate` and `ledger` scripts. `.countersign/` in `.gitignore`. README sections |

`packages/verifiers`, `packages/rail-*`, `packages/carrier-mock` and the Next apps stay untouched.

## Order of work

1. T-001 (lone surrogates) and T-003 (the pure chain) need nothing else, so the loop can take them first.
2. T-002: the table, its migration and the clients.
3. T-004: appending and verifying against the table. It needs T-002 and T-003.
4. In any order after T-004:
   - T-005: the tamper suite;
   - T-006: recording decisions;
   - T-007: the `ledger` CLI;
   - T-009: the live Postgres check.
5. T-008: `decide --record` and the README, once T-006 and T-007 are done.

## New dependencies

Installed by the planner on 17 Oct 2026, with exact versions at least two weeks old (ADR 0021):

| Package | Version | Workspace |
|---|---|---|
| drizzle-orm | 0.45.3 | `packages/db` dependencies |
| postgres | 3.4.9 | `packages/db` dependencies |
| @electric-sql/pglite | 0.5.8 | `packages/db` dependencies |
| drizzle-kit | 0.31.11 | `packages/db` devDependencies |

New workspace links, already installed:

- `@countersign/ledger` depends on `@countersign/db` and `@countersign/mandate`.
- `@countersign/gate` depends on `@countersign/db` and `@countersign/ledger`.

zod 4.6.7 comes from the root. tsx is hoisted from the gate.

## Notes for the loop

- The loop may run `npm run db:generate`, but not `npx drizzle-kit` with other arguments. T-002 adds that root script.
  - The trigger SQL goes at the end of the first generated migration, before anything is applied anywhere, because drizzle-kit doesn't model triggers.
  - A second `npm run db:generate` must then report no schema changes.
- The loop can't run `npm run ledger` or `npm run decide`. Tests call the CLIs' exported run functions, and run one child process each with `node --import tsx`, as phase 3's decide CLI test does.
- Tests use in-memory PGlite, one fresh database per test file or per test. No test needs Docker, a network or a secret.
- The loop can't read `.env.example`, because a deny rule covers `.env.*`. Adding `DATABASE_URL` to it is in `.ralph/human.md`.

## Risks

- **PGlite has one connection, so tests can't produce real lock contention** (ADR 0003). Concurrent appends in PGlite still prove the code path and the UNIQUE backstop. T-009's `LIVE=1` test runs 20 concurrent appends over a real connection pool against `DATABASE_URL`. It waits for the Render database (`.ralph/human.md`).
- **Typing the decision record as JSON.** The record holds optional fields and readonly arrays. ADR 0022's rule (drop absent fields, make strings well-formed) is applied in one place, in the ledger's payload preparation, so the gate never hand-builds canonical JSON.
- **Cut-off tails.** A hash chain can't show that its last rows were deleted. `ledger verify` prints the head so a copy can be compared, and the README says so plainly (brief §10 trade-off 2).
