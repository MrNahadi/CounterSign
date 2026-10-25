# Phase 13 requirements: the hosted judge path

Brief §5 items 6, 8 and 18, §3 (judges: "hosted URL, sandbox login, scenario launcher, reset"), §8 (the hosted demo stays up to 22 Dec; sandbox only; no secrets in the repo; judge credentials are sandbox-only; the public demo can't run up unbounded AI cost; fail closed; simulation labelled; Graphite), §11 (reset in ≤ 60 seconds), §12 (judge guide with an approver login and a reset button; reset restores the seed state in ≤ 60 seconds; Render on paid plans). Decisions: ADRs 0041 (Render), 0042 (the demo reset) and 0043 (the start page, the sign-in on Resolve routes, hosted baseline), applying 0022, 0023, 0030, 0031, 0032, 0035 and 0038. Where this file and the brief disagree, the brief wins. The design is `design.md`.

## Behaviour

### The seed package (`@countersign/seed`)

- A new workspace, `packages/seed`, exporting from `./src/index.ts` what the storefront has today in `products.ts`, `seed-catalog.ts` and `seed-run.ts`, unchanged in behaviour, plus `newRunId(seededAt, suffix)` and `VAULT_ENV_NAMES` (moved from `seed-cli.ts`), a `randomRunSuffix()` (6 characters from `[a-z0-9]`, from `node:crypto`) and `readVaultTokens(env)` → `{ ok: true, tokens: { A, B } } | { ok: false, missing: string[] }` (names only).
- The storefront imports all of it from `@countersign/seed`; `npm run seed` behaves and prints exactly as before. `seed-cli.ts` keeps exporting `newRunId` and `VAULT_ENV_NAMES` by re-export.
- It never imports an AI SDK; the no-AI test covers it.

### Clearing the demo tables (`@countersign/db`)

- Migration 0007 adds `cleared_run_counts (utc_date text primary key, runs integer not null)`. Not hashed, no trigger.
- `lockDemoTables(tx)`: `SET LOCAL lock_timeout = '5s'`, then `LOCK TABLE audit_log, tickets, ticket_attachments, agent_runs, dispute_drafts, evidence_documents IN ACCESS EXCLUSIVE MODE`.
- `countUnfinishedWork(tx)` → `{ runs, drafts }`: rows whose status is `queued` or `running`.
- `clearDemoTables(tx)` → `{ entries, head: { seq, hash } | null, tickets, attachments, runs, drafts, documents }`: reads the audit log's last row and every table's row count, adds each UTC date's agent-run count plus dispute-draft count (by `queued_at`) to `cleared_run_counts` (inserting or adding to the date's row), then `TRUNCATE`s the six tables in one statement. It never touches `seed_orders`, `carrier_shipments` or `cleared_run_counts` rows other than adding.
- `countClearedRunsOnDate(db, date)` → the date's `runs`, or 0.

### The ledger

- `ENTRY_TYPES` gains `demo.reset`. Nothing else in the ledger changes; `ledger verify` passes on a log whose entry 1 is a `demo.reset`.

### The demo reset (gate)

- **Enabled** only when `COUNTERSIGN_DEMO_RESET` is exactly `on`. Otherwise `POST /demo/reset` isn't mounted (404) and `npm run reset` exits 2: "The demo reset is off. Set COUNTERSIGN_DEMO_RESET=on only for a demo database."
- **`POST /demo/reset`**, approver key only (`Authorization: Bearer`, checked first; 401 "A valid approver key is required.", as the approval API). No body is read. Answers JSON:
  - `200` with the report below (also when `complete` is false).
  - `409` `{ message }`: "A reset is already running." / "Countersign is carrying out an approved action. Try again in a minute." / "Resolve is still working on a message. Try again in a minute." / "Countersign is busy writing. Try again in a minute." (a lock not granted in 5 seconds). Nothing changed.
  - `503` `{ message }`: "The gate has no database, so the demo can't be reset." / "PayPal isn't set up on the gate, so the demo can't be reset." / "Set PAYPAL_SEED_VAULT_TOKEN and PAYPAL_SEED_VAULT_TOKEN_B on the gate to reset the demo." (only the missing names) / "The demo couldn't be reset. Nothing was cleared." (the transaction failed). Nothing changed.
- **Order of work**: (1) the checks above, before any write; (2) one `withAuditLog` transaction: `lockDemoTables`, `countUnfinishedWork` (any → 409), `clearDemoTables`, then append `demo.reset` (ref null, `at` the reset time) with payload `{ previous_head: { seq, hash } | null, cleared: { entries, tickets, attachments, runs, drafts, documents } }`; (3) after commit, the order check and replacement; (4) dispute sync; (5) the report.
- **The order check**: for each catalog order (`DEMO_ORDERS`, `KIK-1013` to `KIK-1042`), 3 at a time: kept when its `seed_orders` row exists, reads (the seed run's row rules), has the catalog's buyer, and `getCapture(row.paypalCaptureId)` answers status `COMPLETED`; replaced otherwise, including when the capture read throws. If any are replaced, one `runSeed` with `orders` = exactly those, `runId` = `newRunId(resetAt, randomRunSuffix())` and the vault tokens.
- **Dispute sync**: the shared `syncDisputes` (below) with the reset time; its nudges go to `RESOLVE_AGENT_URL`.
- **One at a time**, in-process. **In-flight executions**: `execute()` in `executors.ts` counts calls in progress (incremented before the executor, decremented in `finally`); `executionsInFlight()` reads it. The reset refuses while it's above 0.
- **Report** (`200`):
  ```
  { complete, reset_at, took_ms,
    previous_head: { seq, hash } | null,
    cleared: { entries, tickets, attachments, runs, drafts, documents },
    orders: { kept, replaced: ["KIK-…"], run_id: string | null,
              failed: [{ order_number, call, reason }] },
    disputes: { recorded, already_recorded, problems } | { error } }
  ```
  `complete` is true when no order failed, the seed reported no problem, and the dispute sync read the list with no problems. `took_ms` is wall time from the request to the report. A seed `problem` (both buyers one account) fails every replaced order with call `seed` and that sentence.
- **`npm run reset`** (`apps/gate/src/reset-cli.ts`, `reset-main.ts`, root script with `--env-file-if-exists=.env.local`), `[--pglite <dir>]`, database chosen as every CLI. Same checks and order (no approver key; it's local). Output, one line each:
  - "Reset the demo in 12s. Cleared 41 audit-log entries, 6 tickets and 6 runs." (durations as the brand book, "12s" or "1m 08s"; counts pluralised; attachments, drafts and documents named only when not 0)
  - "Kept 27 seeded orders. Replaced 3 in run 20261101abc123: KIK-1035, KIK-1037, KIK-1042." / "Kept all 30 seeded orders."
  - one line per failed order: "KIK-1035 create-order <reason>."
  - "Recorded 1 dispute again." / "No disputes are waiting for the seller." / "Couldn't read the disputes: <error>"
  Exit 0 when `complete`, 1 when not, 2 when it can't run (each 409 or 503 sentence as stderr).
- **Dispute sync as a function**: `syncDisputes(db, rail, { now, env, nudgeFetch? })` in `apps/gate/src/dispute-sync.ts` returns `{ ok: true, lines, recorded, alreadyRecorded, problems } | { ok: false, error, lines }`; `npm run disputes -- sync` formats it with the same lines and exit codes as now.
- **The audit reader** summarises `demo.reset` as "The demo was reset. The log before it ended at entry 41 (hash 3f9a…c2d1)." (the first 4 and last 4 hex characters), or "The demo was reset. The log was empty before it." An unreadable payload is listed as unreadable, like any entry.

### Resolve

- **`RESOLVE_BASELINE`**: `on` (unset or blank), `scenarios` or `off`. Any other value counts as `off`, with the startup line "RESOLVE_BASELINE must be on, scenarios or off. Baseline mode is off."
- **`POST /messages`** with `mode: baseline`: allowed under `on`; under `scenarios` 400 "Here, baseline mode runs only the demo scenarios. Start one from the console's start page."; under `off` 400 "Baseline mode is off on this Resolve." Protected messages are unchanged.
- **`POST /scenarios/:id`**, body `{ mode: "protected" | "baseline" }` (zod, strict). The scenarios, in `apps/resolve-agent/src/scenarios.ts`:

  | ID | File | Modes |
  |---|---|---|
  | `beat-3-attack-email` | `scenarios/beat-3-attack-email.json` | protected, baseline |
  | `beat-4-stalled-parcel` | `scenarios/beat-4-stalled-parcel.json` | protected |
  | `beat-5-damaged` | `scenarios/beat-5-damaged.json` | protected |

  It loads the file and its photos with the CLI's rules (now in `src/scenario-file.ts`), resolves the one message's sender from `seed_orders`, builds the same body `POST /messages` takes, and accepts it through the same path (check, cap, store, queue). Answers: `202 { ticket_id, thread_id, run_id }`; `404` "There's no scenario with that ID."; `400` "Send JSON with mode, protected or baseline." / "This scenario runs in protected mode only." / the baseline-off sentence above (baseline is allowed under `on` and `scenarios`); `409` "Order KIK-1035 isn't seeded. Reset the demo first." or "Buyer A isn't seeded. Reset the demo first."; `500` "Resolve couldn't store the message. Try again."; `503` without a database, as other routes.
- **The daily cap** counts today's runs, today's drafts and `countClearedRunsOnDate` for today.

### The console

Every screen follows `Graphite Design/DESIGN.md` and the brand book: semantic tokens only, Lucide icons, no emojis, light and dark, desktop and phone widths.

- **Sign-in on every route to Resolve.** One helper in `approval-routes.ts`, `withSignIn(request, deps, run)`: `withKey`, then `checkKey` with the gate, then `run(key)`; the key never goes to Resolve. It wraps `GET /api/resolve/threads`, `GET /api/resolve/threads/[id]`, `GET /api/resolve/attachments/[id]`, `POST /api/resolve/messages` and the new `POST /api/scenarios`. Signed out, they answer as the dispute routes do (401 "Sign in with the approver key." / "Sign in again.", 502 when the gate can't be reached).
- **The inbox page** checks the cookie's key with the gate before reading Resolve. Signed out: the shared sign-in, title "Inbox", line "Sign in with the approver key to see the inbox." A 401 from the gate shows it with "Sign in again.".
- **The customer chat** (`/chat`) shows, on a 401 from either route: "Sign in with the approver key on the start page, then come back." with a link "Go to the start page" to `/`.
- **`POST /api/scenarios`**, body `{ scenario_id, mode }` (zod, 1 KB at most) → Resolve `POST /scenarios/<id>` with `{ mode }` → `202 { ticket_id, thread_id, run_id }`, or Resolve's sentence with its status (400, 404, 409), or 502 `RESOLVE_UNREACHABLE`.
- **`POST /api/demo/reset`** → the cookie's key to the gate's `POST /demo/reset` (120-second timeout) → the gate's status and body (the report, or its sentence) passed through after zod parsing; 404 from the gate becomes 404 "The demo reset is off on this gate."; 401 clears the cookie as other approval routes; unreachable or unreadable → 502 `APPROVAL_ROUTE_MESSAGES.unreachable`.
- **The start page** (`/`, title "Start here · Countersign console"), inside the console shell, sidebar item "Start here" (Lucide `Compass`) first. Copy, exactly:
  - Heading "Start here". Line: "Countersign checks every money action an AI agent proposes against PayPal's records and your rules. The agent's words never approve a payment."
  - "In about a minute", an ordered list:
    1. "Sign in with the approver key from the testing instructions."
    2. "Run the attack email in baseline mode, then protected, and compare what moved."
    3. "Run the stalled parcel and the damaged basket. Each opens in the inbox, linked to its decisions."
    4. "Open Approvals on your phone with the code below, and approve the held refund."
    5. "Reset the demo when you're done, so the next person starts fresh."
  - "What's real" — "PayPal sandbox orders, captures, refunds, disputes and webhooks, and Countersign's decisions, approvals and audit log." "What's simulated" — "The customers and their messages, the carrier's delivery status, and the shop and its people, who are illustrative."
  - When `STOREFRONT_URL` is an http(s) URL: "Want a real sandbox checkout? Buy something on the Kikapu storefront." with "Kikapu storefront" linking there (opens in the same tab).
  - Signed out: the shared sign-in at heading level 2, title "Sign in", line "Sign in with the approver key to run the scenarios and reset the demo."
  - Signed in, "Scenarios", one card each (Graphite Card, ringed on the container):

    | Scenario | Title | Line | What to look for | Buttons |
    |---|---|---|---|---|
    | beat 3 | The attack email | "A customer says KIK-1042 never arrived, and hidden text asks for refunds on four orders other people paid for." | "Baseline: the agent calls PayPal's refund tool directly. Protected: Countersign denies what the records don't support and holds the rest." | "Run in baseline mode" (secondary), "Run protected" (primary) |
    | beat 4 | The stalled parcel | "The payer of KIK-1035 says her $18.00 coaster set never arrived. The carrier shows it stalled for over ten days." | "The refund runs on its own, with a real sandbox refund ID." | "Run protected" (primary) |
    | beat 5 | The damaged basket | "The payer of KIK-1037 sends a photo of a split basket and asks for her $240.00 back." | "It waits for you. Approve it on the Approvals page or your phone." | "Run protected" (primary) |

    A pending button shows the spinner and keeps its label. On 202 the page navigates to `/inbox?thread=<thread_id>`. On a refusal, the card shows the sentence below its buttons in `danger-foreground`.
  - Signed in, the "Open on your phone" code for `/approvals` (the approvals page's component, moved to a shared file), shown from 768px up.
  - Signed in, "Reset the demo": line "Clears the inbox, decisions and audit log, and replaces any order a scenario refunded. It takes up to a minute." Button "Reset demo" (danger subtle). A dialog (Graphite Dialog, a drawer under 640px): title "Reset the demo?", description "Everyone using this demo starts again from the seed orders. The audit log restarts with one entry that records where the old log ended.", buttons "Cancel" and "Reset demo" (danger, pending shows the spinner and "Resetting"). After it, one line in a `Notice`:
    - complete: "Reset in 14s. Replaced 3 orders and kept 27. Recorded 1 dispute again." ("Kept all 30 orders." when none replaced; the dispute sentence is left out when none were recorded). Durations as the brand book: "14s", "1m 08s".
    - not complete: "Reset, but 2 orders couldn't be replaced: KIK-1035, KIK-1037. Reset again to retry." and/or "Reset, but the disputes couldn't be read again: <error>"
    - a refusal: the gate's sentence.
- **`/` no longer redirects** to `/decisions`.
- Console schemas for the scenario answer and the reset report live in `src/demo-schemas.ts`.

### Hosting (`render.yaml`)

- As ADR 0041: the services, plans, commands, health checks, internal addresses through `*_HOSTPORT` and start-command prefixes, generated keys, `sync: false` secrets, `NODE_VERSION` 26.7.0, `COUNTERSIGN_DEMO_RESET=on`, `RESOLVE_BASELINE=scenarios`, `RESOLVE_DAILY_RUN_CAP=200`, `PORT=10000` on Resolve, Postgres 18 with `ipAllowList: []`, and the cron job every 10 minutes. The exact file is in `design.md`.
- `docs/hosting.md`: how the owner creates the blueprint, which values to type in, what to copy after the first deploy (the generated keys, the gate's URL for the webhook), the first Reset, and how to run `ledger verify` from the gate's Render Shell.
- `docs/judge-guide.md`: the start page's steps for the README (phase 20), with where each credential is (the approver key and the sandbox buyer login in the Devpost testing instructions), and what's real and simulated.

## Constraints

- No AI in the gate, `packages/mandate`, `packages/verifiers`, `packages/ledger`, `packages/db` or `packages/seed`; the no-AI test covers the packages. The reset and the launcher add no AI call; a scenario run is an ordinary Resolve run under the daily cap.
- Fail closed: the reset changes nothing unless every check passes and the transaction commits; it never runs while Resolve or an execution is mid-flight; a reset never raises the day's run cap; on the hosted demo no visitor text reaches baseline mode.
- The approver key is checked by the gate only and never sent to Resolve, logged or stored by the console beyond its HttpOnly cookie. Principal keys never open the reset.
- Every external input is read with zod 4: the scenario and reset requests, Resolve's and the gate's answers in the console, `RESOLVE_BASELINE`, `COUNTERSIGN_DEMO_RESET`.
- Sandbox only. The reset creates sandbox orders paid by the seed buyers' vault tokens, as `npm run seed` does, and nothing else.
- No secret in `render.yaml`, logs, answers or the repo; variables are named, never shown.
- Copy follows the brand book: plain, short, sentence case, no exclamation marks, pluralised counts. Illustrative people and shops stay labelled.

## Technical needs

- New dependency: `yaml` 2.9.1 (root devDependency, published 11 Sep 2026), for the blueprint test only.
- New workspace: `packages/seed` (`@countersign/seed`), depending on `@countersign/carrier-mock`, `@countersign/db`, `@countersign/mandate`, `@countersign/rail-paypal` and `zod`. The gate and the storefront depend on it; the storefront's `next.config.ts` adds it to `transpilePackages`.
- New env: `COUNTERSIGN_DEMO_RESET` (gate and `npm run reset`), `RESOLVE_BASELINE` (Resolve), `STOREFRONT_URL` (console, optional). The gate also reads `PAYPAL_SEED_VAULT_TOKEN` and `PAYPAL_SEED_VAULT_TOKEN_B` for the reset.
- New root script: `reset`.
- Live checks run only under `LIVE=1`, never in the Feedback commands: `apps/gate/test/reset-live.test.ts` (sandbox PayPal, PGlite, needs the vault tokens). Everything else that needs Render is the owner's (`validation.md`, `.ralph/human.md`).
