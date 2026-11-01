# 0047. A local launcher shares one database handle between Gate and Resolve

Status: accepted
Decided-by: autopilot (delegated)
Question: How can the project run locally without a separate Postgres installation?
Decision: `npm run dev` runs Gate and Resolve in one Node process with one database handle,
and starts the two Next apps as child processes. Resolve accepts a supplied handle without
closing its owner's connection. Production service startup is unchanged.
Basis: The owner requested local setup before phase 14. `packages/db/src/target.ts` already
provides a repository-local PGlite fallback, and Gate's app already accepts a database.
PGlite's directory must have one owner; launching independent backends against it does not
provide a shared application connection. See `packages/db/src/client.ts` and
`apps/resolve-agent/src/serve.ts`.
Consequences:
- The launcher migrates the selected database, binds all apps to loopback, checks ports,
  sets local service addresses, and stops its child processes together.
- Local setup generates missing access keys in ignored `.env.local` without printing them.
  The launcher loads existing `.env` as a fallback, followed by `.env.local`; shell values win.
- There are no new dependencies. PayPal/Gemini calls and sandbox seeding are never automatic.
- Database CLIs must run while the PGlite launcher is stopped. Use Postgres for independent
  concurrent processes. Backend edits require a launcher restart; Next pages reload normally.
- Next's Turbopack CSS worker failed on Windows both inside and outside the agent sandbox.
  Windows dev/build uses the documented `--webpack` option; Linux/Render keeps its existing
  default. The storefront's browser code imports the pure `@countersign/mandate/money`
  subpath, avoiding the server-only hashing module that Webpack otherwise traverses.
