# Phase 13 validation: the hosted judge path

## Automated checks

All run from the repo root and are part of the Feedback commands.

1. `npm run typecheck`, `npm run lint`, `npm test` and `npm run build` pass.
2. **Seed package:** the storefront's seed, catalog and checkout tests pass importing from `@countersign/seed`; `npm run seed -- --dry-run` prints the same plan as before; the no-AI test lists `seed`.
3. **Clearing:** on PGlite, `clearDemoTables` empties the six tables, leaves `seed_orders` and `carrier_shipments` untouched, returns the old head and counts, and adds each date's run and draft counts to `cleared_run_counts` (twice adds up); `countUnfinishedWork` counts only `queued` and `running`.
4. **Reset, gate:** with a fake sandbox, an injected seed run and a clock the test moves:
   - an empty database replaces all 30 orders and writes entry 1 `demo.reset` with `previous_head: null`;
   - a seeded database whose captures are all `COMPLETED` and have no execution history keeps all 30 and replaces none;
   - a refunded capture, a capture read that fails, a missing row, a row with the wrong buyer, and a `COMPLETED` capture named by an execution request (an executed one and a failed one) are each replaced, in one run with a new run ID; an unreadable execution request replaces all 30; a dispute's evidence submission doesn't replace its order;
   - the old log's head and counts are in the `demo.reset` payload, and `verifyLog` passes afterwards;
   - a queued run, a running draft, an execution request from the last 10 minutes with no result, an unreadable execution result, a reset less than a minute ago, or a second reset in the same process is refused 409 before any PayPal call, with nothing changed; a request with no result older than 10 minutes doesn't block, and its capture is replaced;
   - a run queued (even one already finished), or an execution requested on a kept capture, while the replacements are being created is refused 409 inside the lock, nothing is cleared, and the replacement rows stay;
   - `EXECUTION_WINDOW_MS` exceeds `MAX_RAIL_CALLS_PER_EXECUTION` × `RAIL_WORST_CALL_MS`, and the rail client ends a call to a server that hangs before or mid-body in a `network` error within its 30-second timeout;
   - a run queued within 5 seconds before the reset began, by a clock running behind, is still caught inside the lock;
   - a missing database, PayPal variable or vault token is refused 503, naming only variables;
   - a seed failure, a seed `problem` or a throw from the seed run gives `complete: false`, `cleared: null` and `disputes: null`, and the log, tickets and runs are untouched;
   - a dispute-sync error, or a throw from `syncDisputes`, gives 200 with `complete: false` and the error, after the clear;
   - an open dispute is recorded again as `dispute.received` and Resolve is nudged.
5. **Reset, HTTP:** `POST /demo/reset` is 404 unless `COUNTERSIGN_DEMO_RESET=on`, 401 for a principal key or none, 200 with the report for the approver key, and 409 or 503 with the sentence for a refusal.
6. **Disputes CLI unchanged:** `npm run disputes -- sync` prints the same lines and exit codes through `syncDisputes`.
7. **Reader:** a `demo.reset` entry reads as its sentence on `/audit/entries`, with and without a previous head.
8. **Run cap:** after a clear that removed today's runs, `overDailyCap` still counts them.
9. **Resolve:** `RESOLVE_BASELINE` parses as specified; `POST /messages` in baseline is refused under `scenarios` and `off`; `POST /scenarios/:id` stores and queues each scenario's message with the sender from `seed_orders` and its photo, refuses baseline for beats 4 and 5, refuses an unknown ID, a bad body, a token with protected mode, baseline with no token when Resolve has no PayPal variables, and an unseeded sender (409), and stores a capped run as `not_run`; a supplied token reaches that run's baseline connection, and appears in no stored row, trace or log line; it's dropped on every exit, passed to the one fallback rerun only, and refused when 60 seconds or less of its life is left; `canMintTokens` true and false each behave as specified. The `resolve` CLI's output is unchanged.
10. **Console:** every route to Resolve answers 401 without a signed-in cookie and never sends the key to Resolve; the dispute routes answer as before through `withSignIn`; the scenario and reset routes pass answers through as specified (the reset report with `cleared: null` included); `durationWords` gives "0s", "15s" and "1m 08s" for 0, 14,600 and 68,000 ms; the start-page view model gives the copy, the scenario cards and every reset sentence in requirements.md; `/` renders the start page, and shows the unreachable notice in place of the sign-in when the gate answers 502; the sidebar starts with "Start here"; the design check passes on every changed file.
11. **Blueprint:** `tests/render-blueprint.test.ts` parses `render.yaml` and checks the invariants in design.md item 23: services and types, paid plans, `autoDeployTrigger: off`, references, hostports and the URL each start-command prefix sets, each service's variables (no `PAYPAL_*` on Resolve), and no secret-looking value.
12. **Baseline launch, pairing and session limits:** the gate's `POST /baseline/launch` is 401 without the approver key, mints one token and sends it only to Resolve (a fake Resolve receives it; the answer and logs don't hold it), and gives each of its sentences; through `createApp` (so the mount order is tested), `POST /approvals/pairing-codes` needs the approver key and `POST /approvals/pair` with no key trades a valid code once for the key, while `/approvals/:id` behaves as before; a used, expired, unknown or malformed code is 401; the console's pair route sets the approver and session cookies and never answers the key; the console's baseline launch goes to the gate and its protected launch to Resolve; the 13th run or 4th reset in 10 minutes from one session is 429 with its sentence, another session isn't affected, a request with no session cookie is 401 "Sign in again.", a signed-out or wrong-key request spends no slot, `GET` routes aren't limited, sign-in sets two cookies and sign-out clears both, and the start page asks for its pairing code with a POST and uses only a 201.

## Live checks (`LIVE=1`, not in the Feedback commands)

1. `LIVE=1 npm test -- apps/gate/test/reset-live.test.ts` (needs the PayPal variables and both vault tokens): on a fresh PGlite log, with the clock moved past the one-minute cooldown between resets, a reset seeds all 30 orders in one run and reports `took_ms`; a second reset keeps all 30; after a $1.00 refund on one seeded capture, a third reset replaces exactly that order. Record each `took_ms` in progress.md; the second and third must be under 60,000, and the full seed's target is the same.

## Manual checks for the human (on Render)

1. Deploy the blueprint as `docs/hosting.md` says. Check the build log shows Node 26.7.0 on every service (spike S7), every service is on a paid plan with auto-deploy off, and the database accepts no outside connection. Set `CONSOLE_PUBLIC_URL` to the console's URL.
2. Register the sandbox webhook at `<gate URL>/webhooks/paypal` for `PAYMENT.CAPTURE.REFUNDED`, `CUSTOMER.DISPUTE.CREATED` and `PAYMENT.PAYOUTS-ITEM.*`, and set `PAYPAL_WEBHOOK_ID` on the gate.
3. Open the console URL signed out: the guide reads in about a minute, the inbox and chat ask for the sign-in, and nothing can be launched or reset. `POST <gate URL>/demo/reset` with no key answers 401.
4. Sign in with the generated approver key and press Reset once: 30 orders seeded, with the time recorded (target under 60 seconds).
5. Run the attack email in baseline mode, then protected; run the stalled parcel (a refund ID appears and the `PAYMENT.CAPTURE.REFUNDED` webhook reconciles it within 2 minutes); run the damaged basket, scan the start page's code with a phone (it should open Approvals signed in), and approve. Time the phone step from scan to approval and record it. Sign out on the phone and scan the same code again: the used-code sentence shows above the sign-in. This is gate G2. Check Resolve's environment on Render holds no `PAYPAL_*` variable and the baseline run still refunds.
6. Press Reset again: only the touched orders are replaced, under 60 seconds, and `/audit` starts with the reset entry. Press it again at once: "The demo was reset less than a minute ago." Run `npm run ledger -- verify` from the gate's Render Shell.
7. With beat 7's dispute opened on `KIK-1032`, read its capture's status (record it; the keep rule expects `COMPLETED`), and check the dispute appears on Disputes after a reset without running anything else.
8. Check the start page, inbox and dialog in light and dark, at desktop and phone width, and read the copy against the brand book.
9. Check the cron job's runs succeed, and that it reaches Resolve over the private network (a dispute sync nudge, or its log line).
10. During a baseline run of the attack email, read Resolve's peak memory in Render's metrics and record it; over about 450 MB, raise Resolve's plan.
