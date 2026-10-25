# Phase 13: the hosted judge path

*   **Author:** autopilot planner (Elephant), for the owner (muigufarid@gmail.com)
*   **Status:** Draft
*   **Date:** 2026-10-25

--------------------------------------------------------------------------------

## Overview

Countersign has every PayPal beat of the demo working locally: Resolve's agent proposes through the gate (phases 7 and 8), step-ups go to a phone card (9), every decision shows claims beside records (10), disputes get an evidence pack (11) and the ops agent pays suppliers (12). Nothing is hosted yet. Brief §5 item 8 asks that a judge can "open the hosted URL, follow a 60-second guide, run the main scenarios from a scenario launcher, open the approvals page on their phone through a QR code, and reset the demo to the seed state", and item 18 that it keeps working on paid Render plans until 22 Dec. This phase is roadmap item 13 and gate G2: "the full PayPal demo path works end to end on the hosted URL."

No agent can deploy (there's no Render credential and no paid plan yet; brief §14 forbids the agent spending money). So this phase builds everything a deploy needs and proves it against fixtures: the Render blueprint, the demo reset, the scenario launcher and the guide. The owner deploys from `docs/hosting.md` and runs the live checks in `validation.md`.

Decisions behind this design: [ADR 0041](../../../docs/adr/0041-render-blueprint-four-services-a-private-resolve-internal-addresses-and-generated-keys.md) (Render), [ADR 0042](../../../docs/adr/0042-demo-reset-in-the-gate-clears-the-log-and-resolve-tables-replaces-only-touched-orders-and-keeps-the-run-cap.md) (the reset) and [ADR 0043](../../../docs/adr/0043-a-start-page-guides-judges-every-console-route-to-resolve-needs-the-sign-in-and-hosted-baseline-runs-only-the-demo-scenarios.md) (the start page, sign-in and hosted baseline). Exact behaviour, copy and answers are in [requirements.md](requirements.md); checks are in [validation.md](validation.md). Terms are in [CONTEXT.md](../../../CONTEXT.md).

## The Problem

Judges may test the demo themselves, and when they do the brief gives them five minutes (§3). Today a judge would need a terminal: scenarios run from `npm run resolve`, the seed from `npm run seed`, and there's no reset at all, so the second judge finds the first judge's refunds already spent. Run publicly as it stands, the console would also let anyone start Gemini runs and baseline runs (PayPal's toolkit with no gate) from an open inbox, against §8's "the public demo can't run up unbounded AI cost".

The proposal: one Render blueprint for the four services and the database; a start page that tells the story in a minute and runs the three demo scenarios with one tap each; a reset in the gate that clears the demo's records and replaces only the seeded orders that a scenario spent; the approvals sign-in in front of everything that spends AI calls; and baseline mode limited to the fixed scenarios on the hosted demo.

## Goals

*   **G-1 Deployable as code.** `render.yaml` describes the whole hosted demo (four services, Postgres 18, a reconcile cron) on paid plans with no secret in it, and a test pins it. Measured: `tests/render-blueprint.test.ts` passes.
*   **G-2 A judge needs no terminal.** From `/`, a signed-in judge runs the attack email (baseline or protected), the stalled parcel and the damaged basket, opens Approvals on a phone by QR, and resets. Measured: the console view-model and route tests; manual check 5 on Render.
*   **G-3 Reset restores the seed state in ≤ 60 seconds** (brief §11, §12). Measured: `reset-live.test.ts`'s `took_ms` for a full 30-order seed (live), and only touched orders replaced on later resets (unit tests).
*   **G-4 Reset never weakens a guarantee.** It runs only on a database flagged as a demo, only for the approver key, never while Resolve or an execution is mid-flight, records where the old log ended, leaves a chain `ledger verify` passes, and never raises the day's run cap. Measured: the reset unit tests in `validation.md` check 4.
*   **G-5 Nothing public spends AI or touches baseline without the approver key**, and on the hosted demo no visitor-written text reaches baseline mode. Measured: console route tests (401 signed out) and Resolve's `RESOLVE_BASELINE` tests.

## Non-Goals

*   **Deploying.** The owner creates the blueprint, pays for plans, enters secrets and registers the webhook (`.ralph/human.md`). No agent calls Render.
*   **"Attack it yourself"** (phase 15): free-text messages from visitors, the per-session rate limit and the visitor money counter.
*   **The smoke test and uptime monitor** (phase 19). The blueprint leaves room for them.
*   **The dispute beat in the launcher.** Disputes are opened ahead of judging (brief §5 cut lines) and appear on the Disputes page; the reset records them again.
*   **Payouts in the launcher.** The ops agent stays the stand-in CLI (ADR 0039); a console that held the ops key would be a second agent.
*   **The README's judge guide** (phase 20). This phase writes `docs/judge-guide.md` for it to lift.
*   **More than one instance per service.** The reset's single-flight and the in-flight execution count are in-process (ADR 0042).

## Open Questions

*   **No fresh sessions were available to the planner.** The planner session couldn't start the `answerer` agent or a Goldfish sub-agent, so ADRs 0041 to 0043 carry the planner's own strongest counter-argument. Round A's Design Critic should treat all three decisions as contested.
*   **Render's private network from a cron job.** The cron job reaches Resolve through `RESOLVE_AGENT_HOSTPORT` for the dispute nudge. If Render cron jobs can't reach a private service, the nudge fails and the sync line says so; nothing else depends on it (ADR 0035). Live check 9 confirms it.
*   **Full-seed timing.** Phase 5 never measured a live 30-order seed. If the first reset on an empty database takes over 60 seconds, G-3 still holds for every later reset (which replaces only touched orders); the live check records the number.

## Critical User Journeys (CUJs)

### CUJ 1: A judge runs the demo path on the hosted URL

*   **Given**: The blueprint is deployed, secrets are set, the webhook is registered, and the owner pressed Reset once (30 seeded orders). The judge has the console URL and the approver key from the Devpost testing instructions.
*   **When**: The judge opens `/`, reads the five steps, signs in, taps "Run in baseline mode" on the attack email, then "Run protected" on it, then on the stalled parcel and the damaged basket, and scans the start page's code with a phone to approve the $240 refund.
*   **Then**: Each tap opens the new thread in the inbox. Baseline refunds through PayPal's tools directly; protected shows denials and a hold with reason codes. The stalled-parcel refund executes with a sandbox refund ID and reconciles by webhook. The phone card approves exactly the held refund, which executes once.

### CUJ 2: The next judge starts fresh

*   **Given**: CUJ 1 refunded a few seeded captures and left threads, decisions and log entries.
*   **When**: A signed-in judge taps "Reset demo" and confirms.
*   **Then**: Within 60 seconds the inbox, decisions and audit log are empty except entry 1, a `demo.reset` naming where the old log ended; only the orders whose captures changed are replaced with fresh sandbox orders; any open dispute is recorded again and Resolve drafts its evidence; the start page says "Reset in 14s. Replaced 4 orders and kept 26." The day's run cap still counts CUJ 1's runs.

### CUJ 3: A stranger without the key

*   **Given**: Someone finds the console URL but has no approver key.
*   **When**: They open `/`, `/inbox`, `/chat`, or call `/api/resolve/messages`, `/api/scenarios` or `/api/demo/reset` directly.
*   **Then**: They can read the guide. Everything else answers or shows "Sign in with the approver key." No Gemini call, baseline run or reset happens. Calling Resolve or the database directly isn't possible: Resolve is a private service and Postgres allows no outside connection.

### CUJ 4: A reset at a bad moment

*   **Given**: Resolve is mid-run on a message, or the gate is mid-way through executing an approved refund.
*   **When**: A judge presses Reset.
*   **Then**: The start page shows "Resolve is still working on a message. Try again in a minute." (or the execution sentence). Nothing was cleared.

## Technical Plan (Architecture)

```text
                    internet                                   Render private network
   judge's browser ───────────▶ countersign-console (web) ──GATE_URL──────────▶ countersign-gate (web)
   judge's phone   ───────────▶   /  start page              ──RESOLVE_AGENT_URL─▶ countersign-resolve-agent (pserv)
   PayPal webhooks ─────────────────────────────────────────▶ gate /webhooks/paypal
   shopper         ───────────▶ countersign-storefront (web)
                                                              countersign-reconcile (cron, 10 min) ─▶ gate code, Resolve nudge
                                                              countersign-db (Postgres 18, internal only)
```

**Hosting (ADR 0041).** One blueprint. Each service builds from the repo root and runs from source. Services find each other through Render's `hostport` property; the start command turns `GATE_HOSTPORT` and `RESOLVE_AGENT_HOSTPORT` into the URL variables the code already reads, so no address code changes. Render generates the three Countersign keys on the gate; Resolve reads the support key from the gate; the owner types PayPal, Gemini, webhook and vault values once.

**The reset (ADR 0042).** A new gate module, `demo-reset.ts`, reached by `POST /demo/reset` (approver key) and `npm run reset`, both off unless `COUNTERSIGN_DEMO_RESET=on`:

```text
checks (db, PayPal, vault tokens, not running, no execution in flight)  ── fail → 409/503, nothing changed
  │
withAuditLog (ledger advisory lock)
  lockDemoTables (ACCESS EXCLUSIVE, 5 s timeout)            ── timeout → 409
  countUnfinishedWork (queued/running runs and drafts)      ── any → 409
  clearDemoTables (head, counts, carry run counts, TRUNCATE ×6)
  append demo.reset { previous_head, cleared }               ── commit
  │
order check: each seeded capture COMPLETED? (3 at a time)    ── keep or replace
runSeed(replaced orders, new run ID)                         ── failures → complete: false
syncDisputes (record waiting disputes again, nudge Resolve)
report
```

The seed catalog and run move to `@countersign/seed` so the gate and the storefront's CLI share them. `seed_orders` rows are replaced per order (the table is keyed by order number), and `carrier_shipments` keeps every run's shipments, because tracking numbers carry their run ID.

**The launcher and sign-in (ADR 0043).** The console's `/` becomes the start page. Its launcher posts `{ scenario_id, mode }` to the console's `/api/scenarios`, which checks the key with the gate (`withSignIn`, the ADR 0038 pattern) and calls Resolve's new `POST /scenarios/:id`. Resolve loads the scenario file it already has, resolves the sender from `seed_orders` and accepts it through the same path as `POST /messages`. The same `withSignIn` now wraps every console route to Resolve. Resolve's `RESOLVE_BASELINE` (`on` | `scenarios` | `off`) decides where baseline mode may run; the blueprint sets `scenarios`.

**Data.** One new table, `cleared_run_counts` (migration 0007), so a reset can't buy more AI runs. One new audit-log entry type, `demo.reset`. No other schema change.

## Alternatives Considered

### Alternative A: Host the reset in Resolve (the private service)

*   **Pros**: The wipe isn't on a public service; Resolve owns the run queue it must not clear mid-run.
*   **Cons**: Resolve would import the gate's dispute sync and write `dispute.received` entries itself; it would need the ledger's writes and the vault tokens; the console route would still accept the same approver key, so who can trigger it doesn't change.
*   **Reason for Rejection**: It spreads audit-log writes to a second service for no gain in who can reset. The gate already writes the log, holds PayPal and owns dispute sync; the database lock, not the service, is what keeps Resolve's work safe.

### Alternative B: Reset by starting one fresh seed run every time

*   **Pros**: One run ID in `seed_orders`; simplest to describe (ADR 0023's first idea).
*   **Cons**: 30 orders × 3 PayPal calls at 3 in flight on every reset; the 60-second budget (§11) is unmeasured and at risk; it orphans the pre-opened dispute every time.
*   **Reason for Rejection**: Replacing only touched captures keeps a typical reset to a few orders, and a dispute on an untouched order survives.

### Alternative C: Leave the inbox and chat open, and limit cost with the daily run cap alone

*   **Pros**: No sign-in before typing; less change to phase 8 routes and tests.
*   **Cons**: Anyone on the internet could spend the day's 200 runs in minutes and lock judges out, and start baseline runs.
*   **Reason for Rejection**: Fail closed (§10 trade-off 1). The guide stays open; only spending is gated. Phase 15 adds the public, rate-limited path.

### Alternative D: Offer baseline fully on the hosted URL, or not at all

*   **Pros**: Fully offered lets judges try their own attacks unprotected; not offered removes the vulnerable toolkit from the host.
*   **Cons**: Full exposes visitor text to a dependency tree with known high-severity vulnerabilities (spike S4) beside the Gemini key; none cuts brief §5 item 6.
*   **Reason for Rejection**: Scenarios-only keeps item 6 and keeps visitor text out of the toolkit.

### Alternative E: Code-level `*_HOSTPORT` fallbacks instead of start-command prefixes

*   **Pros**: Type-checked; no shell strings.
*   **Cons**: Four parsers in three workspaces gain a second way to set each address.
*   **Reason for Rejection**: The blueprint test pins every prefix against the variable names, Render's own examples expand variables in start commands, and the code keeps one way to read each address.

### Alternative F: A per-service environment group for shared secrets

*   **Pros**: Each secret typed once.
*   **Cons**: Render doesn't allow `sync: false` inside a blueprint environment group, so the values would have to be created outside the blueprint by hand and couldn't be checked by the test.
*   **Reason for Rejection**: `sync: false` per service is what the spec supports; `docs/hosting.md` tables which value goes where.

--------------------------------------------------------------------------------

## Non-Functional Requirements

*   **Security & Privacy.**
    *   The reset route and CLI exist only on a database flagged `COUNTERSIGN_DEMO_RESET=on`, open only to the approver key, refuse while work is in flight, and record a `demo.reset` entry with the old head. Risk: a key holder can reset during another judge's session. Mitigation: one reset at a time; phase 15 adds rate limits. Accepted for the judging window.
    *   Resolve and Postgres are unreachable from the internet. The console's routes to Resolve now check the approver key with the gate first, and never forward it.
    *   Generated keys (44 base64 characters) replace hand-made ones; the approver key goes to judges through Devpost's testing instructions, never the repo.
    *   On the hosted demo, baseline mode never receives visitor text. The toolkit's child process still gets only a per-run sandbox token (ADR 0031).
    *   The console has no `GEMINI_API_KEY` on Render until phase 16.
*   **Performance & Latency.** A reset is one transaction (milliseconds on a demo-sized log), 30 capture reads at 3 in flight (a few seconds), then 3 PayPal calls per replaced order at 3 in flight. The console waits up to 120 seconds. Launching a scenario is one gate round trip (key check) and one Resolve call; the run itself is as in phase 8.
*   **AI cost.** Unchanged per run; the launcher and chat need the key; the day's cap carries across resets; the console holds no Gemini key.
*   **Rollout & Rollback.** Everything ships off by default locally: without `COUNTERSIGN_DEMO_RESET=on` there's no reset; `RESOLVE_BASELINE` defaults to `on` (phase 8 behaviour). The one behaviour change everywhere is the sign-in on routes to Resolve. Rolling back the hosted demo is redeploying an earlier commit; migration 0007 only adds a table.

--------------------------------------------------------------------------------

### Additional Resources

*   [Brief](../../../specs/brief.md) §3, §5 items 6, 8, 18, §8, §10, §11, §12; [original brief](../../../specs/brief.original.md) §12 and §15.
*   [Render Blueprint spec](https://render.com/docs/blueprint-spec), read 25 Oct 2026.
*   [`docs/spikes.md`](../../../docs/spikes.md) S4 (toolkit vulnerabilities) and S7 (hosting, not started).
*   ADRs 0022, 0023, 0030, 0031, 0032, 0035, 0038.

### Future Improvements

*   **Reset history**: keep each `demo.reset`'s old head outside the log, so a chain of resets can be checked end to end.
*   **Database-held reset lock**, so the gate can scale past one instance.

--------------------------------------------------------------------------------

## Detailed Implementation Plan

Each phase leaves the four Feedback commands passing. Copy, answers and sentences are exactly as in [requirements.md](requirements.md); names below are binding. Tests use PGlite (`createTestDatabase`) and never real credentials; anything live runs under `LIVE=1` only.

### Phase 1: shared foundations (no visible change)

#### 1. `packages/seed/` (Create)

*   **Type / Scope**: New workspace `@countersign/seed`.
*   **Proposed Changes**:
    *   `package.json`: `"name": "@countersign/seed"`, `"private": true`, `"type": "module"`, `"exports": { ".": "./src/index.ts" }`, script `typecheck: tsc --noEmit`; dependencies `@countersign/carrier-mock`, `@countersign/db`, `@countersign/mandate`, `@countersign/rail-paypal` (all `0.0.0`), and devDependencies `@types/node` 26.6.5, `typescript` 5.9.3, `vitest` 4.1.12 (as `packages/carrier-mock/package.json`). zod comes from the root.
    *   `tsconfig.json`: as `packages/carrier-mock/tsconfig.json`.
    *   `git mv` `apps/storefront/src/products.ts`, `seed-catalog.ts` and `seed-run.ts` to `packages/seed/src/`, contents unchanged except that `seed-run.ts` exports its `StoredRowSchema` (the reset's order check uses the same row rules).
    *   `src/run-id.ts` (Create): move `VAULT_ENV_NAMES`, `RandomSuffixSchema`, the random suffix function (exported as `randomRunSuffix()`) and `newRunId(seededAt, suffix)` out of `apps/storefront/src/seed-cli.ts` unchanged; add `readVaultTokens(env: Readonly<Record<string, string | undefined>>): { ok: true; tokens: Record<SeedBuyer, string> } | { ok: false; missing: string[] }` (a token is present when it's a non-empty string; `missing` lists names in `VAULT_ENV_NAMES` order).
    *   `src/index.ts`: `export *` from `./products`, `./seed-catalog`, `./seed-run`, `./run-id`.
    *   Run `npm install` so the lockfile links the workspace.

#### 2. `apps/storefront/` (Modify)

*   **Type / Scope**: Imports only.
*   **Proposed Changes**: `src/seed-cli.ts`, `src/shop-props.ts`, `src/checkout.ts` import from `@countersign/seed`; `seed-cli.ts` re-exports `newRunId` and `VAULT_ENV_NAMES` (`export { newRunId, VAULT_ENV_NAMES } from "@countersign/seed"`) and drops its local copies. Tests `test/catalog.test.ts`, `test/seed-run.test.ts`, `test/seed-cli.test.ts`, `test/shop-pages.test.ts` import `products`, `seed-catalog` and `seed-run` names from `@countersign/seed`. `package.json` adds `"@countersign/seed": "0.0.0"`. `next.config.ts` adds `"@countersign/seed"` to `transpilePackages`.

#### 3. `tests/no-ai-in-decision-path.test.ts` (Modify)

*   **Proposed Changes**: add `"seed"` to `decisionPackages`.

#### 4. `packages/db/` (Modify)

*   **Type / Scope**: Schema, migration, helpers.
*   **Proposed Changes**:
    *   `src/schema.ts`: `clearedRunCounts = pgTable("cleared_run_counts", { utcDate: text("utc_date").primaryKey(), runs: integer("runs").notNull() })`, with a comment pointing to ADR 0042.
    *   `drizzle/0007_*.sql` and its snapshot: generated with `npm run db:generate`, then renamed `0007_cleared_run_counts.sql` (update `meta/_journal.json`'s tag to match, as 0006 was).
    *   `src/demo-reset.ts` (Create), exported from `src/index.ts`; each function takes a `Transaction` (the type `Database["transaction"]`'s callback receives) except the last:
        *   `lockDemoTables(tx)`: `SET LOCAL lock_timeout = '5s'`, then `LOCK TABLE audit_log, tickets, ticket_attachments, agent_runs, dispute_drafts, evidence_documents IN ACCESS EXCLUSIVE MODE`.
        *   `countUnfinishedWork(tx): Promise<{ runs: number; drafts: number }>`: `count(*)` of `agent_runs` and `dispute_drafts` with status in (`queued`, `running`).
        *   `clearDemoTables(tx): Promise<ClearedTables>` where `ClearedTables = { entries: number; head: { seq: number; hash: string } | null; tickets: number; attachments: number; runs: number; drafts: number; documents: number }`: read the head (`audit_log` ordered by `seq` desc, limit 1) and each table's `count(*)`; then one `INSERT INTO cleared_run_counts (utc_date, runs) SELECT d, count(*)::int FROM (SELECT ((queued_at::timestamptz) AT TIME ZONE 'UTC')::date::text AS d FROM agent_runs UNION ALL SELECT ((queued_at::timestamptz) AT TIME ZONE 'UTC')::date::text FROM dispute_drafts) AS q GROUP BY d ON CONFLICT (utc_date) DO UPDATE SET runs = cleared_run_counts.runs + excluded.runs`; then `TRUNCATE TABLE audit_log, tickets, ticket_attachments, agent_runs, dispute_drafts, evidence_documents`.
        *   `countClearedRunsOnDate(db, date)`: the row's `runs` or 0; `date` checked with the same `DateSchema` as `countRunsOnDate`.
    *   `src/runs.ts`: unchanged.
    *   `test/demo-reset.test.ts` (Create): validation check 3, on PGlite with rows written through the package's existing writers.

#### 5. `packages/ledger/src/chain.ts` (Modify)

*   **Proposed Changes**: append `"demo.reset"` to `ENTRY_TYPES`, and to the comment ("Phase 13 adds the demo reset (ADR 0042)"). `test/chain.test.ts` or `test/log.test.ts`: a log whose entry 1 is `demo.reset` verifies.

#### 6. `apps/resolve-agent/src/limits.ts` (Modify)

*   **Proposed Changes**: `overDailyCap` adds `countClearedRunsOnDate(db, date)` to the two counts. `test/limits.test.ts`: validation check 8.

#### 7. `apps/gate/src/dispute-sync.ts` (Create) and `disputes-cli.ts` (Modify)

*   **Proposed Changes**: move `sync()`'s body to `export async function syncDisputes(db, rail, deps: { now: () => Date; env: Environment; nudgeFetch?: NudgeFetch }): Promise<DisputeSync>` with `DisputeSync = { ok: true; lines: string[]; recorded: number; alreadyRecorded: number; problems: number } | { ok: false; error: string; lines: string[] }`. `ok: false` covers the three `cantRun` cases (unreadable log before, list failed, an entry unreadable inside the lock); `error` is the sentence the CLI prints to stderr now. `lines` are exactly today's lines. `disputes-cli.ts`'s `sync` becomes a formatter: `ok: true` → `output(problems === 0 ? EXIT_OK : EXIT_NEGATIVE, lines)`; `ok: false` → exit 2 with `lines` on stdout and `error` on stderr, as now. `test/disputes-cli.test.ts` passes unchanged; `test/dispute-sync.test.ts` (Create) checks the counts.

#### 8. `apps/gate/src/executors.ts` (Modify)

*   **Proposed Changes**: a module-level `let inFlight = 0`; `execute()` increments it before calling the executor and decrements in `finally` around the whole body; `export function executionsInFlight(): number`. A test in `test/payout-executor.test.ts` or a new `test/in-flight.test.ts` checks it's 1 during a held executor call and 0 after, including after a throw.

### Phase 2: the reset in the gate

#### 9. `apps/gate/src/demo-reset.ts` (Create)

*   **Type / Scope**: The reset's core. No HTTP, no AI.
*   **Proposed Changes**:
    *   `export const DEMO_RESET_VAR = "COUNTERSIGN_DEMO_RESET"`; `export const demoResetEnabled = (env) => env[DEMO_RESET_VAR] === "on"`.
    *   `export const RESET_MESSAGES` with the 409 and 503 sentences in requirements.md (keys `running`, `executing`, `resolveBusy`, `locksBusy`, `noDatabase`, `noPayPal`, `noVault` (a function of the missing names), `notCleared`, `off`).
    *   `DemoResetPayloadSchema = z.strictObject({ previous_head: z.object({ seq: z.int().positive(), hash: z.string().regex(/^[0-9a-f]{64}$/) }).nullable(), cleared: z.strictObject({ entries, tickets, attachments, runs, drafts, documents: z.int().min(0) }) })`.
    *   `export type Reseed = (input: { orders: readonly DemoOrder[]; runId: string; seededAt: string }) => Promise<SeedReport>`.
    *   `export type ResetDeps = { db?: Database; rail: () => PayPalClient; env: Environment; clock: () => Date; reseed?: Reseed; nudgeFetch?: NudgeFetch; inFlight?: () => number; randomSuffix?: () => string }`.
    *   `export type ResetReport = { complete: boolean; resetAt: string; tookMs: number; previousHead: { seq: number; hash: string } | null; cleared: { entries; tickets; attachments; runs; drafts; documents }; orders: { kept: number; replaced: string[]; runId: string | null; failed: { orderNumber: string; call: string; reason: string }[] }; disputes: { recorded: number; alreadyRecorded: number; problems: number } | { error: string } }`.
    *   `export async function resetDemo(deps): Promise<{ ok: true; report: ResetReport } | { ok: false; status: 409 | 503; message: string }>`:
        1. `start = deps.clock()`; `resetAt = start.toISOString()`.
        2. Module-level `let running = false`: if set → 409 `running`. Set it now; clear it in `finally`.
        3. No `db` → 503 `noDatabase`. `parsePayPalEnv(env)` not ok → 503 `noPayPal`. `readVaultTokens(env)` not ok → 503 `noVault(missing)`. `(deps.inFlight ?? executionsInFlight)() > 0` → 409 `executing`. Build the rail with `deps.rail()` inside a try (a throw → 503 `noPayPal`).
        4. `withAuditLog(db, async (log) => { await lockDemoTables(log.tx); const busy = await countUnfinishedWork(log.tx); if (busy.runs + busy.drafts > 0) throw new ResolveBusy(); const cleared = await clearDemoTables(log.tx); await log.append({ entryType: "demo.reset", refId: null, at: resetAt, payload: { previous_head: cleared.head, cleared: { entries: cleared.entries, tickets: cleared.tickets, attachments: cleared.attachments, runs: cleared.runs, drafts: cleared.drafts, documents: cleared.documents } } }); return cleared; })`. `ResolveBusy` → 409 `resolveBusy`. An error whose `code` (or `cause.code`) is `55P03` → 409 `locksBusy`. Any other error → 503 `notCleared`.
        5. Order check: read all `seed_orders` rows; for each `DEMO_ORDERS` entry (catalog order), with at most `SEED_CONCURRENCY` (3) in flight: replaced when there's no row, the row fails the seed run's stored-row rules (export `StoredRowSchema` from `@countersign/seed`'s `seed-run.ts`), `row.buyer !== demo.buyer`, or `rail.getCapture(row.paypalCaptureId)` throws or answers a status other than `COMPLETED`; kept otherwise.
        6. If any replaced: `runId = newRunId(resetAt, (deps.randomSuffix ?? randomRunSuffix)())`; `report = await (deps.reseed ?? defaultReseed)({ orders: replaced, runId, seededAt: resetAt })`, where `defaultReseed` calls `runSeed({ paypal: rail, db, orders, runId, vaultTokens, clock: () => seededAt })`. Failed orders: `report.failures` mapped to `{ orderNumber, call, reason }`; if `report.problem` is set, every replaced order not already failed is failed with call `seed` and `reason` = the problem. A throw from the reseed fails every replaced order with call `seed` and reason "the seed run failed unexpectedly".
        7. `syncDisputes(db, rail, { now: deps.clock, env, nudgeFetch })` → `{ recorded, alreadyRecorded, problems }` or `{ error }`.
        8. `complete = failed.length === 0 && (disputes has no error) && disputes.problems === 0`; `tookMs = deps.clock().getTime() - start.getTime()`.
    *   `export function demoResetSummary(payload)`: the two sentences in requirements.md (hash shown as first 4 + "…" + last 4).
*   **Tests** `apps/gate/test/demo-reset.test.ts` (Create): validation check 4, with `createTestDatabase()`, the gate's `test/fake-sandbox.ts` for `getCapture` and the disputes calls, an injected `reseed` that records its input and writes `seed_orders` rows for what it was given, `inFlight` and `nudgeFetch` fakes, and a fixed clock. Seed rows for the "already seeded" cases are written with `db.insert(seedOrders)`.

#### 10. `apps/gate/src/demo-reset-api.ts` (Create) and `app.ts` (Modify)

*   **Proposed Changes**:
    *   `export const DEMO_RESET_PATH = "/demo/reset"`; `mountDemoReset(app, deps: { approver: Approver } & ResetDeps)`: `app.post(DEMO_RESET_PATH, approverOnly(approver), handler)`; the handler reads no body, calls `resetDemo`, answers `200` with the report in snake_case exactly as requirements.md, or `{ message }` with the refusal's status.
    *   `app.ts`: `AppDeps` gains `reseed?: Reseed`. After `mountAudit`, `if (demoResetEnabled(webhookDeps.env)) mountDemoReset(app, { approver, db: deps.db, rail: factory ?? (() => { throw new Error("no rail"); }), env: webhookDeps.env, clock: webhookDeps.clock, reseed: deps.reseed, nudgeFetch: deps.fetch })`. When disabled, nothing is mounted, so the path is Express's 404.
    *   `test/demo-reset-api.test.ts` (Create): validation check 5's HTTP cases, with a listening app as `test/approvals-api.test.ts` does.

#### 11. `apps/gate/src/reset-cli.ts`, `reset-main.ts` (Create); root `package.json` (Modify)

*   **Proposed Changes**: `runReset(args, env, deps?: { rail?; fetch?; reseed?; clock?; nudgeFetch? }): Promise<CliResult>` following the CLI conventions in `specs/tech-stack.md` (takes `--pglite <dir>`, chooses the database with `resolveDatabaseTarget`, refuses unknown arguments with `Usage: npm run reset -- [--pglite <dir>]`). Off flag → exit 2 with `RESET_MESSAGES.off`. Otherwise `resetDemo` with `inFlight: () => 0` (a CLI process has no executions) and the lines in requirements.md; durations formatted by a shared `durationWords(ms)` in `apps/gate/src/words.ts` ("12s", "1m 08s"; under 1 second is "0s"). `reset-main.ts` as the other `*-main.ts`. Root script `"reset": "tsx --env-file-if-exists=.env.local apps/gate/src/reset-main.ts"`. `test/reset-cli.test.ts` (Create): validation check 5's CLI cases, plus one child-process run with `node --import tsx` and the flag off (exit 2).

#### 12. `apps/gate/src/audit-reader.ts` (Modify)

*   **Proposed Changes**: in `summaryOf`, before the `decision` branch: `if (row.entryType === "demo.reset")` parse with `DemoResetPayloadSchema` through `parseEntry` and return `demoResetSummary`. `test/audit-reader.test.ts`: validation check 7.

### Phase 3: Resolve

#### 13. `apps/resolve-agent/src/scenario-file.ts` (Create) and `resolve-cli.ts` (Modify)

*   **Proposed Changes**: move `Sender`, `FileMessage`, `MessageFileSchema`, `MessageFile`, `Photo`, `loadFile` (exported as `loadMessageFile`), `senderEmail` and `resolveSenders` from `resolve-cli.ts` unchanged, except that `senderEmail`'s not-seeded refusal becomes `{ ok: false; error: string; unseeded: string | null }` where `unseeded` is "Order KIK-1035" or "Buyer A" (null for other errors) and `error` keeps today's CLI sentence. `resolve-cli.ts` imports them and re-exports `MessageFileSchema`; its output is unchanged and `test/resolve-cli.test.ts` passes unchanged.

#### 14. `apps/resolve-agent/src/baseline-policy.ts` (Create), `serve.ts` and `app.ts` (Modify)

*   **Proposed Changes**:
    *   `export type BaselinePolicy = "on" | "scenarios" | "off"`; `parseBaselinePolicy(env): { policy: BaselinePolicy; problem: string | null }` (unset or blank → `on`; exact `on`, `scenarios`, `off`; else `off` with the startup sentence); `export const BASELINE_REFUSALS = { scenariosOnly, off }` with requirements.md's sentences.
    *   `serve.ts`: parse it, log the problem line if any, pass `baseline` to `createApp`.
    *   `app.ts`: `AppDeps` gains `baseline?: BaselinePolicy` (default `on`). Move the body of `POST /messages` after the body is read into `async function accept(res, input: unknown, origin: "message" | "scenario")`: `checkMessage`; then if the checked mode is `baseline`: `off` → 400 `off`; `scenarios` and `origin === "message"` → 400 `scenariosOnly`; then the cap, store and queue exactly as now. `POST /messages` calls `accept(res, req.body, "message")`.
    *   `test/app.test.ts`: validation check 9's `/messages` cases.

#### 15. `apps/resolve-agent/src/scenarios.ts` (Create) and `app.ts` (Modify)

*   **Proposed Changes**:
    *   `LAUNCHER_SCENARIOS: readonly { id: string; file: string; modes: readonly RunMode[] }[]` as the table in requirements.md; `SCENARIOS_DIR = new URL("../scenarios/", import.meta.url)`; `loadScenario(id)` → `{ message: FileMessage; photos: Photo[] } | null` (null for an unknown ID) via `loadMessageFile`; a file that doesn't load or doesn't hold exactly one message throws (a packaging error, pinned by a test that loads all three).
    *   `app.ts`: `POST /scenarios/:id` with `express.json({ limit: "1kb" })`: unknown ID → 404; body not `z.strictObject({ mode: z.enum(["protected", "baseline"]) })` → 400; mode not in the scenario's `modes` → 400 "This scenario runs in protected mode only."; `senderEmail(db, message.sender)` not ok with `unseeded` → 409 `${unseeded} isn't seeded. Reset the demo first.`; other errors → 500 "Resolve couldn't store the message. Try again."; then `accept(res, { channel, sender_email, subject?, body, attachments: photos as { content_type, data }, mode }, "scenario")`.
    *   `test/scenarios.test.ts` (Create): validation check 9's scenario cases, with `seed_orders` rows inserted for buyer A and the beat orders, and a queue fake recording run IDs.

### Phase 4: the console

#### 16. `apps/console/src/approval-routes.ts` (Modify)

*   **Proposed Changes**: `export function withSignIn<T>(request: Request, deps: ApprovalDeps, run: (key: string) => Promise<Answer<T>>, render?: (request, answer) => Response)`: `withKey(request, async (key) => { const checked = await checkKey(key, deps); return checked.ok ? run(key) : checked; }, render)`. `Refusal["status"]` gains `409`.

#### 17. `apps/console/src/resolve-routes.ts` and `app/api/resolve/**/route.ts` (Modify)

*   **Proposed Changes**: `threadsRoute(request, deps)`, `threadRoute(request, id, deps)`, `attachmentRoute(request, id, deps)` and `messagesRoute(request, deps)` run through `withSignIn` (`deps: ResolveDeps & ApprovalDeps`, which have the same fields); the inner functions (`loadThreads`, `loadThread`, `sendToResolve`, the photo read) don't change. `attachmentRoute` keeps its own byte response through `render`. The four route files pass `request`. Tests: `test/resolve-routes.test.ts` and `test/messages-route.test.ts` route-level cases send a signed-in cookie (`countersign_approver=<key>`) and a fetch fake that answers the gate's `GET /approvals` 200 with an empty view (as `test/dispute-routes.test.ts` does); new cases: no cookie → 401 without calling Resolve; gate 401 → 401 and the cookie cleared; the key never appears in a Resolve request.

#### 18. `apps/console/app/inbox/page.tsx`, `src/chat.ts`, `app/chat/customer-chat.tsx` (Modify)

*   **Proposed Changes**:
    *   Inbox: as `app/disputes/page.tsx` — read the cookie's key with `approverKeyFromHeader`; none → `<SignIn title="Inbox" line=… message={null} />` in the shell; `checkKey` 401 → the same with "Sign in again."; 502 → the existing `Notice`; then the existing page.
    *   Chat: `export const CHAT_SIGNED_OUT` with requirements.md's sentence; the load and send functions map a 401 to `{ ok: false, missing: false, signedOut: true, message: CHAT_SIGNED_OUT }` (other results gain `signedOut: false`); the chat shows the sentence and a link "Go to the start page" to `/` in place of the form. `test/chat.test.ts` covers the 401 mapping.

#### 19. `apps/console/src/demo-schemas.ts`, `src/demo-routes.ts`, `app/api/scenarios/route.ts`, `app/api/demo/reset/route.ts` (Create)

*   **Proposed Changes**:
    *   Schemas: `ScenarioRequestSchema = z.strictObject({ scenario_id: z.enum(["beat-3-attack-email", "beat-4-stalled-parcel", "beat-5-damaged"]), mode: z.enum(["protected", "baseline"]) })`; `ScenarioAcceptedSchema` = `MessageAcceptedSchema`; `ResetReportSchema` matching requirements.md's report (snake_case, counts `z.int().min(0)`, order numbers `/^KIK-\d{4}$/`, at most 30 each).
    *   `scenarioRoute(request, deps)`: read at most 1 KB (`readLimited` from `resolve-routes.ts`, exported), parse JSON and the schema (400 "Send JSON with scenario_id and mode."), then `withSignIn` → `callResolve(deps, "/scenarios/<id>", { json: JSON.stringify({ mode }) })`: 202 parsed → 202; 400/404/409 with a parsed `{ message }` → that status and sentence; anything else → 502 `RESOLVE_UNREACHABLE`.
    *   `resetRoute(request, deps)`: `withKey` → `callGate(deps with timeoutMs: 120_000, key, "/demo/reset", { json: "{}" })`: 200 parsed with `ResetReportSchema` → 200; 404 → 404 "The demo reset is off on this gate."; 401 → as `refusalOf`; 409/503 with `{ message }` → passed through; anything else → 502 unreachable.
    *   Route files: `runtime = "nodejs"`, `dynamic = "force-dynamic"`, `POST` only.
    *   `test/demo-routes.test.ts` (Create): validation check 10's route cases.

#### 20. `apps/console/src/start-view.ts` (Create)

*   **Proposed Changes**: `START_COPY` (every string in requirements.md's start-page section); `SCENARIO_CARDS` (id, title, line, look-for, buttons as `{ mode, label, variant: "primary" | "secondary" }[]`); `storefrontLink(env)` → the URL when `STOREFRONT_URL` parses as http(s), else null; `durationWords(ms)`; `resetSentence(report)` → `{ sentence, tone }` per requirements.md (tone `positive` when complete, `warning` otherwise). `test/start-view.test.ts` (Create) pins the copy, card order and every sentence; a cross-check imports `LAUNCHER_SCENARIOS` from `@countersign/resolve-agent/src/scenarios` (test-only, as resolve's tests import the gate; `apps/console/package.json` gains the devDependency `"@countersign/resolve-agent": "0.0.0"`) and asserts the IDs and modes match `SCENARIO_CARDS`.

#### 21. Start page UI (Create/Modify)

*   **Proposed Changes**:
    *   `app/page.tsx` (Modify): replace the redirect with a server component: `metadata.title` "Start here · Countersign console", `dynamic = "force-dynamic"`; read the cookie key; signed in when `checkKey` is ok. Render in `<ConsoleShell>` a column `mx-auto flex w-full max-w-2xl flex-col gap-8 px-4 pt-5 pb-8 md:px-6`: header (`text-heading-6 font-semibold tracking-heading`, line `text-body-base text-secondary-foreground`); "In about a minute" (`h2 text-body-sm font-medium`, `ol` with `list-decimal pl-5 text-body-base`); "What's real" and "What's simulated" as a two-item `dl` in a tinted card (`rounded-2xl bg-card p-4`); the storefront line when `storefrontLink` isn't null (link `text-brand-foreground hover:underline`); then signed out `<SignIn level={2} …>`, signed in the scenarios, the phone code (from `approvalsUrl({ publicUrl: process.env.CONSOLE_PUBLIC_URL, origin: requestOrigin(headers) })` and `qrView`), and the reset section.
    *   `app/start-parts.tsx` (Create, `"use client"`): `ScenarioCard` (Graphite Card: `rounded-2xl bg-container p-4 shadow-border`; title `text-body-sm font-medium`; lines `text-body-sm text-secondary-foreground`; buttons from `CONTROL_CLASSES`-style class constants in `start-view.ts`, 32px, primary `bg-inverted-solid text-on-inverted-foreground`, secondary `bg-component-on-container-strong shadow-default`; Lucide `Play` 16px leading icon; pending shows `Spinner`; posts to `/api/scenarios`, then `router.push("/inbox?thread=<id>")`; a refusal line `text-caption-lg text-danger-foreground` with `role="alert"`). `ResetDemo` (a `danger-subtle` button with Lucide `RotateCcw`; a native `<dialog>` opened with `showModal()` as `app/inbox/inbox-header.tsx` does, `bg-modal shadow-xl rounded-3xl p-5 w-full max-w-md`, bottom-anchored with `rounded-t-2xl` under 640px; Cancel (secondary) then "Reset demo" (`bg-danger-solid text-on-danger-solid-foreground`); posts to `/api/demo/reset`, closes, `router.refresh()`, and shows `resetSentence` in a `Notice`).
    *   `app/open-on-phone.tsx` (Create): `OpenOnPhone` moved unchanged from `app/approvals/approvals-board.tsx`, which now imports it.
    *   `app/sign-in.tsx` (Modify): optional `level?: 1 | 2` (default 1) choosing `h1` or `h2`, same classes.
    *   `app/console-nav.tsx` (Modify): first item `{ href: "/", label: "Start here", Icon: Compass }`; `current` for `/` only when `pathname === "/"`.
    *   `test/console-setup.test.ts` (Modify): replace the redirect assertion with: `app/page.tsx` renders the start page (contains `START_COPY` and no `redirect(`); the nav starts with Start here; the start page uses the shared sign-in at level 2.

### Phase 5: hosting and docs

#### 22. `render.yaml` (Create)

*   **Type / Scope**: Render Blueprint, exactly:

```yaml
# Countersign's hosted demo on Render (ADR 0041). Sandbox only. No secret lives in this file:
# each one is typed into the dashboard (sync: false) or generated by Render. See docs/hosting.md.

databases:
  - name: countersign-db
    plan: 0.1c-256mb
    region: oregon
    postgresMajorVersion: "18"
    ipAllowList: []

services:
  - type: web
    name: countersign-gate
    runtime: node
    plan: 0.5c-512mb
    region: oregon
    buildCommand: npm ci --include=dev
    preDeployCommand: npm run db:migrate
    startCommand: RESOLVE_AGENT_URL=http://$RESOLVE_AGENT_HOSTPORT npm run start --workspace @countersign/gate
    healthCheckPath: /health
    envVars:
      - key: NODE_VERSION
        value: 26.7.0
      - key: DATABASE_URL
        fromDatabase:
          name: countersign-db
          property: connectionString
      - key: PAYPAL_BASE_URL
        value: https://api-m.sandbox.paypal.com
      - key: PAYPAL_CLIENT_ID
        sync: false
      - key: PAYPAL_CLIENT_SECRET
        sync: false
      - key: PAYPAL_WEBHOOK_ID
        sync: false
      - key: PAYPAL_SEED_VAULT_TOKEN
        sync: false
      - key: PAYPAL_SEED_VAULT_TOKEN_B
        sync: false
      - key: COUNTERSIGN_SUPPORT_AGENT_KEY
        generateValue: true
      - key: COUNTERSIGN_OPS_AGENT_KEY
        generateValue: true
      - key: COUNTERSIGN_APPROVER_KEY
        generateValue: true
      - key: COUNTERSIGN_DEMO_RESET
        value: "on"
      - key: RESOLVE_AGENT_HOSTPORT
        fromService:
          type: pserv
          name: countersign-resolve-agent
          property: hostport

  - type: pserv
    name: countersign-resolve-agent
    runtime: node
    plan: 0.5c-512mb
    region: oregon
    buildCommand: npm ci --include=dev
    startCommand: GATE_MCP_URL=http://$GATE_HOSTPORT/mcp npm run start --workspace @countersign/resolve-agent
    envVars:
      - key: NODE_VERSION
        value: 26.7.0
      - key: PORT
        value: "10000"
      - key: DATABASE_URL
        fromDatabase:
          name: countersign-db
          property: connectionString
      - key: PAYPAL_BASE_URL
        value: https://api-m.sandbox.paypal.com
      - key: PAYPAL_CLIENT_ID
        sync: false
      - key: PAYPAL_CLIENT_SECRET
        sync: false
      - key: GEMINI_API_KEY
        sync: false
      - key: RESOLVE_DAILY_RUN_CAP
        value: "200"
      - key: RESOLVE_BASELINE
        value: scenarios
      - key: COUNTERSIGN_SUPPORT_AGENT_KEY
        fromService:
          type: web
          name: countersign-gate
          envVarKey: COUNTERSIGN_SUPPORT_AGENT_KEY
      - key: GATE_HOSTPORT
        fromService:
          type: web
          name: countersign-gate
          property: hostport

  - type: web
    name: countersign-console
    runtime: node
    plan: 0.5c-512mb
    region: oregon
    buildCommand: npm ci --include=dev && npm run build --workspace @countersign/console
    startCommand: GATE_URL=http://$GATE_HOSTPORT RESOLVE_AGENT_URL=http://$RESOLVE_AGENT_HOSTPORT npm run start --workspace @countersign/console -- -H 0.0.0.0
    healthCheckPath: /
    envVars:
      - key: NODE_VERSION
        value: 26.7.0
      - key: STOREFRONT_URL
        sync: false
      - key: GATE_HOSTPORT
        fromService:
          type: web
          name: countersign-gate
          property: hostport
      - key: RESOLVE_AGENT_HOSTPORT
        fromService:
          type: pserv
          name: countersign-resolve-agent
          property: hostport

  - type: web
    name: countersign-storefront
    runtime: node
    plan: 0.5c-512mb
    region: oregon
    buildCommand: npm ci --include=dev && npm run build --workspace @countersign/storefront
    startCommand: npm run start --workspace @countersign/storefront -- -H 0.0.0.0
    healthCheckPath: /
    envVars:
      - key: NODE_VERSION
        value: 26.7.0
      - key: PAYPAL_BASE_URL
        value: https://api-m.sandbox.paypal.com
      - key: PAYPAL_CLIENT_ID
        sync: false
      - key: PAYPAL_CLIENT_SECRET
        sync: false

  - type: cron
    name: countersign-reconcile
    runtime: node
    plan: 0.5c-512mb
    region: oregon
    schedule: "*/10 * * * *"
    buildCommand: npm ci --include=dev
    startCommand: npm run reconcile; RESOLVE_AGENT_URL=http://$RESOLVE_AGENT_HOSTPORT npm run disputes -- sync
    envVars:
      - key: NODE_VERSION
        value: 26.7.0
      - key: DATABASE_URL
        fromDatabase:
          name: countersign-db
          property: connectionString
      - key: PAYPAL_BASE_URL
        value: https://api-m.sandbox.paypal.com
      - key: PAYPAL_CLIENT_ID
        sync: false
      - key: PAYPAL_CLIENT_SECRET
        sync: false
      - key: RESOLVE_AGENT_HOSTPORT
        fromService:
          type: pserv
          name: countersign-resolve-agent
          property: hostport
```

#### 23. `tests/render-blueprint.test.ts` (Create); root `package.json` (Modify)

*   **Proposed Changes**: `npm install --save-exact --save-dev yaml@2.9.1` at the root (add it to `specs/tech-stack.md`'s pinned table). The test reads `render.yaml` with `parse` from `yaml` and checks, against a fixed expected table in the test (the file above): the one database (plan, version 18, empty allow list); the five services' `type`, `name`, `runtime`, `plan` (never `free`), `region`, `buildCommand`, `startCommand`, `healthCheckPath` and `preDeployCommand`; each service's exact set of `envVars` keys; every `fromService` names a declared service of that type and `fromDatabase` the declared database; every `*_HOSTPORT` a start command uses is declared on that service; `NODE_VERSION` 26.7.0 everywhere; no `value` matches a secret pattern (`/(sk|pk|AIza|EC|A21AA)[A-Za-z0-9_-]{10,}/`, or longer than 40 characters, except the sandbox URL); `GEMINI_API_KEY` appears only on Resolve; the three Countersign keys are generated on the gate only; `PAYPAL_SEED_VAULT_TOKEN*` only on the gate.

#### 24. Docs and constitution (Create/Modify)

*   **Proposed Changes**:
    *   `docs/hosting.md` (Create): requirements.md's hosting section, as owner steps: create the Blueprint from `render.yaml`; the table of `sync: false` values per service; after the first deploy, copy the generated approver key into the Devpost testing instructions and the ops key into `.env.local` for `npm run agent`; register the webhook (three event groups) and set `PAYPAL_WEBHOOK_ID`; set `STOREFRONT_URL`; sign in on the console and press Reset once; run `npm run ledger -- verify` from the gate's Render Shell; keep every service at one instance.
    *   `docs/judge-guide.md` (Create): the start page's five steps, where the approver key and the sandbox buyer login are (Devpost testing instructions), what's real and simulated, and that baseline mode runs only the attack email on the hosted demo.
    *   `specs/tech-stack.md`: layout gains `packages/seed/` and `render.yaml`; pinned `yaml` 2.9.1 (root, devDependency); a "Hosting" paragraph per ADR 0041; "Demo reset" conventions per ADR 0042; "Secrets and environment" gains `COUNTERSIGN_DEMO_RESET`, `RESOLVE_BASELINE`, `STOREFRONT_URL` and the gate's vault tokens; the Resolve conventions gain the sign-in on routes to Resolve and the baseline policy.

### Phase 6: live check

#### 25. `apps/gate/test/reset-live.test.ts` (Create)

*   **Proposed Changes**: `describe.skipIf(process.env.LIVE !== "1" || !vault tokens || !PayPal env)`; a fresh PGlite in a temp dir; `resetDemo` with the real rail client and no injected reseed: first reset replaces 30 and `complete`; second keeps 30; refund $1.00 on `KIK-1013`'s capture through `rail.refundCapture` with a fresh request ID; third replaces exactly `KIK-1013`. Logs each `tookMs` with `console.log` (no secret). Timeout 180 s.

### Verification Plan

*   **Compilation/Build**: `npm run typecheck`, `npm run build` (both Next apps, with `@countersign/seed` transpiled).
*   **Unit Tests**: `npm test`: every test named above, plus all existing tests (the disputes CLI, resolve CLI and storefront seed tests unchanged in what they assert).
*   **Static Analysis & Linting**: `npm run lint`; the Graphite design check (part of `npm test`) on every changed console file.
*   **Test Coverage Requirement**: every refusal sentence and status in requirements.md has a test; every branch of the order check (kept, missing, unreadable, wrong buyer, non-`COMPLETED`, read failure) has a test.
*   **E2E/Integration**: `LIVE=1 npm test -- apps/gate/test/reset-live.test.ts` when the vault tokens are set; Render checks are the owner's (`validation.md` manual checks 1 to 9).

--------------------------------------------------------------------------------

*Drafted with EGM*
