# Phase 6 validation: a refund executes once, live

## Automated checks

All run from the repo root and are part of the Feedback commands, except checks 12 to 14, which are live.

1. `npm run typecheck`, `npm run lint`, `npm test` and `npm run build` pass, with no PayPal variables and no `PAYPAL_WEBHOOK_ID` set.
2. **Contract tests:** recorded fixtures for a refund (`COMPLETED`, `PENDING`, `FAILED`), a replayed refund (HTTP 200, same ID), get refund, an order with one capture and two refunds, an order whose refund has no capture link, a disputes list over two pages, an empty disputes list, a webhook verification `SUCCESS` and `FAILURE`, and 404 and 422 refund errors all parse into the client's records or errors. A refund to a non-USD amount is refused before any call.
3. **Refunded total:** `COMPLETED` and `PENDING` refunds count, `FAILED` and `CANCELLED` don't. An unattributable refund in a unit with two captures makes the total unknown, and the gate then has no capture snapshot.
4. **Webhook body bytes:** the verification request carries the raw event text byte for byte (a test sends a body with unusual spacing and key order and checks the request body contains it unchanged). The call is made once, never retried.
5. **Live records, against the fake sandbox:** a seeded stalled order maps to snapshots that let the beat 4 proposal pass every verifier. Each failed read (capture 404, order 500, disputes paging cut off, shipment not found or unreadable) leaves exactly its snapshot out, gives `unknown` for its verifiers, and is reported as one line. Nothing throws.
6. **Execution history:** requests count as executions unless a later result says `failed`; replays don't count twice; an unreadable execution payload makes the history unknown, giving `HISTORY_UNKNOWN` and `DAILY_LIMIT_UNKNOWN`.
7. **Exactly once, against the fake sandbox and PGlite:**
   - beat 4 allows, writes decision, request and result entries, and makes one refund whose request ID is the intent hash and whose `custom_id` is the intent ID;
   - proposing it again makes no rail call and no second refund, answers `allowed` with the same intent ID, and writes only a replay request;
   - a request with an `unknown` result is re-sent with the same request ID, and the fake returns the same refund;
   - after 6 hours an unfinished request isn't re-sent, and the answer is `DUPLICATE_REFUND`;
   - two different intents on one capture run concurrently: one refund, and the other is denied `DUPLICATE_REFUND`;
   - a step-up and a deny write a decision entry and make no rail call;
   - a 4xx refusal gives `failed`, a network error gives `unknown`, and the CLI exits 1 on `unknown`.
   - `ledger verify` passes on the resulting chain.
8. **Propose CLI:** beats 3, 4 and 5 against the fake sandbox give the expected decisions and exit 0. A changed expectation exits 1 with the "Expected … got …" line. An unseeded order exits 2 naming it. Missing PayPal variables exit 2 naming them. One child-process run with `node --import tsx`.
9. **Webhook route:** a verified `PAYMENT.CAPTURE.REFUNDED` for Countersign's refund appends one `reconciliation` with the intent ID as ref; the same event again writes nothing and answers 200; an unknown refund is logged with a null ref; a failed signature is 400 and a missing `PAYPAL_WEBHOOK_ID` is 503, both writing nothing; another event type is 200 with nothing written; a body over 64 KB is refused.
10. **Reconcile CLI:** an executed, unreconciled refund gets one `reconciliation` (source `poll`); a second run adds nothing; a `CANCELLED` refund or a request with no result exits 1 and is listed.
11. **No secrets:** after the refund, webhook and CLI tests, no output, error or audit-log payload contains the fake client secret, access token, `DATABASE_URL` or a transmission signature. The no-AI test passes.
12. **Live, client credentials only (`LIVE=1`, needs `PAYPAL_*`):** list disputes for a made-up capture ID is a 400 `INVALID_REQUEST` `PayPalError` (the sandbox refuses the filter on a transaction the merchant doesn't hold; a real capture's complete, empty list is checked in check 13); get refund for a made-up ID is a 404 `PayPalError`. Run with `LIVE=1 npm test -- packages/rail-paypal`. The validator can run this now.
13. **Live, refund (`LIVE=1`, also needs `PAYPAL_SEED_VAULT_TOKEN`):** a $1.00 vault order is captured, refunded with a request ID, refunded again with the same request ID (same refund ID, HTTP 200), then read back with get order, whose refunds parse and give a refunded total of $1.00, and with get refund. List disputes for that capture returns a complete, empty list that parses. Skipped with a message naming the variable when it isn't set.
14. **Live, webhook verification (`LIVE=1`, also needs `PAYPAL_WEBHOOK_ID`):** a made-up event with made-up headers comes back as a fail, not an error. Skipped naming the variable when it isn't set.

## Manual checks for the human

1. **Once the two seed buyers exist** (`.ralph/human.md`), run `npm run seed`, then `npm run propose -- apps/gate/proposals/beat-3-attack-email.json`, then beat 4 and beat 5. Check each prints the expected decisions and exits 0, and that beat 4 prints a real sandbox refund ID that the sandbox merchant dashboard shows on KIK-1035's capture.
2. Run beat 4 again. Check it says "Replayed, no new refund." and the dashboard still shows one refund.
3. Run `npm run reconcile`. Check it reconciles the beat 4 refund, and that `npm run ledger -- verify` passes and `npm run ledger -- tail` shows the decision, request, result and reconciliation entries.
4. **Once phase 13 gives a public URL:** register a sandbox webhook for `PAYMENT.CAPTURE.REFUNDED` at `<gate URL>/webhooks/paypal`, set `PAYPAL_WEBHOOK_ID` in Render and the Dev environment, run beat 4 on a fresh seed, and check a `reconciliation` with source `webhook` appears within 2 minutes (G4). Run check 14 too. This is also where the live event's resource shape is confirmed (ADR 0025).
5. Read the propose output as a stranger: can they tell which refund moved money, which waits for approval, and why the others were refused?
6. **Gate G1:** with checks 1 to 3 done, a refund intent gets allow, step-up or deny from the CLI on live records, executes once, and the audit log verifies.
