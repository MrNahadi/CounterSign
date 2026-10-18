# Phase 6 tickets: a refund executes once, live

## T-001: Refund capture, get refund, and refunds on orders

Status: done
Blocked by:
Tier: standard
Slice: The rail client refunds a capture with a request ID, reads a refund back, and reports each capture's refunded total from the order's refunds.
Test seam: `createPayPalClient(...)`'s `refundCapture`, `getRefund` and `getOrder` in `@countersign/rail-paypal`, against recorded fixtures and an injected `fetch`
Acceptance:
- [x] A refund sends the amount in PayPal's format, `custom_id` and the caller's `PayPal-Request-Id`, and returns the refund's ID, status, amount and capture ID (from its `up` link) in minor units. A replayed request ID answered with HTTP 200 returns the same record
- [x] A non-USD amount, a malformed capture ID or a missing request ID is refused as `invalid_request` before any call
- [x] Get refund parses `COMPLETED`, `PENDING`, `FAILED` and `CANCELLED` refunds; a 404 and a 422 become `PayPalError`s with PayPal's name, issues and debug ID
- [x] Orders carry each purchase unit's refunds. A capture's refunded total counts `COMPLETED` and `PENDING` refunds only; an unattributable refund counts against a unit's only capture, and makes the total unknown when the unit has several
- [x] No captured request, error or return value holds the fake secret or access token
Notes:

## T-002: List disputes by capture, and webhook signature verification

Status: done
Blocked by:
Tier: standard
Slice: The rail client says whether a capture has disputes, reading every page, and checks a webhook's signature over its exact raw body.
Test seam: `listDisputes` and `verifyWebhookSignature` on the client, and the `PAYPAL_WEBHOOK_ID` parser, in `@countersign/rail-paypal`
Acceptance:
- [x] List disputes filters by `disputed_transaction_id`, follows `next` links up to 5 pages, and returns each dispute's ID and status plus `complete: true`; a sixth page leaves `complete: false`
- [x] Verification sends the five transmission headers, the webhook ID and the raw body text unchanged (a body with odd spacing and key order is found byte for byte in the request); `SUCCESS` is a pass and `FAILURE` a fail
- [x] A verification that gets a 5xx, a network error or an unreadable answer throws a `PayPalError` and is made exactly once
- [x] A missing `PAYPAL_WEBHOOK_ID` is reported by name, and the client's other calls don't need it
Notes:

## T-003: Execution entry types and the execution history

Status: done
Blocked by:
Tier: standard
Slice: The audit log accepts execution requests, results and reconciliations, and the gate reads the log back as the execution history the verifiers use.
Test seam: the ledger's append and verify exports, and the gate's execution-history reader over a PGlite database
Acceptance:
- [x] `execution.requested`, `execution.result` and `reconciliation` append and pass `ledger verify`; an unknown type is still rejected
- [x] The gate's payload schemas (zod) for the three types match ADR 0026, and the writers it exports build only valid payloads
- [x] The history has one `ExecutionSnapshot` per non-replay request with no later `failed` result, with the request's amount, capture, principal and time; replay requests don't add a second
- [x] An unreadable payload of one of these types makes the history unknown, never skipped
- [x] The no-AI test still passes for `@countersign/ledger`
Notes:

## T-004: Live records mapped into snapshots

Status: done
Blocked by: T-001, T-002
Tier: standard
Slice: Given a capture ID and a ticket, the gate reads the capture, order, disputes and shipment and returns the record snapshots, plus one line for each read that failed.
Test seam: the gate's live-record reader, with a fake PayPal client and an in-memory carrier store
Acceptance:
- [x] A stalled-parcel order gives capture, order, disputes and shipment snapshots that let the beat 4 proposal pass every verifier, each with its call and record ID
- [x] The capture snapshot's refunded total comes from the order's refunds, and is left out when the total is unknown
- [x] A capture 404, an order 500, an incomplete disputes list, and a shipment not found or unreadable each leave exactly their snapshot out and add one read problem naming the call; nothing throws
- [x] Only `SHIPPED` trackers for the intent's capture are looked up with the carrier
- [x] No read problem holds a secret
Notes:

## T-005: Decide on live records under the ledger lock

Status: done
Blocked by: T-003, T-004
Tier: standard
Slice: A refund proposal is decided on live records and the execution history from the log, in one audit-log transaction that writes the decision and, on allow, the execution request.
Test seam: `proposeRefund(...)` in the gate, against a stateful fake sandbox and PGlite, with execution switched off by the fake's answers where needed
Acceptance:
- [x] Beat 3's five proposals give four denials `TICKET_NOT_FROM_PAYER` and one step-up `SHIPMENT_DELIVERED`; each writes one decision entry and no request
- [x] Beat 4 writes a decision entry and an `execution.requested` entry pointing at it, in the same transaction
- [x] With an earlier request on the same capture in the log (no result yet), a new intent is denied `DUPLICATE_REFUND`
- [x] A recording failure (a mandate version logged with another hash) writes nothing and requests nothing
- [x] Two different intents on one capture run concurrently: exactly one request is written
Notes:

## T-006: Execute once, and replays

Status: done
Blocked by: T-005
Tier: standard
Slice: An allowed refund is sent once with the intent hash as request ID, its outcome is logged, and proposing the same intent again never pays twice.
Test seam: `proposeRefund(...)` in the gate, against the stateful fake sandbox and PGlite
Acceptance:
- [x] Beat 4 makes one refund with request ID = intent hash and `custom_id` = intent ID, and appends `execution.result` `executed` with the refund ID; the response is `allowed`
- [x] Proposing beat 4 again makes no rail call, writes only a replay request, and answers `allowed` with the same intent ID
- [x] A request whose result was `unknown` (or that has none) is re-sent with the same request ID within 6 hours and gets the same refund; after 6 hours nothing is sent and the answer is `DUPLICATE_REFUND`
- [x] A 4xx refusal is `failed` with PayPal's name, issues and debug ID; a network error or unparseable answer is `unknown`
- [x] A step-up and a deny make no rail call; `ledger verify` passes on every resulting chain
Notes:

## T-007: The propose CLI and demo proposal files

Status: done
Blocked by: T-006
Tier: standard
Slice: `npm run propose -- apps/gate/proposals/beat-4-stalled-parcel.json` decides on live records, executes once, and prints the decision, trace and refund ID.
Test seam: the propose CLI's run function `(args, env, options)` with an injected fake sandbox and a PGlite directory, plus one child-process run
Acceptance:
- [x] Proposal files are validated with zod; order numbers and `payer`, `buyer:A`, `buyer:B` senders resolve from `seed_orders`, and an unseeded order exits 2 with "Order KIK-1035 isn't seeded. Run npm run seed first."
- [x] The three demo files give their expected decisions against the fake sandbox and exit 0; a second beat 4 run prints "Replayed, no new refund."
- [x] A result that differs from the file's expectation prints "Expected … got …" and exits 1, as does an `unknown` outcome
- [x] Missing PayPal variables, no database and an unmigrated database exit 2 with the named reason; `--json` prints the responses with outcomes and refund IDs
- [x] The root `propose` script runs it; README gains "Refund on live records"; `CONTEXT.md` gains the new terms
Notes:

## T-008: The PayPal webhook route

Status: done
Blocked by: T-001, T-002, T-003
Tier: standard
Slice: A verified `PAYMENT.CAPTURE.REFUNDED` webhook reconciles Countersign's refund in the audit log, once.
Test seam: the gate's `createApp(deps)` with a fake PayPal client and PGlite, called through Express without a listening port
Acceptance:
- [x] A verified event for a refund an `execution.result` names appends one `reconciliation` (source `webhook`) with the intent ID as ref and the refund as re-read with get refund
- [x] The same event ID again answers 200 and writes nothing; a refund nobody requested is logged with a null ref
- [x] Missing headers or an unreadable event is 400; a failed signature is 400; a missing `PAYPAL_WEBHOOK_ID`, a verification error or an unreadable refund is 503; none writes anything
- [x] Other event types answer 200 and write nothing; a body over 64 KB is refused; `/health` still works with no dependencies
- [x] Nothing the route logs or answers contains the body, a header value or a secret
Notes:

## T-009: The reconcile CLI

Status: done
Blocked by: T-001, T-003
Tier: simple
Slice: `npm run reconcile` re-reads every executed, unreconciled refund, logs a reconciliation for each, and lists requests whose outcome is still open.
Test seam: the reconcile CLI's run function `(args, env, options)` with a fake PayPal client and a PGlite directory
Acceptance:
- [x] An executed refund with no reconciliation gets one (source `poll`); a second run adds nothing
- [x] A re-read refund that's `CANCELLED` or `FAILED`, or whose amount differs from the request, exits 1 and is listed
- [x] Requests with no result or an `unknown` result are listed oldest first with their age, and exit 1
- [x] Missing variables or no database exit 2 naming the reason; the root `reconcile` script runs it
Notes:

## T-010: Live sandbox checks for refunds, disputes and webhook verification

Status: open
Blocked by: T-001, T-002
Tier: simple
Slice: Under `LIVE=1`, the new calls run against the real sandbox and their responses parse with the client's schemas.
Test seam: `packages/rail-paypal/test/live-sandbox.test.ts` (skipped unless `LIVE=1`)
Acceptance:
- [ ] With the `PAYPAL_*` variables: list disputes for a made-up capture ID returns a complete empty list; get refund for a made-up ID is a 404 `PayPalError`
- [ ] With `PAYPAL_SEED_VAULT_TOKEN` too: a $1.00 vault order is captured and refunded twice with one request ID (same refund ID), then get order shows a refunded total of $1.00 and get refund reads it; otherwise skipped naming the variable
- [ ] With `PAYPAL_WEBHOOK_ID` too: a made-up event and headers come back as a fail, not an error; otherwise skipped naming the variable
- [ ] `npm test` skips the file cleanly, and no assertion can print a secret
Notes:
