# Tech stack

Derived from brief §8–§9 and ADRs 0001–0017 in `docs/adr/`. The ADR wins if one is more specific than this file. A change to anything here needs a new ADR.

## Runtime and tooling

| Area | Choice | ADR |
|---|---|---|
| Runtime | Node 26. `.node-version` contains `26`; root `engines.node` is `">=26.7.0 <27"` | 0008 |
| Package manager | npm 11 workspaces (`apps/*`, `packages/*`), no Turborepo. Root `packageManager: "npm@11.19.0"`. Commit the lockfile; CI and Render use `npm ci` | 0009 |
| Language | TypeScript 5.9.3, strict, ESM everywhere (`"type": "module"`) | 0004 |
| Running TS | tsx runs services and scripts from source in dev and on Render. Packages have no build step and export `./src/index.ts` | 0007 |
| Lint and format | Biome only, from one root `biome.json` | 0005 |
| Tests | Vitest 4 with one root config and `test.projects`. PGlite stands in for Postgres. Playwright runs browser and hosted smoke tests | 0012, 0003 |

## Pinned versions

Pin exact versions with no `^` or `~`. The loop can't install packages, so new dependencies are added by the human during the feature spec phase.

| Package | Version | Where |
|---|---|---|
| typescript | 5.9.3 | all workspaces |
| @types/node | 26.6.5 | all workspaces |
| tsx | 4.23.15 | `dependencies` of each Node service |
| zod | 4.6.7 | root, shared |
| @modelcontextprotocol/sdk | 1.32.1 | gate, resolve-agent |
| express | 5.3.0 | gate |
| drizzle-orm / drizzle-kit | 0.45.4 / 0.31.11 | packages/db |
| postgres | 3.4.9 | packages/db (Render, Postgres 18) |
| @electric-sql/pglite | 0.5.10 | packages/db (tests) |
| @google/genai | 2.27.0 | resolve-agent; console (mandate compiler and Risk desk server routes) |
| @paypal/mcp / @paypal/agent-toolkit | 1.8.1 / 1.11.0 | `apps/baseline-paypal-mcp` only |
| next | 16.4.2 | console, storefront |
| react / react-dom | 19.3.1 | console, storefront |
| ag-studio / ag-studio-react | 3.0.0 | console |
| ag-grid-community / ag-grid-react | 36.2.0 | console |
| tailwindcss / @tailwindcss/postcss | 4.3.3 | console, storefront, packages/graphite |
| lucide-react | 1.58.0 | console, storefront |
| @biomejs/biome | 2.5.15 | root |
| vitest | 4.1.12 | root |
| @playwright/test | 1.64.1 | root |

Next.js and React stay on versions with the October 2026 security fixes (ADR 0010). Check for Next.js security releases weekly until 22 Dec.

## Project layout

```text
apps/
  gate/                 Express 5 + MCP v1 (stateless Streamable HTTP): /mcp, approval API, PayPal webhooks, Daraja callbacks
  console/              Next.js: inbox, approvals page, audit console, Risk desk (AG Studio), mandate editor, bench, judge path
  resolve-agent/        Gemini harness for Resolve (our own function-calling loop); protected mode talks to the gate, baseline mode to baseline-paypal-mcp
  baseline-paypal-mcp/  Isolated workspace holding @paypal/mcp + agent-toolkit; nothing imports it, it's spawned over stdio
  storefront/           Next.js Kikapu shop on PayPal JS SDK v6, plus the seed script
packages/
  mandate/              Mandate schema, rule evaluator, compiler prompt
  verifiers/            Pure verifier functions over record snapshots, with fixtures
  rail-paypal/          OAuth token cache, REST client, webhook signature verification
  rail-mpesa/           Daraja client, callback parsing, receipt store
  ledger/               Hash chain, `ledger verify`, evidence export
  db/                   Drizzle schema, migrations, postgres.js and PGlite clients
  graphite/             Graphite tokens (byte-identical copy), Tailwind theme, AG Studio theme
  carrier-mock/         Shipment status adapter
bench/                  cases/, runner, results/ (committed, dated)
docs/                   adr/, spikes.md, validation.md, threat model, architecture, judge guide
Graphite Design/        The design system source (DESIGN.md, graphite-tokens.css). Don't edit it from app work
specs/                  Brief, constitution, feature specs
```

## Conventions

**Decisions and safety**
- `packages/mandate`, `packages/verifiers` and `packages/ledger` never import an AI SDK. A test fails if they do.
- Verifiers are pure functions over record snapshots and return `pass`, `fail` or `unknown`. All I/O lives in the rail packages and the gate.
- An allow is only possible through a matched rule whose requirements all pass. Every other path ends in deny or step-up (brief §8).
- Money is an integer count of minor units plus an ISO currency code. Never use floats. Convert to a rail's own format only inside that rail's client.
- The intent hash is SHA-256 over an RFC 8785 canonical JSON serialization. Store exactly the bytes you hashed, and never re-hash jsonb read back from Postgres (ADR 0003).
- Audit-log appends take `pg_advisory_xact_lock` inside one READ COMMITTED transaction. `seq` is the primary key and `prev_hash` is unique (ADR 0003).
- Idempotency: `PayPal-Request-Id` is the intent hash, and `sender_batch_id` is the intent ID. Daraja calls are deduplicated in the audit log first.

**Code**
- Validate every external input with zod 4: MCP arguments, webhooks, callbacks, env.
- Import workspace packages by name (`@countersign/<name>`), never with relative paths across workspaces. Next apps list them in `transpilePackages`.
- tsconfig base: `module: preserve`, `moduleResolution: bundler`, `noEmit`, `strict`, `isolatedModules`, `verbatimModuleSyntax`, `erasableSyntaxOnly`. No enums and no `paths`.
- Server code detects the browser with `typeof window`, never `localStorage`, because Node 26 defines it (ADR 0008).

**UI (Graphite)**
- Every screen uses `@countersign/graphite`: Tailwind v4 restricted to Graphite semantic tokens, so classes equal token names (`bg-container`, `text-secondary-foreground`). Tailwind's default palette is removed (ADR 0006).
- No raw hex colors, no emojis, Lucide icons only. Light is the default and dark must work.
- Load fonts with DESIGN.md's Google Fonts link, not `next/font`.
- A Vitest design check (`packages/graphite/test/design-check.test.ts`) fails on raw hex or color functions, emojis, default Tailwind palette classes, palette steps in app code, drift between `packages/graphite/graphite-tokens.css` and `Graphite Design/graphite-tokens.css`, or a semantic token missing from `packages/graphite/tailwind.css`. It has no per-line escape.

**AI calls** (ADRs 0013–0017)
- Product AI uses the Gemini Developer API through `@google/genai`, constructed as `new GoogleGenAI({ apiKey: env.GEMINI_API_KEY, vertexai: false })`. Call `ai.models.generateContent`. Never use automatic function calling, `mcpToTool`, `ai.chats` or the Interactions API.
- Every role reads its model from `GEMINI_MODEL` (default `gemini-3.5-flash-lite`; exact IDs only, never `-latest`), and records `modelVersion` from every call. Always set `thinkingConfig.thinkingLevel`: `MEDIUM` for the agent, `HIGH` for the compiler, `LOW` for the Risk desk. Never send `thinkingBudget`, `MINIMAL`, `temperature`, `topP` or `topK`.
- Declare tools with sanitized `parametersJsonSchema` and `functionCallingConfig.mode: VALIDATED`. For JSON, use `responseMimeType: "application/json"` with `responseJsonSchema` from `z.toJSONSchema`, then validate the result with zod.
- Fail closed. Before reading content, require no `promptFeedback.blockReason`, a candidate, `finishReason === "STOP"` and content parts. Anything else ends the run, and no tool call from that response runs (ADR 0015). Set all five adjustable safety categories, including `HARM_CATEGORY_JAILBREAK`, to `OFF`.
- The SDK retries 408 and 5xx responses; our code handles 429. Fall back to `GEMINI_FALLBACK_MODEL` (default `gemini-3.1-flash-lite`) only between ticket runs, never mid-loop.
- Keep the system instruction and tool declarations byte-stable and the history append-only, so implicit caching hits. No explicit caches.
- Resolve's harness is our own function-calling loop over an MCP v1 client in both modes (ADRs 0011, 0014). The Risk desk calls Gemini from a console server route, never from the browser (ADR 0016).
- Recheck these API details against current docs at spike S8.

**Secrets and environment**
- Real values live only in `.env.local` (git-ignored) and on Render. `.env.example` lists the names.
- Load env with `tsx --env-file=.env.local`. Never print, log or commit a secret.
- Unit tests never need credentials. Tests that hit live sandboxes run only under `LIVE=1` and are not part of the Feedback commands.

**Git**
- Conventional commit messages (`feat(T-012): …`, `docs: …`, `chore: …`), one ticket per commit, one feature per branch.
- Commits belong to the owner. Never add Claude attribution (see `CLAUDE.md`).

## Feedback commands

Each runs from the repo root and must pass on a clean checkout. All four have passed since the scaffold (roadmap phase 1). `npm run format` (`biome check --write .`) fixes formatting and import order.

| Check | Command |
|---|---|
| Typecheck | `npm run typecheck` (each workspace runs `tsc --noEmit`; Next apps run `next typegen && tsc --noEmit`) |
| Lint | `npm run lint` (`biome check .`) |
| Test | `npm test` (`vitest run`, which includes the Graphite design check) |
| Build | `npm run build` (the Next apps build; the other workspaces have no build step) |

## Hosting (Render)

- **Web services:** gate, resolve-agent, console and storefront, all on paid plans from creation.
- **Database:** Postgres 18 on a paid plan. Migrations run as the pre-deploy command.
- **Cron jobs:** reconciliation and the daily hosted smoke test.
- Each service binds to `0.0.0.0` and reads `PORT`.
- Render installs Node from `.node-version`. Spike S7 confirms it picks 26.x; if not, fall back to 24 (ADR 0008).
