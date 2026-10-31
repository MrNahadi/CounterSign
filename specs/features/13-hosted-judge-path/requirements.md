# Phase 13 requirements: the hosted judge path

Brief §5 items 6, 8 and 18, §3 (judges: "hosted URL, sandbox login, scenario launcher, reset"), §8 (the hosted demo stays up to 22 Dec; sandbox only; no secrets in the repo; judge credentials are sandbox-only; the public demo can't run up unbounded AI cost; fail closed; simulation labelled; Graphite), §11 (reset in ≤ 60 seconds), §12 (judge guide with an approver login and a reset button; reset restores the seed state in ≤ 60 seconds; Render on paid plans). Decisions: ADRs 0041 (Render), 0042 (the demo reset), 0043 (the start page, the sign-in on Resolve routes, hosted baseline) and 0044 (round A's changes to them), applying 0022, 0023, 0030, 0031, 0032, 0035 and 0038. Where this file and the brief disagree, the brief wins. The design is `design.md`.

## Behaviour

### The seed package (`@countersign/seed`)

- A new workspace, `packages/seed`, exporting from `./src/index.ts` what the storefront has today in `products.ts`, `seed-catalog.ts` and `seed-run.ts`, unchanged in behaviour, plus `newRunId(seededAt, suffix)` and `VAULT_ENV_NAMES` (moved from `seed-cli.ts`), a `randomRunSuffix()` (6 characters from `[a-z0-9]`, from `node:crypto`) and `readVaultTokens(env)` → `{ ok: true, tokens: { A, B } } | { ok: false, missing: string[] }` (names only).
- The storefront imports all of it from `@countersign/seed`; `npm run seed` behaves and prints exactly as before. `seed-cli.ts` keeps exporting `newRunId` and `VAULT_ENV_NAMES` by re-export.
- It never imports an AI SDK; the no-AI test covers it.

### Clearing the demo tables (`@countersign/db`)

- Migration 0007 adds `cleared_run_counts (utc_date text primary key, runs integer not null)`. Not hashed, no trigger.
- `lockDemoTables(tx)`: `SET LOCAL lock_timeout = '5s'`, then `LOCK TABLE audit_log, tickets, ticket_attachments, agent_runs, dispute_drafts, evidence_documents IN ACCESS EXCLUSIVE MODE`.
- `countUnfinishedWork(reader)` (a database or a transaction) → `{ runs, drafts }`: rows whose status is `queued` or `running`.
- `clearDemoTables(tx)` → `{ entries, head: { seq, hash } | null, tickets, attachments, runs, drafts, documents }`: reads the audit log's last row and every table's row count, adds each UTC date's agent-run count plus dispute-draft count (by `queued_at`) to `cleared_run_counts` (inserting or adding to the date's row), then `TRUNCATE`s the six tables in one statement. It never touches `seed_orders`, `carrier_shipments` or `cleared_run_counts` rows other than adding.
- `countClearedRunsOnDate(db, date)` → the date's `runs`, or 0. The rows added count exactly what `countRunsOnDate` and `countDraftsOnDate` count: every status, by the UTC date of `queued_at`.

### The ledger

- `ENTRY_TYPES` gains `demo.reset`. Nothing else in the ledger changes; `ledger verify` passes on a log whose entry 1 is a `demo.reset`.

### The demo reset (gate)

- **Enabled** only when the gate runs with `COUNTERSIGN_DEMO_RESET` exactly `on`. Otherwise `POST /demo/reset` isn't mounted (404). There's no reset CLI.
- **`POST /demo/reset`**, approver key only (`Authorization: Bearer`, checked first; 401 "A valid approver key is required.", as the approval API). No body is read. Answers JSON:
  - `200` with the report below (also when `complete` is false, and when nothing was cleared because a replacement failed).
  - `409` `{ message }`: "A reset is already running." / "Countersign is carrying out an approved action. Try again in a minute." (an `execution.requested` from the last 10 minutes with no `execution.result`, or one that can't be read) / "Resolve is still working on a message. Try again in a minute." / "The demo was reset less than a minute ago. Try again in a minute." (entry 1 is a `demo.reset` less than 60 seconds old) / "A scenario ran during the reset. Reset again." (inside the lock: a run queued since the reset began, or a capture now in `seed_orders` named by an execution request) / "Countersign is busy writing. Try again in a minute." (a lock not granted in 5 seconds). Nothing was cleared; replacement orders already created stay.
  - `503` `{ message }`: "The gate has no database, so the demo can't be reset." / "PayPal isn't set up on the gate, so the demo can't be reset." / "Set PAYPAL_SEED_VAULT_TOKEN and PAYPAL_SEED_VAULT_TOKEN_B on the gate to reset the demo." (only the missing names) / "The demo couldn't be reset. Nothing was cleared." (the transaction failed). Nothing was cleared.
- **Order of work**: (1) the checks above that need no lock, before any write: database, PayPal, vault tokens, one at a time, then the busy check (unfinished runs or drafts, unanswered execution requests, the one-minute cooldown); (2) the order check; (3) if any order is to be replaced, one `runSeed` for exactly those, and if any of them failed, the report with `cleared: null` and nothing cleared; (4) one `withAuditLog` transaction: `lockDemoTables`, the busy check again, a check that no run was queued since the reset began and no capture now in `seed_orders` is named by an execution request (else 409 "A scenario ran during the reset…"), `clearDemoTables`, then append `demo.reset` (ref null, `at` the reset time) with payload `{ previous_head: { seq, hash } | null, cleared: { entries, tickets, attachments, runs, drafts, documents } }`; (5) after commit, dispute sync; (6) the report.
- **The order check**: for each catalog order (`DEMO_ORDERS`, `KIK-1013` to `KIK-1042`), 3 at a time: kept when its `seed_orders` row exists, reads (the seed run's row rules), has the catalog's buyer, its capture isn't named by any `execution.requested` in the audit log, whatever the outcome (`requestedCaptureIds`; an unreadable request names every capture), and `getCapture(row.paypalCaptureId)` answers status `COMPLETED`; replaced otherwise, including when the capture read throws. If any are replaced, one `runSeed` with `orders` = exactly those, `runId` = `newRunId(resetAt, randomRunSuffix())` and the vault tokens.
- **Dispute sync**: the shared `syncDisputes` (below) with the reset time; its nudges go to `RESOLVE_AGENT_URL`. Anything it throws after the clear is reported as `disputes: { error: "the gate couldn't read its records" }` with `complete: false`, never a 500.
- **One at a time**: an in-process flag, plus the one-minute cooldown read from the log, which holds across processes.
- **Report** (`200`):
  ```
  { complete, reset_at, took_ms,
    orders: { kept, replaced: ["KIK-…"], run_id: string | null,
              failed: [{ order_number, call, reason }] },
    cleared: { previous_head: { seq, hash } | null,
               entries, tickets, attachments, runs, drafts, documents } | null,
    disputes: { recorded, already_recorded, problems } | { error } | null }
  ```
  `cleared` and `disputes` are null when a replacement failed, so nothing was cleared. `complete` is true when the log was cleared and the dispute sync read the list with no problems. `took_ms` is wall time from the start of the reset in the gate (after the key check) to the report. A seed `problem` (both buyers one account) fails every replaced order with call `seed` and that sentence.
- **Rail timeouts**: every request the rail client makes (token requests included) times out after 30 seconds, reading the body included, and fails as a `network` error. Network failures aren't retried, as now. One call's worst case is (2 + 2 + `MAX_RETRIES`) × 30 s + `MAX_RETRIES` × 10 s = 200 s. An execution makes at most 2 calls, so it always ends inside the reset's 10-minute window.
- **`POST /baseline/launch`**, approver key only, body `{ scenario_id }` (zod, strict, 1 KB): the gate mints one sandbox access token and sends `{ mode: "baseline", paypal_token }` to Resolve's `POST /scenarios/<id>`, then passes Resolve's answer through (202, 400, 404, 409, 500, 503). Its own answers: `400` "Send JSON with scenario_id."; `503` "The gate can't reach Resolve, so baseline mode can't start." (only when `RESOLVE_AGENT_URL` isn't an http(s) URL; unset means `http://127.0.0.1:8788`, as for the nudge) / "PayPal isn't set up on the gate, so baseline mode can't start."; `502` "PayPal didn't issue a token. Try again in a minute." / "Resolve couldn't be reached. Try again in a minute." The token is never logged, stored or answered.
- **Phone pairing**: `POST /approvals/pairing-codes` (approver key) → `201 { code, expires_at }`, a 22-character base64url code from 16 random bytes, single-use, valid 5 minutes, held only as its SHA-256 in the gate's memory (at most 50). `POST /approvals/pair` `{ code }` (no key) → `200 { approver_key }` once, else `401` "That code has expired or was used. Sign in with the approver key." Neither logs a code or the key.
- **Dispute sync as a function**: `syncDisputes(db, rail, { now, env, nudgeFetch? })` in `apps/gate/src/dispute-sync.ts` returns `{ ok: true, lines, recorded, alreadyRecorded, problems } | { ok: false, error, lines }`; `npm run disputes -- sync` formats it with the same lines and exit codes as now.
- **The audit reader** summarises `demo.reset` as "The demo was reset. The log before it ended at entry 41 (hash 3f9a…c2d1)." (the first 4 and last 4 hex characters), or "The demo was reset. The log was empty before it." An unreadable payload is listed as unreadable, like any entry.

### Resolve

- **`RESOLVE_BASELINE`**: `on` (unset or blank), `scenarios` or `off`. Any other value counts as `off`, with the startup line "RESOLVE_BASELINE must be on, scenarios or off. Baseline mode is off."
- **`POST /messages`** with `mode: baseline`: allowed under `on`; under `scenarios` 400 "Here, baseline mode runs only the demo scenarios. Start one from the console's start page."; under `off` 400 "Baseline mode is off on this Resolve." Protected messages are unchanged.
- **`POST /scenarios/:id`**, body `{ mode: "protected" | "baseline", paypal_token?: { access_token, expires_at } }` (zod, strict; a token only with `baseline`). A supplied token is used for that run's baseline connection in place of Resolve minting one. It's held in memory only, and passed to the run's one fallback rerun if there is one; it's dropped when the run (or that rerun) starts. When the run starts with 60 seconds or less of the token's life left, it fails `baseline_unavailable` before any model call. With `baseline`, no token and no PayPal variables on Resolve: 400 "Baseline mode here starts from the console's start page." On Render, Resolve has no PayPal variables, so every hosted baseline run's token comes from the gate. The scenarios, in `apps/resolve-agent/src/scenarios.ts`:

  | ID | File | Modes |
  |---|---|---|
  | `beat-3-attack-email` | `scenarios/beat-3-attack-email.json` | protected, baseline |
  | `beat-4-stalled-parcel` | `scenarios/beat-4-stalled-parcel.json` | protected |
  | `beat-5-damaged` | `scenarios/beat-5-damaged.json` | protected |

  It loads the file and its photos with the CLI's rules (now in `src/scenario-file.ts`), resolves the one message's sender from `seed_orders`, builds the same body `POST /messages` takes, and accepts it through the same path (check, cap, store, queue). Answers: `202 { ticket_id, thread_id, run_id }`; `404` "There's no scenario with that ID."; `400` "Send JSON with mode, protected or baseline." / "This scenario runs in protected mode only." / the baseline-off sentence above (baseline is allowed under `on` and `scenarios`); `409` "Order KIK-1035 isn't seeded. Reset the demo first." or "Buyer A isn't seeded. Reset the demo first."; `500` "Resolve couldn't store the message. Try again."; `503` without a database, as other routes.
- **The daily cap** counts today's runs, today's drafts and `countClearedRunsOnDate` for today.

### The console

Every screen follows `Graphite Design/DESIGN.md` and the brand book: semantic tokens only, Lucide icons, no emojis, light and dark, desktop and phone widths.

- **Sign-in on every route to Resolve.** One helper in `approval-routes.ts`, `withSignIn(request, deps, run)`: `withKey`, then `checkKey` with the gate, then `run(key)`; the key never goes to Resolve. It wraps `GET /api/resolve/threads`, `GET /api/resolve/threads/[id]`, `GET /api/resolve/attachments/[id]`, `POST /api/resolve/messages` and the new `POST /api/scenarios`, and the dispute routes move onto it (their answers don't change). Signed out, they answer as the dispute routes do (401 "Sign in with the approver key." / "Sign in again.", 502 when the gate can't be reached).
- **The inbox page** checks the cookie's key with the gate before reading Resolve. Signed out: the shared sign-in, title "Inbox", line "Sign in with the approver key to see the inbox." A 401 from the gate shows it with "Sign in again.".
- **The customer chat** (`/chat`) shows, on a 401 from either route: "Sign in with the approver key on the start page, then come back." with a link "Go to the start page" to `/`.
- **Per-session limits** (brief §8). Signing in, by key or by pairing, sets `countersign_session` (16 random bytes, HttpOnly, SameSite Strict, Secure on HTTPS; cleared on sign-out). In any 10 minutes a session may start 12 runs (`POST /api/scenarios` and `POST /api/resolve/messages` together, the chat included) and 3 resets (`POST /api/demo/reset`). Past that: `429` "This session has started a lot of runs. Try again in a few minutes." / "This session has reset the demo a lot. Try again in a few minutes." A request with the key cookie but no session cookie: `401` "Sign in again." with the key cookie cleared. Checked in this order: key cookie, the gate's key check, session cookie, limit; a request refused earlier spends nothing. `GET` routes and the approvals and dispute routes aren't limited. In memory on the console's one instance.
- **`POST /api/scenarios`**, body `{ scenario_id, mode }` (zod, 1 KB at most; `scenario_id` any 1 to 40 of `[a-z0-9-]`, since Resolve decides which exist) → `protected`: Resolve `POST /scenarios/<id>` with `{ mode }`; `baseline`: the gate's `POST /baseline/launch` with `{ scenario_id }` (the gate's 502 and 503 sentences passed through) → `202 { ticket_id, thread_id, run_id }`, or Resolve's sentence with its status (400, 404, 409), or 502 `RESOLVE_UNREACHABLE`. A body that isn't that JSON is 400 "Send JSON with scenario_id and mode."
- **`POST /api/demo/reset`** → the cookie's key to the gate's `POST /demo/reset` (120-second timeout) → the gate's status and body (the report, or its sentence) passed through after zod parsing; 404 from the gate becomes 404 "The demo reset is off on this gate."; 401 clears the cookie as other approval routes; unreachable or unreadable → 502 `APPROVAL_ROUTE_MESSAGES.unreachable`.
- **The start page** (`/`, title "Start here · Countersign console"), inside the console shell, sidebar item "Start here" (Lucide `Compass`) first. Copy, exactly:
  - Heading "Start here". Line: "Countersign checks every money action an AI agent proposes against PayPal's records and your rules. The agent's words never approve a payment."
  - "In about a minute", an ordered list:
    1. "Sign in with the approver key from the testing instructions."
    2. "Run the attack email in baseline mode, then protected, and compare what moved."
    3. "Run the stalled parcel and the damaged basket. Each opens in the inbox, linked to its decisions."
    4. "Scan the code below to open Approvals on your phone, already signed in, and approve the waiting refund. The Approvals page here works too."
    5. "Reset the demo when you're done, so the next person starts fresh."
  - "What's real" — "PayPal sandbox orders, captures, refunds, disputes and webhooks, and Countersign's decisions, approvals and audit log." "What's simulated" — "The customers and their messages, the carrier's delivery status, and the shop and its people, who are illustrative."
  - When `STOREFRONT_URL` is an http(s) URL: "Want a real sandbox checkout? Buy something on the Kikapu storefront." with "Kikapu storefront" linking there (opens in the same tab).
  - Signed out: the shared sign-in at heading level 2, title "Sign in", line "Sign in with the approver key to run the scenarios and reset the demo."
  - When the gate can't be reached to check the key: the guide, then a `Notice` with `APPROVAL_ROUTE_MESSAGES.unreachable` in place of the sign-in, scenarios, phone code and reset.
  - Signed in, "Scenarios", one card each (Graphite Card, ringed on the container):

    | Scenario | Title | Line | What to look for | Buttons |
    |---|---|---|---|---|
    | beat 3 | The attack email | "A customer says KIK-1042 never arrived, and hidden text asks for refunds on four orders other people paid for." | "Baseline: the agent calls PayPal's refund tool directly. Protected: Countersign denies what the records don't support and holds the rest." | "Run in baseline mode" (secondary), "Run protected" (primary) |
    | beat 4 | The stalled parcel | "The payer of KIK-1035 says her $18.00 coaster set never arrived. The carrier shows it stalled for over ten days." | "The refund runs on its own, with a real sandbox refund ID." | "Run protected" (primary) |
    | beat 5 | The damaged basket | "The payer of KIK-1037 sends a photo of a split basket and asks for her $240.00 back." | "It waits for you. Approve it on the Approvals page or your phone." | "Run protected" (primary) |

    A pending button shows the spinner and keeps its label. On 202 the page navigates to `/inbox?thread=<thread_id>`. On a refusal, the card shows the sentence below its buttons in `danger-foreground`.
  - Signed in, the "Open on your phone" code for `/approvals` (the approvals page's component, moved to a shared file), shown from 768px up. It carries a fresh pairing code in the fragment (`/approvals#pair=<code>`) when the gate gives one, else the plain URL. On the phone, the approvals page trades the code through `POST /api/approvals/pair` (the cookie is set as by the sign-in), removes it from the address bar, and shows the cards; a refused code shows the gate's sentence above the normal sign-in.
  - Signed in, "Reset the demo": line "Clears the inbox, decisions and audit log, and replaces any order a scenario refunded. It takes up to a minute." Button "Reset demo" (danger subtle). A dialog (Graphite Dialog, a drawer under 640px): title "Reset the demo?", description "Everyone using this demo starts again from the seed orders. The audit log restarts with one entry that records where the old log ended.", buttons "Cancel" and "Reset demo" (danger, pending shows the spinner and "Resetting"). After it, one line in a `Notice`:
    - complete (tone positive): "Reset in 14s. Replaced 3 orders and kept 27. Recorded 1 dispute again." ("Kept all 30 orders." when none replaced; the dispute sentence is left out when none were recorded). Durations as the brand book, rounded to whole seconds: "14s", "1m 08s".
    - cleared, but the disputes weren't all recorded (tone warning): the first two sentences, then "The disputes couldn't be read again: <error>" or "2 disputes couldn't be recorded again."
    - nothing cleared (tone warning): "The demo wasn't reset. 2 orders couldn't be replaced (KIK-1035, KIK-1037), so nothing was cleared. Reset again to retry." (pluralised; "1 order couldn't be replaced (KIK-1035)").
    - a refusal (tone warning): the gate's sentence.
- **`/` no longer redirects** to `/decisions`.
- Console schemas for the scenario answer and the reset report live in `src/demo-schemas.ts`.

### Hosting (`render.yaml`)

- As ADR 0041 and ADR 0044: the services, plans, commands, health checks, internal addresses through `*_HOSTPORT` and start-command prefixes, generated keys, `sync: false` secrets (and `CONSOLE_PUBLIC_URL` on the console; no PayPal variable on Resolve), `NODE_VERSION` 26.7.0, `autoDeployTrigger: off` on every service, `COUNTERSIGN_DEMO_RESET=on`, `RESOLVE_BASELINE=scenarios`, `RESOLVE_DAILY_RUN_CAP=200`, `PORT=10000` on Resolve, Postgres 18 with `ipAllowList: []` and a 5 GB disk, and the cron job every 10 minutes, which fails when either of its commands fails. The file is in `design.md`.
- `docs/hosting.md`: how the owner creates the blueprint, which values to type in, what to copy after the first deploy (the generated keys, the gate's URL for the webhook, the console's URL as `CONSOLE_PUBLIC_URL`), the first Reset, how to run `ledger verify` from the gate's Render Shell, deploying by hand when no run is queued, opening one dispute per expected judge, and rotating the approver key.
- `docs/judge-guide.md`: the start page's steps for the README (phase 20), with where each credential is (the approver key and the sandbox buyer login in the Devpost testing instructions), signing in on the phone with the same key, and what's real and simulated.

## Constraints

- No AI in the gate, `packages/mandate`, `packages/verifiers`, `packages/ledger`, `packages/db` or `packages/seed`; the no-AI test covers the packages. The reset and the launcher add no AI call; a scenario run is an ordinary Resolve run under the daily cap.
- Fail closed: the reset clears nothing unless every check passes, every replacement order exists and the transaction commits; it never runs while Resolve is working or an execution request has no result; it never keeps a seeded order whose capture has execution history; a reset never raises the day's run cap; on the hosted demo no visitor text reaches baseline mode. Today's usage for the mandate's limits restarts with the log (ADR 0044).
- The approver key is checked by the gate only and never sent to Resolve, logged or stored by the console beyond its HttpOnly cookie; the pairing exchange passes it from the gate to the console's server only, to set that cookie. Principal keys never open the reset, a pairing code or a baseline launch.
- On Render, Resolve holds no PayPal credential (brief §8); a baseline run's token comes from the gate, one per launch.
- Each signed-in session is rate-limited, and AI spend has the daily cap (brief §8).
- Every external input is read with zod 4: the scenario and reset requests, Resolve's and the gate's answers in the console, `RESOLVE_BASELINE`, `COUNTERSIGN_DEMO_RESET`.
- Sandbox only. The reset creates sandbox orders paid by the seed buyers' vault tokens, as `npm run seed` does, and nothing else.
- No secret in `render.yaml`, logs, answers or the repo; variables are named, never shown.
- Copy follows the brand book: plain, short, sentence case, no exclamation marks, pluralised counts. Illustrative people and shops stay labelled.

## Technical needs

- New dependency: `yaml` 2.9.1 (root devDependency, published 11 Sep 2026), for the blueprint test only.
- New workspace: `packages/seed` (`@countersign/seed`), depending on `@countersign/carrier-mock`, `@countersign/db`, `@countersign/mandate`, `@countersign/rail-paypal` and `zod`. The gate and the storefront depend on it; the storefront's `next.config.ts` adds it to `transpilePackages`.
- New env: `COUNTERSIGN_DEMO_RESET` (gate), `RESOLVE_BASELINE` (Resolve), `STOREFRONT_URL` (console, optional). The gate also reads `PAYPAL_SEED_VAULT_TOKEN` and `PAYPAL_SEED_VAULT_TOKEN_B` for the reset. The blueprint also sets the console's existing `CONSOLE_PUBLIC_URL`.
- No new root script.
- Live checks run only under `LIVE=1`, never in the Feedback commands: `apps/gate/test/reset-live.test.ts` (sandbox PayPal, PGlite, needs the vault tokens). Everything else that needs Render is the owner's (`validation.md`, `.ralph/human.md`).
