# Phase 13: the hosted judge path

*   **Author:** autopilot planner (the Elephant, the planning role in [`.ralph/egm/PROCESS.md`](../../../.ralph/egm/PROCESS.md)), for the owner (muigufarid@gmail.com)
*   **Status:** Draft, review round A resolved ([reviews/resolution.md](reviews/resolution.md))
*   **Date:** 2026-10-25, revised 2026-10-31

--------------------------------------------------------------------------------

## Overview

Countersign has every PayPal beat of the demo working locally. The beats are the steps of the demo path in [brief §6](../../../specs/brief.md). Phases 7 and 8 put Resolve's agent behind the gate. Phase 9 sends step-up cards to the merchant's phone, phase 10 shows claims beside records for every decision, phase 11 builds dispute evidence packs, and phase 12 lets the ops agent pay suppliers. Nothing is hosted yet.

Brief §5 item 8 asks that a judge can "open the hosted URL, follow a 60-second guide, run the main scenarios from a scenario launcher, open the approvals page on their phone through a QR code, and reset the demo to the seed state". Item 18 asks that it keeps working on paid Render plans until 22 Dec. This phase is roadmap item 13 and roadmap gate G2 (brief §13): "the full PayPal demo path works end to end on the hosted URL."

No agent can deploy (there's no Render credential and no paid plan yet; brief §14 forbids the agent spending money). So this phase builds everything a deploy needs and proves it against fixtures: the Render blueprint, the demo reset, the scenario launcher and the guide. The owner deploys from `docs/hosting.md` and runs the manual checks in `validation.md`.

Decisions behind this design: [ADR 0041](../../../docs/adr/0041-render-blueprint-four-services-a-private-resolve-internal-addresses-and-generated-keys.md) (Render), [ADR 0042](../../../docs/adr/0042-demo-reset-in-the-gate-clears-the-log-and-resolve-tables-replaces-only-touched-orders-and-keeps-the-run-cap.md) (the reset), [ADR 0043](../../../docs/adr/0043-a-start-page-guides-judges-every-console-route-to-resolve-needs-the-sign-in-and-hosted-baseline-runs-only-the-demo-scenarios.md) (the start page, sign-in and hosted baseline) and [ADR 0044](../../../docs/adr/0044-round-a-reset-order-and-guarantees-gate-minted-baseline-tokens-phone-pairing-and-session-limits.md), which records what review round A changed in them. Exact behaviour, copy and answers are in [requirements.md](requirements.md); checks are in [validation.md](validation.md). Where the two differ, requirements.md wins on copy, statuses and answers, and this document is binding on names, signatures and the order of work. Terms are in [CONTEXT.md](../../../CONTEXT.md).

## The Problem

Judges may test the demo themselves, and when they do the brief gives them five minutes (§3). Today a judge would need a terminal: scenarios run from `npm run resolve`, the seed from `npm run seed`, and there's no reset at all, so the second judge finds the seeded captures already refunded. Run publicly as it stands, the console would also let anyone start Gemini runs and baseline runs (PayPal's toolkit with no gate) from an open inbox, which §8 forbids ("the public demo can't run up unbounded AI cost").

The proposal: one Render blueprint for the four services, the cron job and the database; a start page with a five-step guide that takes about a minute to read, which runs the three demo scenarios with one tap each; a reset in the gate that first replaces the seeded orders a scenario touched and only then clears the demo's records; the approvals sign-in in front of everything that spends AI calls; and baseline mode limited to the fixed scenarios on the hosted demo.

## Goals

*   **G-1 Deployable as code.** `render.yaml` describes the whole hosted demo (four services, a reconcile cron job and Postgres 18; five entries under `services`) on paid plans with no secret in it, and a test checks its invariants. Measured: validation check 11.
*   **G-2 A judge needs no terminal.** From `/`, a signed-in judge runs the attack email (baseline or protected), the stalled parcel and the damaged basket, opens Approvals on a phone by QR (the code also signs the phone in), and resets. Measured: validation check 10; manual checks 5 and 6 on Render.
*   **G-3 Every reset after the first finishes in ≤ 60 seconds** (brief §11, §12). The first reset seeds all 30 orders; its time is recorded, with the same 60-second target. Measured: live check 1's second and third `took_ms` (local PGlite against the sandbox) and manual checks 4 and 6 on Render.
*   **G-4 A reset keeps the guarantees money depends on.** It runs only when the gate has `COUNTERSIGN_DEMO_RESET=on`, only for the approver key, at most once a minute, and never while Resolve is working or an execution request has no result. It clears nothing unless every replacement order was created. It replaces every seeded order whose capture has execution history, so no kept capture loses its duplicate history. It records where the old log ended, leaves a chain that `ledger verify` passes, and never raises the day's run cap. What it restarts on purpose is listed in "What a reset keeps and restarts" below. Measured: validation checks 3, 4, 5 and 8.
*   **G-5 No console route starts an agent run or a baseline run without the approver key, and nobody resets without it.** Each signed-in session is rate-limited (brief §8). On the hosted demo no visitor-written text reaches baseline mode, and Resolve holds no PayPal credential. Dispute drafts that a signed webhook or the cron's sync starts need no key; the daily cap bounds them. Measured: validation checks 5, 9, 10, 11 and 12.

## Non-Goals

*   **Deploying.** The owner creates the blueprint, pays for plans, enters secrets and registers the webhook (`.ralph/human.md`, the owner's task list). No agent calls Render.
*   **"Attack it yourself"** (phase 15): free-text messages from visitors and the visitor money counter. It reuses this phase's per-session limiter.
*   **The smoke test and uptime monitor** (phase 19). Phase 19 adds the smoke-test cron and the uptime monitor to the same file.
*   **The dispute beat in the launcher.** Disputes are opened ahead of judging (brief §5 cut lines) and appear on the Disputes page; the reset records waiting ones again.
*   **Payouts in the launcher.** The ops agent stays the stand-in CLI (ADR 0039); a console that held the ops key would be a second agent.
*   **An operator reset CLI.** The reset runs only through the gate's route, so every guard lives in the process that holds them. The owner's first seed is the console's Reset button.
*   **M-Pesa receipts in the seed state.** Phase 18 adds receipts to the seed and to the reset.
*   **The README's judge guide** (phase 20). This phase writes `docs/judge-guide.md` for it to lift.
*   **More than one instance per service.** The reset's single-flight flag is in-process (ADR 0042); the one-minute cooldown in the log covers the moment of a deploy overlap.

## Open Questions

*   **Can a Render cron job reach a private service?** The cron job reaches Resolve through `RESOLVE_AGENT_HOSTPORT` for the dispute nudge. If it can't, the nudge fails and `disputes -- sync` prints its nudge line as failed; nothing else depends on it (ADR 0035). Manual check 9 confirms it.
*   **What does a disputed capture read as?** The keep rule assumes `KIK-1032`'s capture still reads `COMPLETED` while its dispute is open. Manual check 7 reads it. If it reads otherwise, every reset replaces `KIK-1032` and leaves its dispute on an order that's no longer seeded, so the owner must open a new dispute before each judge.

## Critical User Journeys (CUJs)

### CUJ 1: A judge runs the demo path on the hosted URL

*   **Given**: The blueprint is deployed, secrets are set, the webhook is registered, and the owner pressed Reset once (30 seeded orders). The judge has the console URL, the approver key and the sandbox buyer login from the Devpost testing instructions.
*   **When**: The judge opens `/`, reads the five steps and signs in. They tap "Run in baseline mode" on the attack email, then "Run protected" on it, then run the stalled parcel and the damaged basket. They scan the start page's code with a phone, which opens Approvals already signed in, and approve the $240 refund on its step-up card.
*   **Then**: Each tap opens the new thread in the inbox. In baseline mode the agent refunds through PayPal's tools directly; in protected mode the thread shows denials and a step-up, with reason codes. The stalled-parcel refund executes with a sandbox refund ID and reconciles by webhook. The judge's approval executes exactly the stepped-up refund, once.

### CUJ 2: The next judge starts fresh

*   **Given**: CUJ 1 refunded up to seven seeded captures (five in baseline mode, `KIK-1035` and `KIK-1037`) and left threads and log entries.
*   **When**: A signed-in judge taps "Reset demo" and confirms.
*   **Then**: Within 60 seconds the touched orders are replaced with fresh sandbox orders, the inbox is empty, and the audit log holds only entry 1, a `demo.reset` naming where the old log ended. Any dispute still waiting for the seller is recorded again and Resolve drafts its evidence. The start page says "Reset in 14s. Replaced 7 orders and kept 23. Recorded 1 dispute again." The day's run cap still counts CUJ 1's runs. A refund webhook PayPal sends late for a replaced capture appears in the new log as a refund nobody requested (ADR 0026).

### CUJ 3: A stranger without the key

*   **Given**: Someone finds the console URL but has no approver key.
*   **When**: They open `/`, `/inbox` or `/chat`, or call `/api/resolve/messages`, `/api/scenarios`, `/api/demo/reset` or the gate's public `POST /demo/reset` directly.
*   **Then**: They can read the guide. Every other page shows a sign-in prompt and every console route answers 401 (the sentences are in requirements.md); the gate's route answers 401 "A valid approver key is required." No Gemini call, baseline run or reset happens. Resolve and the database can't be called directly: Resolve is a private service and Postgres allows no outside connection.

### CUJ 4: A reset at a bad moment

*   **Given**: Resolve is mid-run on a message, the gate is carrying out an approved refund, or someone reset the demo less than a minute ago.
*   **When**: A judge presses Reset.
*   **Then**: The start page shows the matching sentence, such as "Resolve is still working on a message. Try again in a minute." Nothing was replaced or cleared.

### CUJ 5: PayPal fails during a reset

*   **Given**: The sandbox refuses or times out while the reset creates replacement orders.
*   **When**: A judge presses Reset.
*   **Then**: The start page says "The demo wasn't reset. 2 orders couldn't be replaced (KIK-1035, KIK-1037), so nothing was cleared. Reset again to retry." The demo works as it did before the press, and the replacements that did succeed are kept by the next reset.

## Technical Plan (Architecture)

```text
Public (internet)                                   Private network only
─────────────────                                   ────────────────────
judge's browser ─▶ countersign-console (web)
judge's phone   ─▶   /approvals          ─ RESOLVE_AGENT_URL (reads, messages, protected scenarios) ─▶ countersign-resolve-agent (pserv)
                         │ GATE_URL (key check, pairing, approvals, audit, disputes, reset, baseline launch)  │    ▲
                         ▼                                                                                    │    │ RESOLVE_AGENT_URL
PayPal webhooks ─▶ countersign-gate (web) ◀──────────── GATE_MCP_URL (/mcp, every protected run) ─────────────┘    │ (nudge, baseline
                         └─────────────────────────────────────────────────────────────────────────────────────────┘  scenario + token)
shopper         ─▶ countersign-storefront (web)
                                                    countersign-reconcile (cron, every 10 min): runs `npm run reconcile`
                                                      and `npm run disputes -- sync` in its own process; nudges Resolve
                                                    countersign-db (Postgres 18, no outside connection):
                                                      read and written by the gate, Resolve and the cron job
PayPal sandbox API ◀── gate (guarded execution, reads, reset, baseline tokens), Resolve's toolkit child (a per-run token only), storefront, cron
```

The console reaches the gate and Resolve over the private network (through `*_HOSTPORT`); the gate is public too, for PayPal's webhooks and the approval API.

**Hosting (ADR 0041).** One blueprint. Each service builds from the repo root and runs from source. Services find each other through Render's `hostport` property; the start command turns `GATE_HOSTPORT` and `RESOLVE_AGENT_HOSTPORT` into the URL variables the code already reads, so no address code changes. Render generates the support-agent, ops-agent and approver keys on the gate, and Resolve reads the support-agent key from the gate. The owner types the PayPal client ID and secret once for each of the three services that read them (the gate, the storefront and the cron job; never Resolve), and the Gemini key, webhook ID and vault tokens once each (`docs/hosting.md` tables them). Every service sets `autoDeployTrigger: off`, so the owner deploys on purpose, when no run is queued (ADR 0044).

**The reset (ADRs 0042 and 0044).** A new gate module, `demo-reset.ts`, reached by `POST /demo/reset` (approver key), mounted only when the gate runs with `COUNTERSIGN_DEMO_RESET=on`:

```text
checks: database, PayPal variables, vault tokens, no other reset in this process   ── fail → 409/503
busy check (no lock): a run or draft queued or running, an execution request
  from the last 10 minutes with no result, or a reset in the last minute           ── any → 409
order check: seed rows, the captures execution requests name, each capture (3 at a time)  ── keep or replace
runSeed(replaced orders, new run ID)                    ── any failure → 200, cleared: null, nothing cleared
withAuditLog (ledger advisory lock)
  lockDemoTables (ACCESS EXCLUSIVE, 5 s lock timeout)                              ── timeout → 409
  busy check again; a run queued since the reset began, or a capture now in
  seed_orders named by an execution request                                       ── any → 409
  clearDemoTables (chain head, counts, add the dates' run counts, TRUNCATE ×6)
  append demo.reset { previous_head, cleared }                                      ── commit
syncDisputes (record waiting disputes again, nudge Resolve)                         ── error → complete: false
report
```

Nothing is checked or counted in process memory except the single-flight flag: the busy check reads the database, so it sees work from any process (an approval answered from the gate's Render Shell, or a second instance during a deploy). Replacing before clearing means a PayPal failure leaves the demo as it was. The replaced orders' new rows are valid, unused sandbox orders, and the old log still holds the history of the captures they replaced. A scenario launched while the replacements are being created is caught inside the lock: any run queued since the reset began refuses it, which also covers a baseline run that already finished, since baseline refunds never reach the log (ADR 0031). The reset then answers 409 and the judge presses again.

The seed catalog and the seed-run code move to `@countersign/seed` so the gate and the storefront's CLI share them. `runSeed` moves unchanged. It already takes the orders to seed and writes one `seed_orders` row per order with an upsert on the order number, so other rows are untouched. It resumes rows its own run ID already holds, and reports `failures` (`orderNumber`, `call`, `reason`, `debugId`) and a whole-run `problem`. It throws before any call on a bad run ID, a missing vault token or an unreadable time. `carrier_shipments` keeps every run's shipments, because tracking numbers carry their run ID.

The ledger assigns `seq` and `prev_hash` when each entry is appended, from the newest row the transaction sees (`appendPrepared` in `packages/ledger/src/log.ts`). `seq` is a plain `bigint` primary key with no sequence behind it. So after the `TRUNCATE`, the `demo.reset` entry is `seq` 1 with the genesis previous hash, and no `RESTART IDENTITY` is needed.

**What a reset keeps and restarts (ADR 0044).** Several guarantees read the audit log:

| Guarantee that reads the log | After a reset |
|---|---|
| The day's AI run cap (ADR 0031) | Kept. Every cleared run and draft is added to `cleared_run_counts` by the UTC date of its `queued_at`, every status included, which is exactly how `countRunsOnDate` and `countDraftsOnDate` count. |
| Duplicate refunds (`ledger.not_duplicate`, ADR 0026) | Kept for every seeded order: an order whose capture any `execution.requested` names, whatever its outcome, is replaced, so no kept capture loses its history. An unreadable request replaces every order. Only refund intents name a capture, so a dispute's evidence submission doesn't replace `KIK-1032`. A replaced capture is no longer seeded, and PayPal's refunded amount, which the capture verifier reads, still caps any refund on it. Baseline refunds never reach the log; their captures read `REFUNDED` or `PARTIALLY_REFUNDED` and are replaced by status. A refund still pending at PayPal could leave a capture reading `COMPLETED`; PayPal's own check against the captured amount is then the guard. |
| Today's usage for limits (ADR 0019) | Restarts, as on a fresh seed. Only the approver key resets, and that key can already approve any stepped-up amount. Carrying usage over would make a later judge's stalled-parcel refund step up the same day. Sandbox only. |
| Open step-ups (ADR 0032) | Cleared with their `decision` entries. A card still open on a phone fails when it's answered, because the answer carries an intent hash that no entry in the new log holds. |
| A bill paid once (ADR 0039) | Still guarded by PayPal: the same payout proposed again carries the same `PayPal-Request-Id` and `sender_batch_id`, which PayPal refuses. A changed bill, amount or note is a new payout, and every payout is a step-up, so it needs a new human approval whose card shows the bill reference. The ops agent isn't on the judge path. |
| Webhook dedup and reconciliation (ADRs 0026, 0035) | Restart. A late webhook for a replaced capture is logged as a refund nobody requested, and `npm run reconcile` has no request left to match it to. |
| Executions in flight | Never cleared: the reset refuses until every execution request from the last 10 minutes has its result. Every rail call now has a 30-second timeout, so no execution can outlast that window. An older request with no result is treated as a crash; its capture is replaced, because a request names it. |

**The launcher and sign-in (ADR 0043).** The console's `/` becomes the start page. Its launcher posts `{ scenario_id, mode }` to the console's `/api/scenarios`, which checks the key with the gate (`withSignIn`, the ADR 0038 pattern) and calls Resolve's new `POST /scenarios/:id`. Resolve loads the scenario file it already has, resolves the sender from `seed_orders` and accepts it through the same path as `POST /messages`. Resolve alone decides which scenario IDs and modes exist. The same `withSignIn` now wraps every console route to Resolve, and the dispute routes move onto it. Resolve's `RESOLVE_BASELINE` (`on` | `scenarios` | `off`) decides where baseline mode may run; the blueprint sets `scenarios`.

**Baseline tokens come from the gate (ADR 0044).** On Render, Resolve holds no PayPal credential. A baseline launch goes from the console to the gate's `POST /baseline/launch` (approver key). The gate mints one sandbox access token (`issueAccessToken`) and calls Resolve's `POST /scenarios/:id` itself over the private network, with the token in the body. Resolve keeps that token in memory for that one run and hands it to the toolkit's child. The token never reaches the console, the browser, a log or the database. Locally, Resolve still mints its own token when the PayPal variables are set (ADR 0031), so `npm run resolve -- --mode baseline` is unchanged.

**The phone pairs by QR (ADR 0044).** The key lives in each browser's HttpOnly cookie (ADR 0032), so the phone can't inherit the desktop's sign-in. When a signed-in judge opens the start page, the console asks the gate for a pairing code (`POST /approvals/pairing-codes`, approver key). The code is 16 random bytes, single-use and valid for 5 minutes; the gate holds only its SHA-256, in memory. The QR code carries it in the URL fragment (`/approvals#pair=<code>`), so it never reaches a server log. The approvals page reads it, drops it from the address bar and posts it to the console, which trades it with the gate (`POST /approvals/pair`) for the key and sets the same cookie the sign-in sets. A used, expired or unknown code shows the normal sign-in, and approving on the desktop's Approvals page always works too.

**Each session is rate-limited (brief §8, ADR 0044).** Signing in (by key or by pairing) also sets a random `countersign_session` cookie. Each session may start 12 runs (scenario launches and chat or inbox messages together) and 3 resets in any 10 minutes; past that the console answers 429 with a sentence. A request with the key cookie but no session cookie must sign in again. The limiter is in the console's memory, on its one instance; phase 15 reuses it for the public path. The daily run cap still bounds everything together.

The approver key now does more than answer step-ups: it also launches scenarios, reads the inbox, sends chat messages, pairs a phone and resets the demo.

The brief's seed state lists "about 30 orders, trackers, receipts, tickets" (§7). A reset restores the orders and their trackers and carrier records. The tickets are the three scenario files, one tap away on the start page; queuing them on every reset would spend AI runs nobody asked for. Receipts join with phase 18 (ADR 0044).

**Data.** One new table, `cleared_run_counts` (migration 0007), so a reset can't buy more AI runs. One new audit-log entry type, `demo.reset`. No other schema change; pairing codes and session counts live in memory. The database is declared with a 5 GB disk.

## Alternatives Considered

### Alternative A: Host the reset in Resolve (the private service)

*   **Pros**: The reset isn't on a public service; Resolve owns the run queue it must not clear mid-run.
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

### Alternative F: One shared environment group for secrets, or references to the gate's values

*   **Pros**: Each secret typed once, and no service can hold a different PayPal client secret from the others.
*   **Cons**: Render doesn't allow `sync: false` inside a blueprint environment group, so the values would have to be created outside the blueprint by hand and couldn't be checked by the test. Referencing the gate's `sync: false` values from the other services with `fromService … envVarKey` isn't documented either way in the Blueprint spec (checked 31 Oct 2026).
*   **Reason for Rejection**: `sync: false` per service is what the spec supports; `docs/hosting.md` tables which value goes where, and manual checks 4 and 5 exercise every service's PayPal calls, so a mistyped value shows on the first deploy.

### Alternative G: Clear first, then replace the touched orders (the first draft's order)

*   **Pros**: The judge's records disappear at once; one less read of the log.
*   **Cons**: A sandbox outage or rate limit after the commit leaves an empty log over seed rows that still name refunded captures, and nothing stops a scenario starting in that window.
*   **Reason for Rejection**: Replacing first keeps the demo either as it was or fully reset (ADR 0044, §10 trade-off 3).

### Alternative H: An in-process count of executions in progress

*   **Pros**: No log read; a counter around `execute()`.
*   **Cons**: It misses executions in any other process (an approval from the Render Shell, a second instance during a deploy) and the moment between a request's commit and `execute()` starting.
*   **Reason for Rejection**: The log already says which requests have no result, and reading it inside the lock covers every process (ADR 0044).

### Alternative I: Carry today's usage across resets, as the run cap is

*   **Pros**: A reset couldn't give the agent fresh room under the mandate's daily limits.
*   **Cons**: A later judge's stalled-parcel refund would step up instead of executing on its own the same day, which breaks beat 4. The only person who can reset holds the approver key, which can already approve any stepped-up amount.
*   **Reason for Rejection**: It protects nothing the reset's own key can't already move, in the sandbox, at the cost of the judge path (ADR 0044).

### Alternative J: Resolve keeps minting baseline tokens with its own client secret on Render (ADR 0031's local path)

*   **Pros**: No new route; the code as it is.
*   **Cons**: The agent's host holds a long-lived PayPal credential beside a toolkit with known vulnerabilities (spike S4), which a same-user child process can read from Resolve's environment. Brief §8: "The agent never holds PayPal or Daraja credentials; only Countersign does."
*   **Reason for Rejection**: §8 is absolute (§10 trade-off 1). A token route for the support-agent key was weighed too and rejected: the child could read that key the same way, and a principal key would gain ungated PayPal access. The gate minting one token per approver-key launch gives no key new power (ADR 0044).

### Alternative K: No pairing code; the judge pastes the key on the phone

*   **Pros**: No new way to obtain the approver cookie.
*   **Cons**: Typing or pasting a 44-character key on a phone, from testing instructions open on another screen, is slow and error-prone inside the judge's five minutes (§3), and brief §5 item 3 promises "one tap on their phone".
*   **Reason for Rejection**: §10 trade-off 3. A 128-bit, single-use, 5-minute code in the URL fragment gives the phone nothing the key holder's own browser can't already get (ADR 0044). Pasting the key stays as the fallback.

### Alternative L: Leave per-session rate limits to phase 15

*   **Pros**: Less work now; the daily cap bounds total spend.
*   **Cons**: This phase makes the demo public, and §8 requires that "each session is rate-limited" from then on.
*   **Reason for Rejection**: §8 is a non-negotiable (ADR 0044).

--------------------------------------------------------------------------------

## Risks & Mitigations

| Risk | Effect on the judge path | Mitigation, or who owns it |
|---|---|---|
| A PayPal sandbox outage or rate limit during a reset | That reset fails | The reset clears nothing until every replacement exists (CUJ 5); pressing again retries and keeps the replacements already made. |
| A seed vault token is revoked or invalid | Every reset that replaces an order fails | The failed orders are named; the owner re-vaults the buyer (`.ralph/human.md`). |
| A key holder resets during another judge's session | That judge's threads disappear | At most one reset a minute, and the dialog says everyone starts again. Accepted for the judging window; phase 15 adds per-session limits. |
| A key holder spends the day's 200 runs | Launches are stored but not run until UTC midnight | Accepted; resets never restore runs. The owner can rotate the approver key (`docs/hosting.md`). |
| The approver key spreads beyond judges | Anyone with it can launch, approve and reset | Sandbox only (§8). Rotating it: generate a new value on the gate, redeploy the gate, update the Devpost text; signed-in browsers are asked to sign in again. |
| A judge's session hits its limit (12 runs or 3 resets in 10 minutes) | That judge waits a few minutes | The limits sit well above the judge path's four launches and one reset; the 429 sentence says when to try again. Signing in again starts a new session, so the daily cap stays the overall bound. |
| Two instances of a service during a deploy | A reset or a Resolve restart at that moment | `autoDeployTrigger: off`; `docs/hosting.md` says to deploy when no run is queued and press Reset after. Render stops the old instance at least 60 seconds after the new one takes traffic. The reset's checks read the database, so they hold across instances. Resolve's startup sweep marks the old instance's unfinished runs interrupted, and they're never rerun; a run the old instance is still finishing goes through the gate, or is the fixed attack email in baseline. Pairing codes and session limits are in memory, so a code minted on the old instance fails and the phone shows the sign-in. |
| The toolkit's child process is exploited (spike S4) | It could read Resolve's environment: `DATABASE_URL`, `GEMINI_API_KEY`, the support-agent key | Hosted baseline only ever receives the fixed attack email. On Render, Resolve holds no PayPal credential; the child gets only its run's token (ADR 0044). Phase 19's threat model records the rest. |
| Judges queue behind each other | A launch waits; a reset is refused while a run is queued | Resolve runs one run at a time, up to 8 model calls each (ADR 0031): at spike S8's 12 to 22 seconds a call, about 3 minutes a run in the worst case. Judges test at different times. The inbox shows a queued thread as working; the Gemini tier is the owner's (`.ralph/human.md`). |
| Resolve runs out of memory on `0.5c-512mb` during a baseline run | Every run in progress becomes interrupted | Manual check 10 reads Resolve's peak memory; the owner raises its plan if needed. |
| The disk fills between resets | The demo stops writing | 5 GB declared. A message holds up to 6 MB of photos, so about 800 such messages fit between resets, which clear them. |
| The dispute beat is single-use | After a judge submits evidence, later judges see no waiting dispute | Each pre-opened dispute serves one judge; `docs/hosting.md` says to open one per expected judge on `KIK-1032`. Each reset drafts each waiting dispute again, one run each, under the cap. |
| A Render cron job can't reach Resolve | The cron's dispute nudge fails | Logged; manual check 9. Webhooks still nudge Resolve from the gate. |
| Tokens must refresh until 22 Dec (§8) | PayPal calls fail if a token expires | The rail client caches the access token and fetches a new one when it expires (`packages/rail-paypal/src/client.ts`); phase 19's smoke test watches the live path. |

## Non-Functional Requirements

*   **Security & Privacy.**
    *   The reset route exists only when the gate runs with `COUNTERSIGN_DEMO_RESET=on`, which the owner sets only for a demo database. It's open only to the approver key, refuses while work is in flight or within a minute of the last reset, and records a `demo.reset` entry with the old head.
    *   Resolve and Postgres are unreachable from the internet. The console's routes to Resolve now check the approver key with the gate first, and never forward it.
    *   Generated keys (44 base64 characters) replace hand-made ones; the approver key goes to judges through Devpost's testing instructions, never the repo.
    *   On the hosted demo, baseline mode never receives visitor text. On Render, Resolve holds no PayPal credential: the gate mints one token per baseline launch and passes it to Resolve over the private network, and the toolkit's child gets only that token (ADRs 0031, 0044).
    *   A pairing code is 16 random bytes, single-use, valid for 5 minutes, held by the gate only as its SHA-256, and carried in the URL fragment so no server logs it. Trading it gives the phone the same cookie the sign-in gives.
    *   Each signed-in session has a random `countersign_session` cookie (HttpOnly, SameSite Strict, Secure on HTTPS) and its own limits on runs and resets.
    *   The console has no `GEMINI_API_KEY` on Render until phase 16.
*   **Performance & Latency.** Expected, until live check 1 measures it: the clearing transaction takes milliseconds on a demo-sized log, 30 capture reads at 3 in flight take a few seconds, and each replaced order is 3 PayPal calls, 3 orders in flight. The 60-second bound applies to every reset after the first. The console waits up to 120 seconds, twice the bound, so a slow first seed still reports. If the console times out, it shows the unreachable sentence while the gate carries on, and pressing again answers "A reset is already running." until it ends. The ledger's advisory lock is held only by appends, which take milliseconds; the 5-second lock timeout covers the table locks Resolve's writes hold. Launching a scenario is one gate round trip (key check) and one Resolve call; the run itself is as in phase 8. Every signed-in page and route also costs one `GET /approvals` on the gate to check the key; the inbox refreshes every 2 seconds while a run is working, close to the approvals board's existing 3-second poll.
*   **AI cost.** Unchanged per run; each session's run limit and the day's cap bound it, and the cap carries across resets. The sign-in and the console's missing Gemini key are under Security & Privacy.
*   **Rollout & Rollback.** Locally, the reset is off unless `COUNTERSIGN_DEMO_RESET=on`, and `RESOLVE_BASELINE` defaults to `on` (phase 8 behaviour). Two changes apply everywhere: the console's routes to Resolve need the sign-in, and `/` is the start page instead of a redirect to `/decisions`. Rolling back the hosted demo is redeploying an earlier commit; migration 0007 only adds a table.

--------------------------------------------------------------------------------

## Additional Resources

*   [Brief](../../../specs/brief.md) §3, §5 items 6, 8, 18, §6, §7, §8, §10, §11, §12, §13, §14; [original brief](../../../specs/brief.original.md) §12 and §15.
*   [Render Blueprint spec](https://render.com/docs/blueprint-spec), read 25 Oct 2026 and 31 Oct 2026 (`autoDeployTrigger`, `diskSizeGB`).
*   [`docs/spikes.md`](../../../docs/spikes.md) S4 (toolkit vulnerabilities), S7 (hosting, not started) and S8 (Gemini call times).
*   ADRs in [`docs/adr/`](../../../docs/adr/): 0019, 0022, 0023, 0024, 0026, 0030, 0031, 0032, 0035, 0038, 0039, 0041, 0042, 0043, 0044.

## Future Improvements

*   **Reset history**: keep each `demo.reset`'s old head outside the log, so a chain of resets can be checked end to end.
*   **Database-held reset lock, pairing codes and session limits**, so the gate and console can scale past one instance and survive a deploy overlap.

--------------------------------------------------------------------------------

## Detailed Implementation Plan

Each phase leaves the four Feedback commands passing. Copy, answers and sentences are exactly as in [requirements.md](requirements.md); names below are binding. Tests use PGlite (`createTestDatabase`) and never real credentials; anything live runs under `LIVE=1` only. "The four Feedback commands" are `npm run typecheck`, `npm run lint`, `npm test` and `npm run build` (validation check 1).

Existing symbols the plan uses, and where they are:

| Symbol | File |
|---|---|
| `withAuditLog`, `AuditLogWriter`, `appendPrepared` | `packages/ledger/src/log.ts` |
| `readExecutionHistory`, `executionRequestedEntry`, `executionResultEntry` | `apps/gate/src/execution-log.ts` |
| `parsePayPalEnv` | `packages/rail-paypal/src/config.ts` |
| `Environment` | `apps/gate/src/principals.ts` (`packages/db/src/target.ts` has the same type) |
| `NudgeFetch` | `apps/gate/src/nudge.ts` |
| `Approver`, `approverOnly` | `apps/gate/src/approver.ts`, `apps/gate/src/approvals-api.ts` |
| `EXIT_NEGATIVE` | `apps/gate/src/disputes-cli.ts` |
| `runSeed`, `SeedReport`, `SEED_CONCURRENCY`, `StoredRowSchema` | `apps/storefront/src/seed-run.ts`, moving to `packages/seed/src/seed-run.ts` |
| `ApprovalDeps`, `Answer<T>`, `callGate` (takes `timeoutMs`), `refusalOf`, `checkKey`, `withKey` | `apps/console/src/approval-routes.ts` |
| `ResolveDeps`, `callResolve` | `apps/console/src/resolve-routes.ts` |
| `CONTROL_CLASSES` | `apps/console/src/approvals-view.ts` |
| `approvalsUrl`, `requestOrigin`, `qrView` | `apps/console/src/qr-view.ts` |
| `formatDuration`, `POLL_INTERVAL_MS` | `apps/console/src/inbox-view.ts` |
| `resolveAgentUrl` (unset means `http://127.0.0.1:8788`) | `apps/gate/src/nudge.ts` |
| `railOnce` (the cached rail client inside `createApp`) | `apps/gate/src/app.ts` |
| `mountApprovals` (`GET`/`POST /approvals/:id`) | `apps/gate/src/approvals-api.ts` |
| `RunQueue`, `createModeRunner`, `ModeRunnerDeps` | `apps/resolve-agent/src/queue.ts` |
| `TokenIssuer`, `paypalTokenIssuer`, `connectBaseline` | `apps/resolve-agent/src/baseline.ts` |
| `FetchLike`, `reach`, `read`, `send`, `MAX_RETRIES`, `MAX_RETRY_WAIT_MS` | `packages/rail-paypal/src/client.ts` |
| `readLimited` (private today; item 19 exports the one in `resolve-routes.ts`) | `apps/console/src/resolve-routes.ts` |
| `countRunsOnDate`, `countDraftsOnDate` | `packages/db/src/runs.ts`, `packages/db/src/drafts.ts` |

`senderEmail`'s `unseeded` follows the file's `sender`: `payer:KIK-1035` with no row gives "Order KIK-1035", and `buyer:A` or `buyer:B` with no row gives "Buyer A" or "Buyer B".

### Phase 1: shared foundations (no visible change)

#### 1. `packages/seed/` (Create)

*   **Type / Scope**: New workspace `@countersign/seed`.
*   **Proposed Changes**:
    *   `package.json`: `"name": "@countersign/seed"`, `"private": true`, `"type": "module"`, `"exports": { ".": "./src/index.ts" }`, script `typecheck: tsc --noEmit`; dependencies `@countersign/carrier-mock`, `@countersign/db`, `@countersign/mandate`, `@countersign/rail-paypal` (all `0.0.0`), and devDependencies `@types/node` 26.6.5, `typescript` 5.9.3, `vitest` 4.1.12 (as `packages/carrier-mock/package.json`). zod comes from the root.
    *   `tsconfig.json`: as `packages/carrier-mock/tsconfig.json`.
    *   `git mv` `apps/storefront/src/products.ts`, `seed-catalog.ts` and `seed-run.ts` to `packages/seed/src/`, contents unchanged except that `seed-run.ts` exports its `StoredRowSchema` (the reset's order check uses the same row rules).
    *   `src/run-id.ts` (Create): move `VAULT_ENV_NAMES`, `RandomSuffixSchema`, the random suffix function (exported as `randomRunSuffix()`) and `newRunId(seededAt, suffix)` out of `apps/storefront/src/seed-cli.ts` unchanged; add `readVaultTokens(env: Readonly<Record<string, string | undefined>>): { ok: true; tokens: Record<SeedBuyer, string> } | { ok: false; missing: string[] }` (a token is present when it's a non-empty string; `missing` lists names in `VAULT_ENV_NAMES` order).
    *   `src/index.ts`: `export *` from `./products`, `./seed-catalog`, `./seed-run`, `./run-id`.
    *   `apps/gate/package.json` (Modify): add `"@countersign/seed": "0.0.0"` to `dependencies` (the reset imports it). The repo has no `tsconfig` `paths`, so nothing else is needed.
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
    *   `src/demo-reset.ts` (Create), exported from `src/index.ts`; `lockDemoTables` and `clearDemoTables` take a `Transaction` (the type `Database["transaction"]`'s callback receives), `countUnfinishedWork` takes either (`Database | Transaction`), and `countClearedRunsOnDate` takes a `Database`:
        *   `lockDemoTables(tx)`: `SET LOCAL lock_timeout = '5s'`, then `LOCK TABLE audit_log, tickets, ticket_attachments, agent_runs, dispute_drafts, evidence_documents IN ACCESS EXCLUSIVE MODE`.
        *   `countUnfinishedWork(reader): Promise<{ runs: number; drafts: number }>`: `count(*)` of `agent_runs` and `dispute_drafts` with status in (`queued`, `running`).
        *   `clearDemoTables(tx): Promise<ClearedTables>` where `ClearedTables = { entries: number; head: { seq: number; hash: string } | null; tickets: number; attachments: number; runs: number; drafts: number; documents: number }`: read the head (`audit_log` ordered by `seq` desc, limit 1) and each table's `count(*)`; then one `INSERT INTO cleared_run_counts (utc_date, runs) SELECT d, count(*)::int FROM (SELECT ((queued_at::timestamptz) AT TIME ZONE 'UTC')::date::text AS d FROM agent_runs UNION ALL SELECT ((queued_at::timestamptz) AT TIME ZONE 'UTC')::date::text FROM dispute_drafts) AS q GROUP BY d ON CONFLICT (utc_date) DO UPDATE SET runs = cleared_run_counts.runs + excluded.runs`; then `TRUNCATE TABLE audit_log, tickets, ticket_attachments, agent_runs, dispute_drafts, evidence_documents`.
        *   `countClearedRunsOnDate(db, date)`: the row's `runs` or 0; `date` checked with the same `DateSchema` as `countRunsOnDate`.
        *   `runsQueuedSince(reader, at: string): Promise<number>`: `count(*)` of `agent_runs` where `queued_at::timestamptz >= (${at}::timestamptz - interval '5 seconds')`. The cast compares instants, not strings, as `countRunsOnDate` does. The 5-second margin covers clock skew between the gate and Resolve; a run queued that close before the reset was still queued or running at the first busy check, so the margin refuses nothing extra in practice.
    *   `src/runs.ts`: unchanged.
    *   `test/demo-reset.test.ts` (Create): validation check 3, on PGlite with rows written through the package's existing writers.

#### 5. `packages/ledger/src/chain.ts` (Modify)

*   **Proposed Changes**: append `"demo.reset"` to `ENTRY_TYPES`, and to the comment ("Phase 13 adds the demo reset (ADR 0042)"). `test/chain.test.ts`: add `"demo.reset"` to the `expect(ENTRY_TYPES).toEqual([...])` list; `test/chain.test.ts` or `test/log.test.ts`: a log whose entry 1 is `demo.reset` verifies.

#### 6. `apps/resolve-agent/src/limits.ts` (Modify)

*   **Proposed Changes**: `overDailyCap` adds `countClearedRunsOnDate(db, date)` to the two counts. `test/limits.test.ts`: validation check 8.

#### 7. `apps/gate/src/dispute-sync.ts` (Create) and `disputes-cli.ts` (Modify)

*   **Proposed Changes**: move `sync()`'s body to `export async function syncDisputes(db, rail, deps: { now: () => Date; env: Environment; nudgeFetch?: NudgeFetch }): Promise<DisputeSync>` with `DisputeSync = { ok: true; lines: string[]; recorded: number; alreadyRecorded: number; problems: number } | { ok: false; error: string; lines: string[] }`. `ok: false` covers the three `cantRun` cases (unreadable log before, list failed, an entry unreadable inside the lock); `error` is the sentence the CLI prints to stderr now. `lines` are exactly today's lines. `disputes-cli.ts`'s `sync` becomes a formatter: `ok: true` → `output(problems === 0 ? EXIT_OK : EXIT_NEGATIVE, lines)`; `ok: false` → exit 2 with `lines` on stdout and `error` on stderr, as now. `test/disputes-cli.test.ts` passes unchanged; `test/dispute-sync.test.ts` (Create) checks the counts.

#### 8. `apps/gate/src/execution-log.ts`, `apps/gate/src/executors.ts` and `packages/rail-paypal/src/client.ts` (Modify)

*   **Proposed Changes**:
    *   `export async function countUnansweredRequests(reader: Reader, since: string): Promise<{ known: true; count: number } | { known: false; seq: number; detail: string }>`: the `execution.requested` entries whose `at` is at or after `since` and whose `seq` no `execution.result`'s `requestSeq` names (a replay request counts on its own). It reads both entry types in `seq` order with the module's `parsePayload`; an unreadable entry of either type makes it `known: false` (the reset then refuses, failing closed).
    *   `export async function requestedCaptureIds(reader: Reader): Promise<{ known: true; captureIds: Set<string> } | { known: false; seq: number; detail: string }>`: the `captureId` of every `execution.requested` entry that names one, whatever its outcome; an unreadable request makes it unknown.
    *   Export the module's `type Reader = Database | Transaction`, so `demo-reset.ts` can type `busyRefusal`.
    *   `executors.ts` gains only `export const MAX_RAIL_CALLS_PER_EXECUTION = 2` (below); `execute()` doesn't change. Tests in `test/execution-log.test.ts` (or a new `test/reset-reads.test.ts`): a request with a result isn't counted, one without is, one before `since` isn't, an unreadable result makes it unknown; captures come from refund requests only, failed ones included.
    *   `client.ts`:
        *   `FetchLike`'s `init` gains `signal?: AbortSignal`; test fakes that build a `FetchLike` need no change, since the field is optional.
        *   `reach` passes `signal: AbortSignal.timeout(RAIL_REQUEST_TIMEOUT_MS)` (`export const RAIL_REQUEST_TIMEOUT_MS = 30_000`) to every fetch, the token request included. The signal also bounds reading the body.
        *   `read` wraps `response.text()` in a try, so a timeout or reset while reading the body throws the same `network` `PayPalError` that `reach` throws.
        *   Network failures stay unretried, as now: `send` retries only 429 and 5xx. A timed-out request is a network failure, which the executors already record as `unknown` (ADR 0026).
        *   `export const RAIL_WORST_CALL_MS = (2 + 2 + MAX_RETRIES) * RAIL_REQUEST_TIMEOUT_MS + MAX_RETRIES * MAX_RETRY_WAIT_MS`. That covers two token requests (the first, and one after a 401), the request and its one re-authorised resend, and `MAX_RETRIES` retries, plus their waits: (2 + 2 + 2) × 30 s + 2 × 10 s = 200 s. `MAX_RETRIES` and `MAX_RETRY_WAIT_MS` are exported for it.
    *   Tests: a hung fake server, and one that hangs mid-body, each end in a `network` `PayPalError` within the timeout (with fake timers). The gate's reset test checks `EXECUTION_WINDOW_MS > MAX_RAIL_CALLS_PER_EXECUTION × RAIL_WORST_CALL_MS`. `MAX_RAIL_CALLS_PER_EXECUTION = 2` is exported from `executors.ts`: dispute actions read the dispute after acting, and payouts read the batch after creating it; refunds and invoice sends make one call. 600 s > 2 × 200 s. A comment beside `EXECUTORS` says to raise the constant if an executor gains a call.

### Phase 2: the reset in the gate

#### 9. `apps/gate/src/demo-reset.ts` (Create)

*   **Type / Scope**: The reset's core. No HTTP, no AI.
*   **Proposed Changes**:
    *   `export const DEMO_RESET_VAR = "COUNTERSIGN_DEMO_RESET"`; `export const demoResetEnabled = (env) => env[DEMO_RESET_VAR] === "on"`.
    *   `export const RESET_COOLDOWN_MS = 60_000`; `export const EXECUTION_WINDOW_MS = 600_000` (10 minutes, far longer than any rail call and its retries).
    *   `export const RESET_MESSAGES` with the 409 and 503 sentences in requirements.md (keys `running`, `executing`, `resolveBusy`, `justReset`, `changed`, `locksBusy`, `noDatabase`, `noPayPal`, `noVault` (a function of the missing names), `notCleared`).
    *   `DemoResetPayloadSchema = z.strictObject({ previous_head: z.object({ seq: z.int().positive(), hash: z.string().regex(/^[0-9a-f]{64}$/) }).nullable(), cleared: z.strictObject({ entries, tickets, attachments, runs, drafts, documents: z.int().min(0) }) })`.
    *   `export type Reseed = (input: { orders: readonly DemoOrder[]; runId: string; seededAt: string }) => Promise<SeedReport>`.
    *   `export type ResetDeps = { db?: Database; rail: () => PayPalClient; env: Environment; clock: () => Date; reseed?: Reseed; nudgeFetch?: NudgeFetch; randomSuffix?: () => string }`.
    *   `export type ResetReport = { complete: boolean; resetAt: string; tookMs: number; orders: { kept: number; replaced: string[]; runId: string | null; failed: { orderNumber: string; call: string; reason: string }[] }; cleared: { previousHead: { seq: number; hash: string } | null; entries; tickets; attachments; runs; drafts; documents } | null; disputes: { recorded: number; alreadyRecorded: number; problems: number } | { error: string } | null }`. `cleared` and `disputes` are null when a replacement failed and nothing was cleared.
    *   A private `busyRefusal(reader: Reader, now: Date): Promise<keyof typeof RESET_MESSAGES | null>` (`Reader` from `execution-log.ts`), used before the order check and again inside the lock, in this order: `countUnfinishedWork` above 0 → `resolveBusy`; `countUnansweredRequests(reader, now − EXECUTION_WINDOW_MS)` unknown or above 0 → `executing`; the audit-log row with `seq` 1 is a `demo.reset` whose `at` is less than `RESET_COOLDOWN_MS` before `now` → `justReset`.
    *   `export async function resetDemo(deps): Promise<{ ok: true; report: ResetReport } | { ok: false; status: 409 | 503; message: string }>`:
        1. `start = deps.clock()`; `resetAt = start.toISOString()`.
        2. Module-level `let running = false`: if set → 409 `running`. Set it now; clear it in `finally`.
        3. No `db` → 503 `noDatabase`. `parsePayPalEnv(env)` not ok → 503 `noPayPal`. `readVaultTokens(env)` not ok → 503 `noVault(missing)`. Build the rail with `deps.rail()` inside a try (a throw → 503 `noPayPal`).
        4. `busyRefusal(db, start)` → 409 with that message.
        5. Order check: read all `seed_orders` rows and `requestedCaptureIds(db)`; `touched` = those capture IDs, or every capture when unknown. For each `DEMO_ORDERS` entry (catalog order), with at most `SEED_CONCURRENCY` (3) in flight: replaced when there's no row, the row fails the seed run's stored-row rules (`StoredRowSchema`), `row.buyer !== demo.buyer`, `touched` holds `row.paypalCaptureId`, or `rail.getCapture(row.paypalCaptureId)` throws or answers a status other than `COMPLETED` (the capture is read only when the earlier rules keep it); kept otherwise.
        6. If any replaced: `runId = newRunId(resetAt, (deps.randomSuffix ?? randomRunSuffix)())`; `report = await (deps.reseed ?? defaultReseed)({ orders: replaced, runId, seededAt: resetAt })`, where `defaultReseed` calls `runSeed({ paypal: rail, db, orders, runId, vaultTokens, clock: () => seededAt })`. Failed orders: `report.failures` mapped to `{ orderNumber, call, reason }`; if `report.problem` is set, every replaced order not already failed is failed with call `seed` and `reason` = the problem. A throw from the reseed fails every replaced order with call `seed` and reason "the seed run failed unexpectedly". If any order failed, return now: `ok: true`, `complete: false`, `cleared: null`, `disputes: null`.
        7. `withAuditLog(db, async (log) => { await lockDemoTables(log.tx); const refusal = await busyRefusal(log.tx, deps.clock()); if (refusal) throw new ResetRefused(refusal); if (await runsQueuedSince(log.tx, resetAt) > 0 || await seededCaptureTouched(log.tx)) throw new ResetRefused("changed"); const cleared = await clearDemoTables(log.tx); await log.append({ entryType: "demo.reset", refId: null, at: resetAt, payload: { previous_head: cleared.head, cleared: { entries, tickets, attachments, runs, drafts, documents } } }); return cleared; })`, where `runsQueuedSince` (item 4) counts runs queued since `resetAt`, less its 5-second margin (a baseline run that started and finished during the replacements leaves no log entry, ADR 0031), and `seededCaptureTouched` re-reads `seed_orders` and `requestedCaptureIds(tx)` and is true when that's unknown or names any seeded capture. `ResetRefused` → 409 with its message. An error whose `code` (or `cause.code`) is `55P03` → 409 `locksBusy`. Any other error → 503 `notCleared` (the replacement orders stay; the next reset keeps them).
        8. `syncDisputes(db, rail, { now: deps.clock, env, nudgeFetch })` → `{ recorded, alreadyRecorded, problems }` or `{ error }`. It runs inside a try: anything it throws (a database error from `readDisputeState` or its own `withAuditLog`) becomes `{ error: RESET_MESSAGES.disputesUnread }` ("the gate couldn't read its records"), never a 500, because the log is already cleared. `RESET_MESSAGES` gains that key.
        9. `complete = (disputes has no error) && disputes.problems === 0`; `tookMs = deps.clock().getTime() - start.getTime()`.
    *   `export function demoResetSummary(payload)`: the two sentences in requirements.md (hash shown as first 4 + "…" + last 4).
*   **Tests** `apps/gate/test/demo-reset.test.ts` (Create): validation check 4, with `createTestDatabase()`, the gate's `test/fake-sandbox.ts` for `getCapture` and the disputes calls, an injected `reseed` that records its input and writes `seed_orders` rows for what it was given (and, for the "during the reset" cases, also writes a queued run or an execution request on a kept capture), a `nudgeFetch` fake, and a clock the test moves. Seed rows for the "already seeded" cases are written with `db.insert(seedOrders)`; execution entries through the gate's existing `executionRequestedEntry` and `executionResultEntry`.

#### 10. `apps/gate/src/demo-reset-api.ts` (Create) and `app.ts` (Modify)

*   **Proposed Changes**:
    *   `export const DEMO_RESET_PATH = "/demo/reset"`; `mountDemoReset(app, deps: { approver: Approver } & ResetDeps)`: `app.post(DEMO_RESET_PATH, approverOnly(approver), handler)`; the handler reads no body, calls `resetDemo`, answers `200` with the report in snake_case exactly as requirements.md, or `{ message }` with the refusal's status.
    *   `app.ts`: `AppDeps` gains `reseed?: Reseed`. After `mountAudit`, `if (demoResetEnabled(webhookDeps.env)) mountDemoReset(app, { approver, db: deps.db, rail: railOnce ?? (() => { throw new Error("no rail"); }), env: webhookDeps.env, clock: webhookDeps.clock, reseed: deps.reseed, nudgeFetch: deps.fetch })`. When disabled, nothing is mounted, so the path is Express's 404.
    *   `test/demo-reset-api.test.ts` (Create): validation check 5, with a listening app as `test/approvals-api.test.ts` does.

#### 11. `apps/console/src/inbox-view.ts` (Modify)

*   **Proposed Changes**: there's no reset CLI (round A). Extract `export function durationWords(ms: number): string` from `formatDuration`: `Math.round(ms / 1000)` whole seconds, "14s" under a minute, else "1m 08s" (14,600 ms is "15s"; under 500 ms is "0s"). `formatDuration` calls it. `test/inbox-view.test.ts` passes unchanged and gains cases for 0, 14,600 and 68,000 ms.

#### 12. `apps/gate/src/audit-reader.ts` (Modify)

*   **Proposed Changes**: in `summaryOf`, before the `decision` branch: `if (row.entryType === "demo.reset")` parse with `DemoResetPayloadSchema` through `parseEntry` and return `demoResetSummary`. `test/audit-reader.test.ts`: validation check 7.

#### 12a. `apps/gate/src/baseline-launch.ts` (Create) and `app.ts` (Modify)

*   **Proposed Changes**: `export const BASELINE_LAUNCH_PATH = "/baseline/launch"`; `mountBaselineLaunch(app, deps: { approver: Approver; rail: () => PayPalClient; env: Environment; fetch?: typeof fetch })`: `app.post(BASELINE_LAUNCH_PATH, approverOnly(approver), express.json({ limit: "1kb" }), handler)`. The handler: body `z.strictObject({ scenario_id: z.string().regex(/^[a-z0-9-]{1,40}$/) })` else 400 "Send JSON with scenario_id."; Resolve's address is `resolveAgentUrl(env)` from `nudge.ts` (unset or blank means `http://127.0.0.1:8788`, as for the nudge), and only a null from it → 503 "The gate can't reach Resolve, so baseline mode can't start."; the rail not built → 503 "PayPal isn't set up on the gate, so baseline mode can't start."; `rail.issueAccessToken()` throws → 502 "PayPal didn't issue a token. Try again in a minute."; then `POST <that URL>/scenarios/<id>` through `deps.fetch ?? fetch` (the global `fetch`; `AppDeps.fetch` is a `NudgeFetch` that can't return a body) with `{ mode: "baseline", paypal_token: { access_token: issued.accessToken, expires_at: issued.expiresAt } }`, `redirect: "error"` and a 10-second timeout; a 202, 400, 404, 409, 500 or 503 whose body parses (`{ ticket_id, thread_id, run_id }` or `{ message }`) is passed through; anything else → 502 "Resolve couldn't be reached. Try again in a minute." The token is never logged or answered. `app.ts`: `AppDeps` gains `launchFetch?: typeof fetch` (for tests), and after `mountAudit`, always: `mountBaselineLaunch(app, { approver, rail: railOnce ?? (() => { throw new Error("no rail"); }), env: webhookDeps.env, ...(deps.launchFetch ? { fetch: deps.launchFetch } : {}) })`. `/baseline/launch` shares no prefix with another route. `test/baseline-launch.test.ts` (Create): validation check 12's gate cases, with a fake Resolve recording the body.

#### 12b. `apps/gate/src/pairing.ts` (Create) and `app.ts` (Modify)

*   **Proposed Changes**: `export const PAIRING_TTL_MS = 300_000`; a module-level `Map<string, number>` from a code's SHA-256 hex to its expiry, at most 50 entries (adding one drops the soonest to expire; expired ones are pruned on each call). `mountPairing(app, { approver, clock })`: `POST /approvals/pairing-codes` (`approverOnly`, no body) → 201 `{ code, expires_at }` with `code` = 16 bytes from `node:crypto` as base64url (22 characters); `POST /approvals/pair` (no key; `express.json({ limit: "1kb" })`, body `z.strictObject({ code: z.string().regex(/^[A-Za-z0-9_-]{22}$/) })`) → when the hash is present and unexpired, delete it and answer 200 `{ approver_key }`; otherwise 401 "That code has expired or was used. Sign in with the approver key." Nothing logs a code or the key.
    *   **Mount order matters.** `mountApprovals` registers `GET` and `POST /approvals/:id` behind `approverOnly`, and Express matches in registration order. So `createApp` calls `mountPairing(app, { approver, clock: webhookDeps.clock })` **before** `mountApprovals`, with a comment saying why. Otherwise `POST /approvals/pair` would hit the `:id` handler's key check, and `/approvals/pairing-codes` its 404.
    *   `test/pairing.test.ts` (Create): validation check 12's pairing cases, run through `createApp` (not `mountPairing` alone). With no key, a valid code answers 200 on `POST /approvals/pair`; `POST /approvals/pairing-codes` with the approver key answers 201; `GET` and `POST /approvals/<a real step-up ID>` still behave as before.

### Phase 3: Resolve

#### 13. `apps/resolve-agent/src/scenario-file.ts` (Create) and `resolve-cli.ts` (Modify)

*   **Proposed Changes**: move `Sender`, `FileMessage`, `MessageFileSchema`, `MessageFile`, `Photo`, `loadFile` (exported as `loadMessageFile`), `senderEmail` and `resolveSenders` from `resolve-cli.ts` unchanged, except that `senderEmail`'s not-seeded refusal becomes `{ ok: false; error: string; unseeded: string | null }` where `unseeded` is "Order KIK-1035" or "Buyer A" (null for other errors) and `error` keeps today's CLI sentence. `resolve-cli.ts` imports them and re-exports `MessageFileSchema`; its output is unchanged and `test/resolve-cli.test.ts` passes unchanged.

#### 14. `apps/resolve-agent/src/baseline-policy.ts` (Create), `serve.ts` and `app.ts` (Modify)

*   **Proposed Changes**:
    *   `export type BaselinePolicy = "on" | "scenarios" | "off"`; `parseBaselinePolicy(env): { policy: BaselinePolicy; problem: string | null }` (unset or blank → `on`; exact `on`, `scenarios`, `off`; else `off` with the startup sentence); `export const BASELINE_REFUSALS = { scenariosOnly, off, noToken }` with requirements.md's sentences.
    *   `serve.ts`: parse it, log the problem line if any, pass `baseline` to `createApp`. The queue's `issueToken` stays `paypalTokenIssuer(env)`: with no PayPal variables it already throws `PayPalConfigError`, which `connectBaseline` turns into a failed connection. `serve.ts` also creates one `suppliedTokens` (below) and passes it to both `createApp` and `createModeRunner`, and passes `canMintTokens: parsePayPalEnv(env).ok` to `createApp`.
    *   `queue.ts`:
        *   `export type SuppliedToken = { accessToken: string; expiresAt: number }`.
        *   `export function createSuppliedTokens(): SuppliedTokens`, where `SuppliedTokens = { hold(runId, token): void; take(runId): SuppliedToken | undefined }`. `take` removes and returns the token. It's a plain in-process `Map`; nothing stores, logs or traces a token. `RunQueue` doesn't change.
        *   `ModeRunnerDeps` gains `suppliedTokens?: SuppliedTokens`.
        *   In `createModeRunner`, for a run ID (not a draft), the first statement is `const supplied = deps.suppliedTokens?.take(runId)`, before the status check. So every exit drops it: not `queued`, `not_configured`, a throw, or the end of the run.
        *   For a baseline run with `supplied`, `runBaseline` gets `issueToken: async () => { if (supplied.expiresAt - deps.clock().getTime() <= 60_000) throw new Error("supplied token expired"); return supplied; }` in place of `deps.issueToken`. A token that's too old fails the connection (`baseline_unavailable`) before any model call; it's checked when the run starts, not when it's queued.
        *   The fallback rerun (ADR 0044, round B): when a run with `supplied` gets its one `model_unavailable` rerun, `deps.suppliedTokens.hold(rerunId, supplied)` runs before `return rerunId`. Only that rerun gets it; `fallback === run.model` already stops a rerun of a rerun. A process restart loses the map, so the run then fails closed.
    *   `app.ts`: `AppDeps` gains `suppliedTokens?: SuppliedTokens` and `canMintTokens?: boolean` (default `true`, so existing tests don't change). `accept(res, input, origin, token?)` calls `deps.suppliedTokens?.hold(runId, token)` only on the path that calls `queue.enqueue(runId)`, just before it. The capped `not_run` path never holds a token.
    *   Tests (`test/queue.test.ts`, `test/app.test.ts`): a supplied token reaches that run's connection and is gone afterwards; a non-`queued` run drops it; a token with 60 seconds or less left fails `baseline_unavailable` with no model call; a `model_unavailable` baseline run passes its token to its one rerun, and the rerun's rerun gets none; a capped scenario holds nothing.
    *   `app.ts`: `AppDeps` gains `baseline?: BaselinePolicy` (default `on`). Move the body of `POST /messages` after the body is read into `async function accept(res, input: unknown, origin: "message" | "scenario")`: `checkMessage`; then if the checked mode is `baseline`: `off` → 400 `off`; `scenarios` and `origin === "message"` → 400 `scenariosOnly`; then the cap, store and queue exactly as now. `POST /messages` calls `accept(res, req.body, "message")`.
    *   `test/app.test.ts`: validation check 9's `/messages` cases.

#### 15. `apps/resolve-agent/src/scenarios.ts` (Create) and `app.ts` (Modify)

*   **Proposed Changes**:
    *   `LAUNCHER_SCENARIOS: readonly { id: string; file: string; modes: readonly RunMode[] }[]` as the table in requirements.md; `SCENARIOS_DIR = new URL("../scenarios/", import.meta.url)`; `loadScenario(id)` → `{ message: FileMessage; photos: Photo[] } | null` (null for an unknown ID) via `loadMessageFile`; a file that doesn't load or doesn't hold exactly one message throws (a packaging error, pinned by a test that loads all three).
    *   `app.ts`: `POST /scenarios/:id` with `express.json({ limit: "1kb" })`: no database → 503, as the other routes; unknown ID → 404; body not `z.strictObject({ mode: z.enum(["protected", "baseline"]), paypal_token: z.strictObject({ access_token: z.string().min(1).max(4096), expires_at: z.int().positive() }).optional() })`, or a `paypal_token` with `protected` → 400; mode not in the scenario's `modes` → 400 "This scenario runs in protected mode only."; `baseline` with no `paypal_token` when `deps.canMintTokens === false` → 400 `BASELINE_REFUSALS.noToken`; `senderEmail(db, message.sender)` not ok with `unseeded` → 409 `${unseeded} isn't seeded. Reset the demo first.`; other errors → 500 "Resolve couldn't store the message. Try again."; then `accept(res, { channel, sender_email, subject?, body, attachments: photos as { content_type, data }, mode }, "scenario", token)`, where `token` is `{ accessToken: paypal_token.access_token, expiresAt: paypal_token.expires_at }` when given (item 14 says how `accept` holds it). Tests cover `canMintTokens` `true` (baseline without a token is accepted) and `false` (400 `noToken`).
    *   `test/scenarios.test.ts` (Create): validation check 9's scenario cases, with `seed_orders` rows inserted for buyer A and the beat orders, and a queue fake recording run IDs.

### Phase 4: the console

#### 16. `apps/console/src/approval-routes.ts` (Modify)

*   **Proposed Changes**: `export function withSignIn<T>(request: Request, deps: ApprovalDeps, run: (key: string) => Promise<Answer<T>>, render?: (request, answer) => Response)`: `withKey(request, async (key) => { const checked = await checkKey(key, deps); return checked.ok ? run(key) : checked; }, render)`. `Refusal["status"]` gains `409` and `429`. `src/dispute-routes.ts`'s `loadDisputes` and `draftAgain` move onto `withSignIn` in place of their inline `checkKey`, so there's one pattern; `test/dispute-routes.test.ts` passes unchanged.

#### 17. `apps/console/src/resolve-routes.ts` and `app/api/resolve/**/route.ts` (Modify)

*   **Proposed Changes**: `threadsRoute(request, deps)`, `threadRoute(request, id, deps)`, `attachmentRoute(request, id, deps)` and `messagesRoute(request, deps)` run through `withSignIn` (`deps: ResolveDeps & ApprovalDeps`, which have the same fields); the inner functions (`loadThreads`, `loadThread`, `sendToResolve`, the photo read) don't change. `attachmentRoute` keeps its own byte response through `render`. The four route files pass `request`. Tests: `test/resolve-routes.test.ts` and `test/messages-route.test.ts` route-level cases send a signed-in cookie (`countersign_approver=<key>`) and a fetch fake that answers the gate's `GET /approvals` 200 with an empty view (as `test/dispute-routes.test.ts` does); new cases: no cookie → 401 without calling Resolve; gate 401 → 401 and the cookie cleared; the key never appears in a Resolve request.

#### 18. `apps/console/app/inbox/page.tsx`, `src/chat.ts`, `app/chat/customer-chat.tsx` (Modify)

*   **Proposed Changes**:
    *   Inbox: as `app/disputes/page.tsx` — read the cookie's key with `approverKeyFromHeader`; none → `<SignIn title="Inbox" line=… message={null} />` in the shell; `checkKey` 401 → the same with "Sign in again."; 502 → the existing `Notice`; then the existing page.
    *   Chat: `export const CHAT_SIGNED_OUT` with requirements.md's sentence; the load and send functions map a 401 to `{ ok: false, missing: false, signedOut: true, message: CHAT_SIGNED_OUT }` (other results gain `signedOut: false`); the chat shows the sentence and a link "Go to the start page" to `/` in place of the form. `test/chat.test.ts` covers the 401 mapping.

#### 19. `apps/console/src/demo-schemas.ts`, `src/demo-routes.ts`, `app/api/scenarios/route.ts`, `app/api/demo/reset/route.ts` (Create)

*   **Proposed Changes**:
    *   Schemas: `ScenarioRequestSchema = z.strictObject({ scenario_id: z.string().regex(/^[a-z0-9-]{1,40}$/), mode: z.enum(["protected", "baseline"]) })` (Resolve decides which IDs exist); `ScenarioAcceptedSchema` = `MessageAcceptedSchema`; `ResetReportSchema` matching requirements.md's report (snake_case, `cleared` and `disputes` nullable, counts `z.int().min(0)`, order numbers `/^KIK-\d{4}$/`, at most 30 each).
    *   `scenarioRoute(request, deps)`: read at most 1 KB (`readLimited` from `resolve-routes.ts`, exported), parse JSON and the schema (400 "Send JSON with scenario_id and mode."), then `withSignIn(request, deps, async (key) => limitSession(request, "run") ?? launch(key))` (item 19a gives the order of the checks). `protected` → `callResolve(deps, "/scenarios/<id>", { json: JSON.stringify({ mode }) })`; `baseline` → `callGate(deps, key, "/baseline/launch", { json: JSON.stringify({ scenario_id }) })`, so the gate mints the token (item 12a). Either way: 202 parsed → 202; 400/404/409 with a parsed `{ message }` → that status and sentence; from the gate, 502/503 with a parsed `{ message }` → passed through; anything else → 502 `RESOLVE_UNREACHABLE`.
    *   `messagesRoute` (item 17) also calls `limitSession(request, "run")` first inside its `withSignIn` callback, in the same way.
    *   `resetRoute(request, deps)`: `withKey(request, async (key) => limitSession(request, "reset") ?? sendReset(key))`, where `sendReset` returns an `Answer` from `callGate(deps with timeoutMs: 120_000, key, "/demo/reset", { json: "{}" })`: 200 parsed with `ResetReportSchema` → 200; 404 → 404 "The demo reset is off on this gate."; 401 → as `refusalOf`; 409/503 with `{ message }` → passed through; anything else → 502 unreachable.
    *   Route files: `runtime = "nodejs"`, `dynamic = "force-dynamic"`, `POST` only.
    *   `test/demo-routes.test.ts` (Create): validation check 10's route cases.

#### 19a. `apps/console/src/session-limits.ts`, `app/api/approvals/pair/route.ts` (Create); `src/approval-routes.ts` (Modify)

*   **Proposed Changes**:
    *   `session-limits.ts`: `SESSION_COOKIE = "countersign_session"`; `newSessionCookie(request)` (16 bytes from `node:crypto`, base64url; HttpOnly, SameSite=Strict, Path=/, the approver cookie's Max-Age, Secure on HTTPS, built as `approval-routes.ts`'s `cookie()` is); `SESSION_LIMITS = { run: 12, reset: 3 }` per `SESSION_WINDOW_MS = 600_000`; `limitSession(request, kind, now = Date.now()): Refusal | null`: no session cookie → `refuse(401, APPROVAL_ROUTE_MESSAGES.signInAgain)`, which the route's renderer (`refusalResponse`) turns into a 401 that clears the approver cookie; over the limit in the window → `refuse(429, …)` with requirements.md's sentence; else it records the request and returns null.
    *   **The order of the checks** on every limited route: (1) `withKey`: no usable key cookie → 401 without asking the gate; (2) `withSignIn` only: `checkKey` with the gate → 401 or 502; (3) `limitSession` inside the callback: session cookie, then the limit; (4) the call to Resolve or the gate. A stranger or a wrong key never spends a slot. `resetRoute` has no gate key check of its own (the gate's `/demo/reset` checks the key), so it runs `limitSession` right after `withKey`. Only `POST /api/scenarios`, `POST /api/resolve/messages` and `POST /api/demo/reset` are limited. `GET` routes, the attachment route and the approvals and dispute routes aren't. A module-level `Map<string, number[]>` (session → request times), pruned on each call, at most 5,000 sessions (oldest dropped). `resetSessionLimits()` for tests.
    *   `approval-routes.ts`: the private `json(status, body, setCookieHeader?)` takes `setCookieHeader?: string | readonly string[]` and calls `headers.append("Set-Cookie", …)` once per value. `signInRoute` passes `[setCookie(request, key), newSessionCookie(request)]` on success; `signOutRoute` passes both cleared cookies. `callGate`'s `key` becomes `string | null`, and null sends no `authorization` header.
    *   `pairRoute(request, deps)` in `approval-routes.ts`, served by `app/api/approvals/pair/route.ts` (`POST`, `runtime = "nodejs"`, `dynamic = "force-dynamic"`): body `{ code }` (at most 1 KB) → `callGate(deps, null, "/approvals/pair", { json })`; 200 with a parsed `{ approver_key }` → 200 `{ ok: true }` with the approver cookie (`setCookie`) and a new session cookie; 401 → 401 with the gate's sentence; anything else → 502 unreachable. The key is never put in the answer body.
    *   `test/session-limits.test.ts` and `test/pair-route.test.ts` (Create): validation check 12's console cases. The route tests of items 17 and 19 send a session cookie with the approver cookie and call `resetSessionLimits()` between cases.

#### 20. `apps/console/src/start-view.ts` (Create)

*   **Proposed Changes**: `START_COPY` (every string in requirements.md's start-page section); `SCENARIO_CARDS` (id, title, line, look-for, buttons as `{ mode, label, variant: "primary" | "secondary" }[]`); `storefrontLink(env)` → the URL when `STOREFRONT_URL` parses as http(s), else null; `resetSentence(report)` → `{ sentence, tone }` per requirements.md (tone `positive` when complete, `warning` otherwise), with durations from `durationWords` in `inbox-view.ts` (item 11). `test/start-view.test.ts` (Create) pins the copy, card order and every sentence; a cross-check imports `LAUNCHER_SCENARIOS` from `@countersign/resolve-agent/src/scenarios` (test-only, as resolve's tests import the gate; `apps/console/package.json` gains the devDependency `"@countersign/resolve-agent": "0.0.0"`) and asserts the IDs and modes match `SCENARIO_CARDS`.

#### 21. Start page UI (Create/Modify)

*   **Proposed Changes**:
    *   `app/page.tsx` (Modify): replace the redirect with a server component: `metadata.title` "Start here · Countersign console", `dynamic = "force-dynamic"`; read the cookie key; signed in when `checkKey` is ok; a 401 or no key is signed out; a 502 shows the guide and then the existing `Notice` with `APPROVAL_ROUTE_MESSAGES.unreachable` in place of the sign-in, scenarios, phone code and reset. Render in `<ConsoleShell>` a column `mx-auto flex w-full max-w-2xl flex-col gap-8 px-4 pt-5 pb-8 md:px-6`: header (`text-heading-6 font-semibold tracking-heading`, line `text-body-base text-secondary-foreground`); "In about a minute" (`h2 text-body-sm font-medium`, `ol` with `list-decimal pl-5 text-body-base`); "What's real" and "What's simulated" as a two-item `dl` in a tinted card (`rounded-2xl bg-card p-4`); the storefront line when `storefrontLink` isn't null (link `text-brand-foreground hover:underline`); then signed out `<SignIn level={2} …>`, signed in the scenarios, the phone code (from `approvalsUrl({ publicUrl: process.env.CONSOLE_PUBLIC_URL, origin: requestOrigin(headers) })` plus `#pair=<code>` when `callGate(deps, key, "/approvals/pairing-codes", { json: "{}" })` (a POST) answers exactly 201 with a parsed `{ code }`; any other status, a null or an unparsed body gives the plain URL; then `qrView`), and the reset section.
    *   `app/approvals/pair-from-link.tsx` (Create, `"use client"`), rendered by `app/approvals/page.tsx` in both its signed-out and signed-in states: on mount, if `location.hash` holds `pair=<code>`, it removes the hash with `history.replaceState`, posts `{ code }` to `/api/approvals/pair`, then `router.refresh()` on 200; on 401 it shows the gate's sentence above the sign-in (`text-caption-lg text-danger-foreground`, `role="alert"`). It renders nothing otherwise.
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
    diskSizeGB: 5

services:
  - type: web
    name: countersign-gate
    runtime: node
    plan: 0.5c-512mb
    region: oregon
    autoDeployTrigger: "off"
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
    autoDeployTrigger: "off"
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
    autoDeployTrigger: "off"
    buildCommand: npm ci --include=dev && npm run build --workspace @countersign/console
    startCommand: GATE_URL=http://$GATE_HOSTPORT RESOLVE_AGENT_URL=http://$RESOLVE_AGENT_HOSTPORT npm run start --workspace @countersign/console -- -H 0.0.0.0
    healthCheckPath: /
    envVars:
      - key: NODE_VERSION
        value: 26.7.0
      - key: STOREFRONT_URL
        sync: false
      - key: CONSOLE_PUBLIC_URL
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
    autoDeployTrigger: "off"
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
    autoDeployTrigger: "off"
    schedule: "*/10 * * * *"
    buildCommand: npm ci --include=dev
    startCommand: npm run reconcile; status=$?; RESOLVE_AGENT_URL=http://$RESOLVE_AGENT_HOSTPORT npm run disputes -- sync && exit $status
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

*   **Proposed Changes**: `npm install --save-exact --save-dev yaml@2.9.1` at the root (add it to `specs/tech-stack.md`'s pinned table). The test reads `render.yaml` with `parse` from `yaml` and checks invariants, not the file's every line: the one database (version 18, empty allow list, a disk); the five services' `type` and `name`, a `plan` that's never `free`, one `region`, `autoDeployTrigger` `off`, the gate's `healthCheckPath` `/health` and `preDeployCommand` `npm run db:migrate`; each service's exact set of `envVars` keys; every `fromService` names a declared service of that type and `fromDatabase` the declared database; every `$X_HOSTPORT` a start command uses is declared on that service as a `fromService … property: hostport`; each start-command prefix sets exactly the URL variable the code reads (`GATE_URL`, `GATE_MCP_URL` ending `/mcp`, `RESOLVE_AGENT_URL`) from the hostport of the service that serves it; `NODE_VERSION` 26.7.0 everywhere; no `value` matches a secret pattern (`/(sk|pk|AIza|EC|A21AA)[A-Za-z0-9_-]{10,}/`, or longer than 40 characters, except the sandbox URL); `GEMINI_API_KEY` appears only on Resolve; no `PAYPAL_*` variable is on Resolve; the three Countersign keys are generated on the gate only; `PAYPAL_SEED_VAULT_TOKEN*` only on the gate.

#### 24. Docs and constitution (Create/Modify)

*   **Proposed Changes**:
    *   `docs/hosting.md` (Create): requirements.md's hosting section, as owner steps: create the Blueprint from `render.yaml`; the table of `sync: false` values per service; after the first deploy, copy the generated approver key into the Devpost testing instructions and the ops key into `.env.local` for `npm run agent`; register the webhook (three event groups) and set `PAYPAL_WEBHOOK_ID`; set `STOREFRONT_URL` and `CONSOLE_PUBLIC_URL` (the console's own `https://…onrender.com` URL, so the phone code never depends on proxy headers); sign in on the console and press Reset once; run `npm run ledger -- verify` from the gate's Render Shell; keep every service at one instance. Also: deploys are manual (`autoDeployTrigger: off`), so deploy when no run is queued and press Reset after; open one dispute on `KIK-1032` per expected judge, since each serves one; rotating the approver key (generate a new value on the gate, redeploy the gate, update the Devpost text; signed-in browsers sign in again).
    *   `docs/judge-guide.md` (Create): the start page's five steps, including that the phone code signs the phone in (and that pasting the key works if the code has expired), where the approver key and the sandbox buyer login are (Devpost testing instructions), what's real and simulated, and that baseline mode runs only the attack email on the hosted demo.
    *   `CONTEXT.md`: **Approver key** lists what it now opens (step-ups, the inbox and chat, the launcher, the reset); **Seed state** reads as ADR 0044 does (orders, trackers and carrier records restored; the scenario files are the tickets; receipts from phase 18); **Demo reset** says it replaces touched orders before it clears, and that it runs only when the gate has `COUNTERSIGN_DEMO_RESET=on`.
    *   `specs/tech-stack.md`: layout gains `packages/seed/` and `render.yaml`; pinned `yaml` 2.9.1 (root, devDependency); a "Hosting" paragraph per ADR 0041; "Demo reset" conventions per ADRs 0042 and 0044; "Secrets and environment" gains `COUNTERSIGN_DEMO_RESET`, `RESOLVE_BASELINE`, `STOREFRONT_URL`, `CONSOLE_PUBLIC_URL` on Render and the gate's vault tokens; the Resolve conventions gain the sign-in on routes to Resolve, the baseline policy and gate-minted baseline tokens on Render; the console conventions gain the session cookie, its limits and phone pairing.

### Phase 6: live check

#### 25. `apps/gate/test/reset-live.test.ts` (Create)

*   **Proposed Changes**: `describe.skipIf(process.env.LIVE !== "1" || !vault tokens || !PayPal env)`; a fresh PGlite in a temp dir; `resetDemo` with the real rail client, no injected reseed, and a clock that runs 61 seconds ahead after each reset (past the cooldown): first reset replaces 30 and `complete`; second keeps 30; refund $1.00 on `KIK-1013`'s capture through `rail.refundCapture` with a fresh request ID; third replaces exactly `KIK-1013`. Logs each `tookMs` with `console.log` (no secret). Timeout 180 s.

### Verification Plan

*   **Compilation/Build**: `npm run typecheck`, `npm run build` (both Next apps, with `@countersign/seed` transpiled).
*   **Unit Tests**: `npm test`: every test named above, plus all existing tests (the disputes CLI, resolve CLI, dispute routes and storefront seed tests unchanged in what they assert).
*   **Static Analysis & Linting**: `npm run lint`; the Graphite design check (part of `npm test`) on every changed console file.
*   **Test Coverage Requirement**: every refusal sentence and status in requirements.md has a test; every branch of the order check (kept, missing, unreadable, wrong buyer, in the execution history, unreadable history, non-`COMPLETED`, read failure) and every refusal inside the lock has a test.
*   **E2E/Integration**: `LIVE=1 npm test -- apps/gate/test/reset-live.test.ts` when the vault tokens are set; Render checks are the owner's (`validation.md` manual checks 1 to 10).

--------------------------------------------------------------------------------

*Drafted with EGM*
