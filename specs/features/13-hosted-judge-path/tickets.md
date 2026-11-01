# Phase 13 tickets: the hosted judge path

Built from `design.md`'s Detailed Implementation Plan ("item N" below). Copy, statuses and sentences are exactly as in `requirements.md`; checks are in `validation.md`. Every UI ticket follows `Graphite Design/DESIGN.md` and the component specs. It reuses the shared primitives in `apps/console/app/ui.tsx` (feature 13a's comfortable density, merged from `main` before this build) and hard-codes no density values: text sizes, control heights, row heights, card padding and gaps. The class strings in design item 21 predate 13a; where they disagree with `ui.tsx` or `DESIGN.md`, those win.

## T-001: The shared `@countersign/seed` package

Status: done
Blocked by:
Tier: simple
Slice: The seed catalog and seed run live in `@countersign/seed`, the storefront and gate depend on it, and `npm run seed` behaves exactly as before.
Test seam: `@countersign/seed`'s exports (`runSeed`, `DEMO_ORDERS`, `StoredRowSchema`, `newRunId`, `randomRunSuffix`, `readVaultTokens`, `VAULT_ENV_NAMES`) and the storefront's existing seed tests
Acceptance:
- [x] The storefront's catalog, seed-run, seed-cli and shop-page tests pass, importing from `@countersign/seed`; `npm run seed -- --dry-run` prints the same plan as before (validation check 2) (the dry-run plan is asserted by the seed-cli tests; the loop can't run the CLI itself, so check 2 still needs a human run)
- [x] `readVaultTokens` gives both tokens, or `missing` names only, in `VAULT_ENV_NAMES` order; `randomRunSuffix` gives 6 characters of `[a-z0-9]`
- [x] `StoredRowSchema` is exported; `seed-cli.ts` still exports `newRunId` and `VAULT_ENV_NAMES`
- [x] The no-AI test lists `seed`; `npm run build` builds the storefront with the package transpiled
Notes:
- The conductor ran `npm install` after this commit to link the workspace in `package-lock.json`; this iteration did not touch the lockfile.
- Deviation: the package also exports `@countersign/seed/products`. The storefront's web code (`checkout.ts`, `shop-props.ts`) imports the catalog from it, because the barrel pulls `@countersign/db` into the Turbopack bundle and the build fails on db's `import.meta.url` paths.
- Items 1, 2 and 3. Files: `packages/seed/` (new: `package.json`, `tsconfig.json`, `src/index.ts`, `src/run-id.ts`, and `products.ts`, `seed-catalog.ts` and `seed-run.ts` moved with `git mv`), `apps/storefront/src/{seed-cli,shop-props,checkout}.ts`, `apps/storefront/test/*`, `apps/storefront/{package.json,next.config.ts}`, `apps/gate/package.json`, `tests/no-ai-in-decision-path.test.ts`, `package-lock.json`.

## T-002: Clearing the demo tables in `@countersign/db`

Status: done
Blocked by:
Tier: standard
Slice: The database can lock, count and clear the demo's six tables in one transaction, carrying each date's run count into `cleared_run_counts`.
Test seam: `@countersign/db`'s `lockDemoTables`, `countUnfinishedWork`, `clearDemoTables`, `countClearedRunsOnDate` and `runsQueuedSince`, on PGlite
Acceptance:
- [x] Migration 0007 adds `cleared_run_counts`, named `0007_cleared_run_counts.sql` with the journal tag to match
- [x] `clearDemoTables` empties the six tables, leaves `seed_orders` and `carrier_shipments` untouched, and returns the old head and counts; it adds each UTC date's run and draft counts (every status, by `queued_at`), and clearing twice adds up (validation check 3)
- [x] `countUnfinishedWork` counts only `queued` and `running`, on a database or a transaction
- [x] `runsQueuedSince` compares as `timestamptz` with the 5-second margin; a run queued 4 s before counts and one queued 6 s before doesn't
Notes:
- Item 4. Files: `packages/db/src/{schema,demo-reset,index}.ts`, `packages/db/drizzle/0007_*` and its snapshot and journal, `packages/db/test/demo-reset.test.ts`.

## T-003: `demo.reset` in the ledger, and the run cap counts cleared runs

Status: done
Blocked by: T-002
Tier: simple
Slice: The ledger accepts a `demo.reset` entry, and Resolve's daily cap still counts runs a reset cleared.
Test seam: `@countersign/ledger`'s `ENTRY_TYPES` and `verifyLog`; Resolve's `overDailyCap`
Acceptance:
- [x] `ENTRY_TYPES` holds `demo.reset` (the pinned list in `chain.test.ts` updated); a log whose entry 1 is `demo.reset` verifies
- [x] After a clear that removed today's runs, `overDailyCap` still counts them (validation check 8)
Notes:
- Items 5 and 6. Files: `packages/ledger/src/chain.ts`, `packages/ledger/test/chain.test.ts` (or `log.test.ts`), `apps/resolve-agent/src/limits.ts`, `apps/resolve-agent/test/limits.test.ts`.

## T-004: Dispute sync as a shared function

Status: done
Blocked by:
Tier: simple
Slice: The gate can sync disputes from code, and `npm run disputes -- sync` formats the same result exactly as before.
Test seam: `syncDisputes(db, rail, deps)` in `apps/gate/src/dispute-sync.ts`; the disputes CLI's existing tests
Acceptance:
- [x] `test/disputes-cli.test.ts` passes unchanged (validation check 6)
- [x] `syncDisputes` returns the counts and lines for a sync with recorded, already recorded and problem disputes, and `ok: false` with `error` for each of the three can't-run cases
Notes:
- Item 7. Files: `apps/gate/src/{dispute-sync,disputes-cli}.ts`, `apps/gate/test/dispute-sync.test.ts`.

## T-005: The reset's reads of the execution log

Status: done
Blocked by:
Tier: standard
Slice: The gate can tell which execution requests still have no result, and which captures any request has named.
Test seam: `countUnansweredRequests(reader, since)` and `requestedCaptureIds(reader)` in `apps/gate/src/execution-log.ts`
Acceptance:
- [x] A request with a result isn't counted, one without is (a replay request on its own), one before `since` isn't, and an unreadable request or result makes the answer unknown
- [x] Captures come from refund requests only, failed ones included; a dispute or payout request names none; an unreadable request makes it unknown
- [x] `Reader` and `MAX_RAIL_CALLS_PER_EXECUTION` (2) are exported; `execute()` doesn't change
Notes:
- Item 8 (gate part). Files: `apps/gate/src/{execution-log,executors}.ts`, `apps/gate/test/reset-reads.test.ts` (or `execution-log.test.ts`).

## T-006: A timeout on every PayPal request

Status: done
Blocked by:
Tier: standard
Slice: No rail call can hang: each request, body included, times out after 30 seconds as a network error, with a stated worst case per call.
Test seam: the PayPal client's public methods against a fake server, with fake timers
Acceptance:
- [x] A server that hangs before answering, and one that hangs mid-body, each end in a `network` `PayPalError` within `RAIL_REQUEST_TIMEOUT_MS`; the token request is bounded the same way
- [x] Network failures still aren't retried; 429 and 5xx retries behave as before (existing tests pass)
- [x] `RAIL_WORST_CALL_MS`, `MAX_RETRIES` and `MAX_RETRY_WAIT_MS` are exported, and `RAIL_WORST_CALL_MS` is 200,000 with today's constants
Notes:
- Item 8 (rail part). Files: `packages/rail-paypal/src/client.ts`, `packages/rail-paypal/test/timeouts.test.ts`.

## T-007: The demo reset's core: checks, order check, replacement and clear

Status: done
Blocked by: T-001, T-002, T-003, T-004, T-005, T-006
Tier: standard
Slice: `resetDemo` refuses when it must, replaces the seeded orders that were touched, and only then clears the log and Resolve's tables, starting the new log with `demo.reset`.
Test seam: `resetDemo(deps)` in `apps/gate/src/demo-reset.ts`, with PGlite, `test/fake-sandbox.ts`, an injected `reseed` and a test-moved clock
Acceptance:
- [x] An empty database replaces all 30 and writes entry 1 `demo.reset` with `previous_head: null`; a seeded database with `COMPLETED`, untouched captures keeps all 30; `verifyLog` passes after
- [x] A refunded capture, a failed capture read, a missing row, the wrong buyer, and a capture named by an execution request (executed or failed) are each replaced in one run with a new run ID; an unreadable request replaces all 30 (per ADR 0046: through `resetDemo` it's refused 409 `executing` by the busy check; the replace-all branch is tested on the exported `checkSeedOrders`); a dispute's evidence submission doesn't replace its order
- [x] A queued run, a running draft, an unanswered execution request from the last 10 minutes, an unreadable result, a reset under a minute ago, or a second reset in the process is refused 409 before any PayPal call; an older unanswered request doesn't block
- [x] A missing database, PayPal variable or vault token is refused 503, naming only variables
- [x] A seed failure, a seed `problem` or a reseed throw gives `complete: false`, `cleared: null` and `disputes: null`, with the log, tickets and runs untouched
- [x] `EXECUTION_WINDOW_MS > MAX_RAIL_CALLS_PER_EXECUTION × RAIL_WORST_CALL_MS`
Notes:
- Item 9, steps 1 to 7 without the in-lock "changed" check (T-008). Files: `apps/gate/src/demo-reset.ts`, `apps/gate/test/demo-reset.test.ts`.
- ADR 0046 (answerer): an unreadable request can't reach the order check through the seam; see the acceptance note above.
- Built ahead of T-008 because it was cheap: the in-lock busy check, `ResetRefused`, the `55P03` → `locksBusy` and other-error → `notCleared` mapping, and `RESET_MESSAGES.changed`. T-008 still owns their tests, the "changed" check, dispute sync, `RESET_MESSAGES.disputesUnread` and `demoResetSummary`.

## T-008: The reset inside the lock, dispute sync and the report

Status: done
Blocked by: T-007
Tier: standard
Slice: A reset catches a scenario that ran during the replacements, records waiting disputes again, and reports whether it's complete.
Test seam: `resetDemo(deps)` as in T-007
Acceptance:
- [x] A run queued during the replacements (even one already finished, and one queued up to 5 s before the reset by a clock running behind), or an execution requested on a kept capture, is refused 409 "A scenario ran during the reset. Reset again." inside the lock; nothing is cleared and the replacement rows stay
- [x] The busy checks run again inside the lock; a lock not granted in 5 s is 409 `locksBusy`; another transaction error is 503 `notCleared`
- [x] An open dispute is recorded again as `dispute.received` and Resolve is nudged; a dispute-sync error, or a throw from `syncDisputes`, gives 200 with `complete: false` and the error after the clear
- [x] `demoResetSummary` gives both sentences in requirements.md; `tookMs` and `resetAt` come from the clock
Notes:
- Item 9, step 7's in-lock checks, steps 8 and 9, and `demoResetSummary`. Files: `apps/gate/src/demo-reset.ts`, `apps/gate/test/demo-reset.test.ts`.
- PGlite has one connection, so the lock-timeout and other-transaction-error cases inject a `db` Proxy whose `transaction` rejects; the sync-throw case uses a Proxy whose `select` throws after the clearing transaction commits.

## T-009: The reset's route and its line in the audit reader

Status: done
Blocked by: T-008
Tier: simple
Slice: The approver can reset over HTTP when the gate has `COUNTERSIGN_DEMO_RESET=on`, and `/audit/entries` reads a `demo.reset` as its sentence.
Test seam: a listening `createApp` (as `test/approvals-api.test.ts`); the audit reader's `/audit/entries`
Acceptance:
- [x] `POST /demo/reset` is 404 unless the flag is exactly `on`, 401 for a principal key or none, 200 with the snake_case report for the approver key, and 409 or 503 with the sentence for a refusal (validation check 5)
- [x] The route uses the cached rail client (`railOnce`)
- [x] A `demo.reset` entry reads as its sentence with and without a previous head, and an unreadable one as unreadable (validation check 7)
Notes:
- Items 10 and 12. Files: `apps/gate/src/{demo-reset-api,app,audit-reader}.ts`, `apps/gate/test/{demo-reset-api,audit-reader}.test.ts`.

## T-010: The gate launches hosted baseline runs with a token it mints

Status: done
Blocked by: T-006
Tier: standard
Slice: The approver can start a baseline scenario through the gate, which mints one sandbox token and hands it only to Resolve.
Test seam: `POST /baseline/launch` on a listening `createApp`, with a fake Resolve that records its body
Acceptance:
- [x] 401 without the approver key; 400 for a bad body; each 502 and 503 sentence in requirements.md; 503 for Resolve's address only when `resolveAgentUrl` is null (unset uses the default)
- [x] The fake Resolve receives `{ mode: "baseline", paypal_token: { access_token, expires_at } }`, and its 202, 400, 404, 409, 500 and 503 answers pass through
- [x] The token appears in no answer body and no log line
Notes:
- Item 12a. Files: `apps/gate/src/{baseline-launch,app}.ts`, `apps/gate/test/baseline-launch.test.ts`.

## T-011: Phone pairing codes on the gate

Status: done
Blocked by:
Tier: standard
Slice: An approver-key holder can mint a single-use code that trades once, without a key, for the approver key.
Test seam: `POST /approvals/pairing-codes` and `POST /approvals/pair` through `createApp`, with a fixed clock
Acceptance:
- [x] Minting needs the approver key and answers 201 with a 22-character base64url code and its expiry
- [x] With no key, a valid code trades once for 200 `{ approver_key }`; a used, expired, unknown or malformed code is 401 with the sentence
- [x] Through `createApp`, `GET` and `POST /approvals/<id>` behave exactly as before (the mount order holds)
- [x] At most 50 live codes; no code or key in any log line
Notes:
- Item 12b. `mountPairing` must be mounted before `mountApprovals`. Files: `apps/gate/src/{pairing,app}.ts`, `apps/gate/test/pairing.test.ts`.

## T-012: Resolve's scenario-file rules as a shared module

Status: done
Blocked by:
Tier: simple
Slice: The `resolve` CLI's message-file loading lives in `scenario-file.ts`, and an unseeded sender says which order or buyer is missing.
Test seam: `loadMessageFile` and `senderEmail` in `apps/resolve-agent/src/scenario-file.ts`; the CLI's existing tests
Acceptance:
- [x] `test/resolve-cli.test.ts` passes unchanged and the CLI's output is unchanged
- [x] `senderEmail`'s not-seeded refusal carries `unseeded` "Order KIK-…", "Buyer A" or "Buyer B", or null for other errors, with today's sentence as `error`
Notes:
- Item 13. Files: `apps/resolve-agent/src/{scenario-file,resolve-cli}.ts`, `apps/resolve-agent/test/scenario-file.test.ts`.

## T-013: Resolve's baseline policy

Status: done
Blocked by:
Tier: standard
Slice: `RESOLVE_BASELINE` decides where baseline mode may run, and `POST /messages` refuses baseline outside it.
Test seam: `parseBaselinePolicy(env)`; `POST /messages` on `createApp`
Acceptance:
- [x] Unset or blank is `on`; `on`, `scenarios` and `off` parse exactly; anything else is `off` with the startup sentence (validation check 9)
- [x] `POST /messages` in baseline is accepted under `on` and refused 400 with each sentence under `scenarios` and `off`; protected messages are unchanged
- [x] The accept path is shared (`accept(res, input, origin)`), and every existing `test/app.test.ts` case passes
Notes:
- Item 14 (policy part). Files: `apps/resolve-agent/src/{baseline-policy,serve,app}.ts`, `apps/resolve-agent/test/{baseline-policy,app}.test.ts`.

## T-014: Supplied baseline tokens in Resolve's queue

Status: done
Blocked by: T-013
Tier: standard
Slice: A baseline run can use a token handed to it instead of minting one, holding it in memory for that run and its one fallback rerun only.
Test seam: `createSuppliedTokens`, `createModeRunner` with a fake transport, and `createApp`'s `accept`
Acceptance:
- [x] A supplied token reaches that run's baseline connection, is gone afterwards, and appears in no stored row, trace or log line
- [x] A non-`queued` run drops its token; a token with 60 s or less left fails `baseline_unavailable` with no model call
- [x] A `model_unavailable` baseline run passes its token to its one rerun, and the rerun's rerun gets none
- [x] A capped (`not_run`) message holds nothing; `canMintTokens` defaults to true, and `serve.ts` sets it from the PayPal variables
Notes:
- Item 14 (token part). Files: `apps/resolve-agent/src/{queue,serve,app}.ts`, `apps/resolve-agent/test/{queue,app}.test.ts`.
- No route passes a token to `accept` until T-015, so the app tests cover only `POST /messages` (queued and capped) holding nothing. `canMintTokens` is declared on `AppDeps` (default true, documented) but nothing reads it yet. T-015's route must read `deps.canMintTokens ?? true` and test: a baseline scenario's token is held for its run, a capped scenario holds nothing, and `canMintTokens` true and false.

## T-015: Resolve's scenario route

Status: done
Blocked by: T-012, T-014
Tier: standard
Slice: `POST /scenarios/:id` stores and queues one of the three demo scenarios, with its sender from `seed_orders` and its photo, in an allowed mode.
Test seam: `POST /scenarios/:id` on `createApp`, with `seed_orders` rows inserted and a queue fake recording run IDs
Acceptance:
- [x] Each scenario is stored and queued with the right sender and photos; all three scenario files load (a packaging test)
- [x] 404 unknown ID; 400 bad body, a token with protected mode, baseline for beats 4 and 5, and baseline without a token when `canMintTokens` is false; 409 for an unseeded order or buyer; 503 without a database (validation check 9)
- [x] Baseline under `scenarios` is accepted from this route; a supplied token is held for the new run; a capped run is stored `not_run`
Notes:
- Item 15. Files: `apps/resolve-agent/src/{scenarios,app}.ts`, `apps/resolve-agent/test/scenarios.test.ts`.

## T-016: Every console route to Resolve needs the sign-in

Status: done
Blocked by:
Tier: simple
Slice: The console checks the approver key with the gate before any call to Resolve, through one helper the dispute routes share too.
Test seam: `withSignIn`; the route functions in `resolve-routes.ts` and `dispute-routes.ts`
Acceptance:
- [x] With no cookie, each route to Resolve answers 401 without calling Resolve; a gate 401 answers 401 and clears the cookie; a gate failure answers 502 (validation check 10)
- [x] The key never appears in a request to Resolve
- [x] The dispute routes answer as before through `withSignIn` (`test/dispute-routes.test.ts` unchanged); `Refusal["status"]` includes 409 and 429
Notes:
- Items 16 and 17. Files: `apps/console/src/{approval-routes,resolve-routes,dispute-routes}.ts`, `apps/console/app/api/resolve/**/route.ts`, `apps/console/test/{resolve-routes,messages-route}.test.ts`.

## T-017: The inbox and chat ask for the sign-in

Status: open
Blocked by: T-016
Tier: simple
Slice: Signed out, the inbox shows the shared sign-in and the customer chat says to sign in on the start page.
Test seam: `src/chat.ts`'s load and send functions; the inbox page's server render
Acceptance:
- [ ] The inbox renders the shared sign-in with requirements.md's title and line when signed out, "Sign in again." after a gate 401, and the existing `Notice` on a 502
- [ ] The chat maps a 401 to `signedOut: true` with `CHAT_SIGNED_OUT`, and shows the sentence and the "Go to the start page" link in place of the form
- [ ] The design check passes on every changed file
Notes:
- Item 18. UI: follow `Graphite Design/DESIGN.md`, reuse `apps/console/app/ui.tsx` primitives, hard-code no density values. Files: `apps/console/app/inbox/page.tsx`, `apps/console/src/chat.ts`, `apps/console/app/chat/customer-chat.tsx`, `apps/console/test/chat.test.ts`.

## T-018: Session limits and the console's pairing route

Status: open
Blocked by: T-011, T-016
Tier: standard
Slice: Signing in starts a rate-limited session, and a phone can trade a pairing code for the sign-in.
Test seam: `limitSession`, `signInRoute`, `signOutRoute` and `pairRoute`
Acceptance:
- [ ] Sign-in sets the approver and session cookies, and sign-out clears both
- [ ] The 13th run or 4th reset in 10 minutes from one session gives 429 with its sentence; another session isn't affected; no session cookie gives 401 "Sign in again." with the key cookie cleared
- [ ] The pair route sets both cookies on a gate 200, never answers the key, and passes the gate's 401 sentence; a gate failure is 502
- [ ] `callGate` with a null key sends no `authorization` header
Notes:
- Item 19a. Files: `apps/console/src/{session-limits,approval-routes}.ts`, `apps/console/app/api/approvals/pair/route.ts`, `apps/console/test/{session-limits,pair-route}.test.ts`.

## T-019: The console's scenario and reset routes

Status: open
Blocked by: T-016, T-018
Tier: simple
Slice: The console launches a scenario (protected to Resolve, baseline through the gate) and resets the demo, passing answers through and counting each against the session.
Test seam: `scenarioRoute` and `resetRoute` in `apps/console/src/demo-routes.ts`; `messagesRoute`
Acceptance:
- [ ] A bad body is 400 "Send JSON with scenario_id and mode."; protected goes to Resolve and baseline to the gate's `/baseline/launch`; 202 and the 400, 404, 409, 502 and 503 sentences pass through as specified (validation check 10)
- [ ] The reset passes the report through (`cleared: null` included); the gate's 404 becomes "The demo reset is off on this gate."
- [ ] The checks run in order (key cookie, gate check, session, limit), so a signed-out or wrong-key request spends no slot; `messagesRoute` counts against the session too
Notes:
- Item 19. Files: `apps/console/src/{demo-schemas,demo-routes,resolve-routes}.ts`, `apps/console/app/api/{scenarios,demo/reset}/route.ts`, `apps/console/test/demo-routes.test.ts`.

## T-020: The start page's view model

Status: open
Blocked by: T-015
Tier: simple
Slice: The start page's copy, scenario cards and reset sentences come from one view model that a test pins.
Test seam: `START_COPY`, `SCENARIO_CARDS`, `storefrontLink` and `resetSentence` in `apps/console/src/start-view.ts`; `durationWords` in `inbox-view.ts`
Acceptance:
- [ ] `durationWords` gives "0s", "15s" and "1m 08s" for 0, 14,600 and 68,000 ms, and `formatDuration`'s tests pass unchanged
- [ ] Every start-page string and every reset sentence and tone in requirements.md is pinned, with plurals
- [ ] The cards' IDs and modes match Resolve's `LAUNCHER_SCENARIOS` (a test-only cross-check)
Notes:
- Items 11 and 20. T-015 is a blocker only for the cross-check's import of `LAUNCHER_SCENARIOS`. Files: `apps/console/src/{start-view,inbox-view}.ts`, `apps/console/package.json`, `apps/console/test/{start-view,inbox-view}.test.ts`.

## T-021: The start page

Status: open
Blocked by: T-019, T-020
Tier: standard
Slice: `/` shows the guide to everyone, and to a signed-in judge the scenario cards, the phone code and the reset with its dialog.
Test seam: `test/console-setup.test.ts` on `app/page.tsx` and the nav; the design check
Acceptance:
- [ ] `app/page.tsx` renders the start page (the `START_COPY` strings, no `redirect(`); the nav starts with "Start here"; the start page uses the shared sign-in at level 2
- [ ] Signed out shows the sign-in; a gate 502 shows the guide and the unreachable `Notice`
- [ ] `OpenOnPhone` is shared from `app/open-on-phone.tsx`, and the approvals board still uses it
- [ ] The design check passes on every changed file; light and dark both work
Notes:
- Item 21, except pairing (T-022). UI: follow `Graphite Design/DESIGN.md` and each component's spec (Card, Button, Dialog, Notice, Spinner), and reuse `apps/console/app/ui.tsx` primitives. Don't copy item 21's padding, gap, size or height classes: they predate 13a's density. Lucide icons only. Files: `apps/console/app/{page,start-parts,open-on-phone,sign-in,console-nav}.tsx`, `apps/console/app/approvals/approvals-board.tsx`, `apps/console/test/console-setup.test.ts`.

## T-022: The phone code signs the phone in

Status: open
Blocked by: T-018, T-021
Tier: standard
Slice: The start page's QR code carries a fresh pairing code, and the approvals page trades it and shows the cards signed in.
Test seam: the start page's QR URL builder; `pair-from-link.tsx`'s exchange through `/api/approvals/pair` (a component test with a fake fetch)
Acceptance:
- [ ] The QR URL carries `#pair=<code>` only when the gate's POST answers exactly 201 with a parsed code; otherwise it's the plain `/approvals` URL
- [ ] On the approvals page, a `#pair=` fragment is removed from the address bar and posted once; a 200 refreshes the page; a 401 shows the gate's sentence above the sign-in with `role="alert"`; no fragment renders nothing
- [ ] The design check passes on every changed file
Notes:
- Item 21 (pairing parts). UI: follow `Graphite Design/DESIGN.md`, reuse `apps/console/app/ui.tsx` primitives, hard-code no density values. Files: `apps/console/app/page.tsx`, `apps/console/app/approvals/{page,pair-from-link}.tsx`, `apps/console/test/pair-from-link.test.tsx`.

## T-023: The Render blueprint and its test

Status: open
Blocked by:
Tier: simple
Slice: `render.yaml` describes the hosted demo, and a test checks its invariants.
Test seam: `tests/render-blueprint.test.ts` over `render.yaml`
Acceptance:
- [ ] `render.yaml` is design item 22's file exactly; `yaml` 2.9.1 is a pinned root devDependency
- [ ] The test checks every invariant in item 23: types, paid plans, `autoDeployTrigger: off`, references, hostports, the URL each start-command prefix sets, each service's variables (no `PAYPAL_*` on Resolve), the disk, and no secret-looking value (validation check 11)
- [ ] Changing a start-command prefix to the wrong variable, or adding a `free` plan, makes the test fail
Notes:
- Items 22 and 23. `yaml` 2.9.1 is already installed by the conductor. Files: `render.yaml`, `tests/render-blueprint.test.ts`, `package.json`, `package-lock.json`.

## T-024: Hosting docs, the judge guide and the glossary

Status: open
Blocked by: T-023
Tier: simple
Slice: The owner can deploy from `docs/hosting.md`, judges have a guide to lift into the README, and the glossary and tech stack match the build.
Test seam: `npm run lint` and the docs' links (no code)
Acceptance:
- [ ] `docs/hosting.md` covers every step in item 24, including manual deploys, `CONSOLE_PUBLIC_URL`, one dispute per judge and rotating the approver key
- [ ] `docs/judge-guide.md` has the five steps, where each credential is, phone pairing with its paste fallback, and what's real and simulated
- [ ] `CONTEXT.md`'s Approver key, Seed state and Demo reset entries, and `specs/tech-stack.md`, say what item 24 lists
Notes:
- Item 24. Copy by `Graphite Design/brand-book.md`. Files: `docs/{hosting,judge-guide}.md`, `CONTEXT.md`, `specs/tech-stack.md`.

## T-025: The live reset check

Status: open
Blocked by: T-008
Tier: simple
Slice: Under `LIVE=1`, three resets against the sandbox seed, keep and replace orders as specified and report their times.
Test seam: `apps/gate/test/reset-live.test.ts` (skipped unless `LIVE=1` with the PayPal variables and both vault tokens)
Acceptance:
- [ ] Skipped without `LIVE=1`, so `npm test` stays offline
- [ ] With the clock moved past the cooldown, the first reset replaces 30 and is complete, the second keeps 30, and after a $1.00 refund on `KIK-1013` the third replaces exactly it; each `took_ms` is logged with no secret (live check 1)
Notes:
- Item 25. The live run itself is the human's. Files: `apps/gate/test/reset-live.test.ts`.
