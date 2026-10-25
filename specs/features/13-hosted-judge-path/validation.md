# Phase 13 validation: the hosted judge path

## Automated checks

All run from the repo root and are part of the Feedback commands.

1. `npm run typecheck`, `npm run lint`, `npm test` and `npm run build` pass.
2. **Seed package:** the storefront's seed, catalog and checkout tests pass importing from `@countersign/seed`; `npm run seed -- --dry-run` prints the same plan as before; the no-AI test lists `seed`.
3. **Clearing:** on PGlite, `clearDemoTables` empties the six tables, leaves `seed_orders` and `carrier_shipments` untouched, returns the old head and counts, and adds each date's run and draft counts to `cleared_run_counts` (twice adds up); `countUnfinishedWork` counts only `queued` and `running`.
4. **Reset, gate:** with a fake sandbox and an injected seed run:
   - an empty database replaces all 30 orders and writes entry 1 `demo.reset` with `previous_head: null`;
   - a seeded database whose captures are all `COMPLETED` keeps all 30 and replaces none;
   - a refunded capture, a capture read that fails, a missing row and a row with the wrong buyer are each replaced, in one run with a new run ID;
   - the old log's head and counts are in the `demo.reset` payload, and `verifyLog` passes afterwards;
   - a queued run, a running draft, an execution in flight or a second reset is refused 409 with nothing changed;
   - a missing database, PayPal variable or vault token is refused 503, naming only variables;
   - a seed failure or a dispute-sync error gives `complete: false` with the details, after the clear;
   - an open dispute is recorded again as `dispute.received` and Resolve is nudged.
5. **Reset, HTTP and CLI:** `POST /demo/reset` is 404 unless `COUNTERSIGN_DEMO_RESET=on`, 401 for a principal key or none, 200 with the report for the approver key; `npm run reset` prints the lines in requirements.md and exits 0, 1 or 2 as specified, in-process and once as a child process.
6. **Disputes CLI unchanged:** `npm run disputes -- sync` prints the same lines and exit codes through `syncDisputes`.
7. **Reader:** a `demo.reset` entry reads as its sentence on `/audit/entries`, with and without a previous head.
8. **Run cap:** after a clear that removed today's runs, `overDailyCap` still counts them.
9. **Resolve:** `RESOLVE_BASELINE` parses as specified; `POST /messages` in baseline is refused under `scenarios` and `off`; `POST /scenarios/:id` stores and queues each scenario's message with the sender from `seed_orders` and its photo, refuses baseline for beats 4 and 5, refuses an unknown ID, a bad body, and an unseeded sender (409), and stores a capped run as `not_run`. The `resolve` CLI's output is unchanged.
10. **Console:** every route to Resolve answers 401 without a signed-in cookie and never sends the key to Resolve; the scenario and reset routes pass answers through as specified; the start-page view model gives the copy, the scenario cards and the reset sentences in requirements.md; `/` renders the start page; the sidebar starts with "Start here"; the design check passes on every changed file.
11. **Blueprint:** `tests/render-blueprint.test.ts` parses `render.yaml` and pins the services, plans, commands, health checks, references and variables in design.md, and finds no secret-looking value.

## Live checks (`LIVE=1`, not in the Feedback commands)

1. `LIVE=1 npm test -- apps/gate/test/reset-live.test.ts` (needs the PayPal variables and both vault tokens): on a fresh PGlite log, a reset seeds all 30 orders in one run and reports `took_ms`; a second reset keeps all 30; after a $1.00 refund on one seeded capture, a third reset replaces exactly that order. Record each `took_ms` in progress.md; the full seed should be under 60,000.

## Manual checks for the human (on Render)

1. Deploy the blueprint as `docs/hosting.md` says. Check the build log shows Node 26.7.0 on every service (spike S7), every service is on a paid plan, and the database accepts no outside connection.
2. Register the sandbox webhook at `<gate URL>/webhooks/paypal` for `PAYMENT.CAPTURE.REFUNDED`, `CUSTOMER.DISPUTE.CREATED` and `PAYMENT.PAYOUTS-ITEM.*`, and set `PAYPAL_WEBHOOK_ID` on the gate.
3. Open the console URL signed out: the guide reads in about a minute, the inbox and chat ask for the sign-in, and nothing can be launched or reset.
4. Sign in with the generated approver key and press Reset once: 30 orders seeded in under 60 seconds.
5. Run the attack email in baseline mode, then protected; run the stalled parcel (a refund ID appears and the `PAYMENT.CAPTURE.REFUNDED` webhook reconciles it within 2 minutes); run the damaged basket and approve it on a phone through the start page's code. This is gate G2.
6. Press Reset again: only the refunded orders are replaced, under 60 seconds, and `/audit` starts with the reset entry. Run `npm run ledger -- verify` from the gate's Render Shell.
7. With beat 7's dispute opened on `KIK-1032`, check it appears on Disputes after a reset without running anything else.
8. Check the start page, inbox and dialog in light and dark, at desktop and phone width, and read the copy against the brand book.
9. Check the cron job's runs succeed, and that it reaches Resolve over the private network (a dispute sync nudge, or its log line).
