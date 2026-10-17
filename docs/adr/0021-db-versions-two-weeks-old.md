# 0021. Database packages pin drizzle-orm 0.45.3 and PGlite 0.5.8, the newest releases at least two weeks old

Status: accepted, amends ADR 0003's pinned versions
Decided-by: autopilot planner, phase 4 feature spec, 17 Oct 2026 (researched; a technical question inside the answerer's remit)
Question: Phase 4 installs the database packages ADR 0003 names. ADR 0003 pinned `drizzle-orm` 0.45.4 and `@electric-sql/pglite` 0.5.10, but the autopilot installs only versions at least two weeks old. Which versions do we pin?
Decision:
- `drizzle-orm` **0.45.3** (published 21 Sep 2026). 0.45.4 came out on 8 Oct, nine days before planning.
- `@electric-sql/pglite` **0.5.8** (published 26 Aug 2026). 0.5.9 and 0.5.10 came out on 12 and 14 Oct.
- `drizzle-kit` **0.31.11** (21 Sep 2026, released with drizzle-orm 0.45.3) and `postgres` **3.4.9** (5 Apr 2026) stay as ADR 0003 pinned them.
- Runtime packages go in `@countersign/db`'s `dependencies`, and `drizzle-kit` in its `devDependencies`.
Basis:
- npm registry publish times, read on 17 Oct 2026 with `npm view <pkg> time --json`.
- A probe on 17 Oct 2026 with these exact versions on Node 26.7.0: PGlite 0.5.8 reports "PostgreSQL 18.3", matching Render's Postgres 18. Inside a Drizzle transaction, `pg_advisory_xact_lock` runs. A UNIQUE `prev_hash` rejects a forked insert. A `BEFORE UPDATE OR DELETE` trigger rejects edits until it's disabled. `drizzle-orm/pglite/migrator` and `drizzle-orm/postgres-js/migrator` both export `migrate`.
- `npm audit` after the install: drizzle-orm, postgres and PGlite add no advisories. drizzle-kit pulls in an old esbuild (0.18) through `@esbuild-kit`, flagged moderate for esbuild's dev server (GHSA-67mh-4wv8-2f99). drizzle-kit only generates migrations at dev time and never starts that server.
Consequences:
- The code targets the 0.45 API, as ADR 0003 says: `drizzle({ client })` and `migrate(db, { migrationsFolder })`.
- Moving to drizzle-orm 0.45.4 or PGlite 0.5.10 later is a patch bump once they're two weeks old (from 22 and 28 Oct). It needs no new ADR, only a line in `tech-stack.md`.
