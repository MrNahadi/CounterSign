# Phase 6 requirements: a refund executes once, live

Brief §5 items 1 and 2, §6 (the propose flow, steps 1 to 6), §8 (fail closed, sandbox only, no secrets, the agent never holds credentials), §11 (rail clients have fixture-based contract tests), §12 (re-sending the same intent creates no second refund). Design baseline: original brief §9 (guarded actions), §12 (security controls: webhook signatures, idempotency). Decisions: ADR 0025 (new PayPal calls) and ADR 0026 (execution entries, exactly-once). Where this file and the brief disagree, the brief wins.

## Behaviour

### New rail calls

`@countersign/rail-paypal` gains these, with phase 5's rules unchanged: sandbox only, one cached token, zod-parsed records in minor units, errors that never carry a credential.

| Call | Endpoint | Notes |
|---|---|---|
| Refund capture | `POST /v2/payments/captures/{id}/refund` | Amount (USD only), `custom_id` = the intent ID, `PayPal-Request-Id` = the intent hash. Returns a refund record |
| Get refund | `GET /v2/payments/refunds/{id}` | Returns a refund record |
| List disputes | `GET /v1/customer/disputes?disputed_transaction_id={capture}` | Follows `next` links, up to 5 pages. Returns each dispute's ID and status, and whether the list is complete |
| Verify webhook signature | `POST /v1/notifications/verify-webhook-signature` | The five transmission headers, the webhook ID, and the event as the exact raw body text. Returns pass only for `verification_status: SUCCESS`. Never retried |

- **A refund record** holds its ID, status, amount, and the capture ID from its `up` link (null when absent).
- **Orders now carry refunds.** Each purchase unit gains its refunds from `payments.refunds`, as refund records. A capture's refunded total counts its `COMPLETED` and `PENDING` refunds. A refund with no capture link counts against the unit's only capture; if the unit has several captures, the refunded total for every capture in it is unknown (ADR 0025).
- `PAYPAL_WEBHOOK_ID` is read by its own parser, apart from the client's three variables, so everything that doesn't verify webhooks runs without it. Missing, it's reported by name.
- A webhook verification that PayPal answers with anything but `SUCCESS` is a fail. One that can't complete (network, 5xx, unreadable) is an error, never a pass.

### Live records become snapshots

- Given a capture ID and a ticket, the gate reads, in this order:
  1. the capture (`get capture`), for its status, amount and order ID;
  2. the order, for the payer email, trackers and refunds;
  3. the disputes list for the capture;
  4. the carrier shipment for each `SHIPPED` tracker on the order whose capture ID matches, through the carrier mock over `carrier_shipments`.
- Each becomes the snapshot phase 3 defined, with its call and record ID. The capture snapshot's refunded total comes from the order's refunds.
- **Fail closed.** A read that fails, or a record that can't be mapped, leaves that snapshot out, so the verifiers that need it return `unknown`. In particular:
  - no capture, or a capture whose order can't be read: no capture snapshot, so `capture.refundable` is unknown (and the proposal is invalid if it gave no amount);
  - a refunded total that's unknown: no capture snapshot;
  - a disputes list that isn't complete: no disputes snapshot;
  - a shipment that's not found or unreadable: no shipment snapshot.

  Reading never throws. Each failed read is reported as one line (the call, and the PayPal error's scrubbed message or the carrier's detail), for the CLI.
- The ticket snapshot comes from the caller. In this phase it comes from the proposal file and is labeled simulated; Resolve supplies real tickets in phase 8.
- The execution history comes from the audit log (below), read inside the deciding transaction.

### The execution history

- The audit log gains three entry types, as ADR 0026 sets out: `execution.requested`, `execution.result` and `reconciliation`. Appends accept them, and `ledger verify` passes on a chain that holds them.
- The gate reads the whole history as `ExecutionSnapshot`s: one per `execution.requested` entry that isn't a replay and has no later `failed` result. Its ID is the intent ID, its amount, capture and principal are the request's, and its time is the request's `at`.
- An entry of these types whose payload can't be read makes the history unknown: the snapshots' `executions` is left out, so `ledger.not_duplicate` is unknown and today's usage escalates (`DAILY_LIMIT_UNKNOWN`). It's never skipped.

### Proposing a refund

`proposeRefund` takes the mandate, the principal, the raw proposal, the ticket, the clock, the rail client, the carrier and the database. It does this:

1. Reads the live records (above), outside any transaction.
2. Opens one audit-log transaction under the ledger's lock, and in it:
   - reads the execution history;
   - normalizes the proposal. If its intent ID already has an `execution.requested` entry, it's a **replay** (below);
   - otherwise runs `decide()` with the live records and the history, and writes the decision entry, with the mandate's version entry the first time, as phase 4 does;
   - on **allow**, writes an `execution.requested` entry pointing at the decision entry.
3. Commits. On allow, sends the refund: the intent's capture and amount, `PayPal-Request-Id` = the intent hash, `custom_id` = the intent ID.
4. Appends an `execution.result` entry in its own transaction:
   - `executed` for a refund returned as `COMPLETED` or `PENDING`, with its ID and status;
   - `failed` for `FAILED` or `CANCELLED`, or an HTTP 4xx refusal, with PayPal's error name, issue codes and debug ID;
   - `unknown` for a network error, a 5xx after the client's retries, or a response that doesn't parse.
5. Returns the agent response, the decision record, the read problems, and for an execution its outcome, refund ID and the entries' `seq`s.

- A **step-up** or **deny** is recorded and nothing executes. A step-up's approval comes in phase 9.
- A **replay** isn't decided again:
  - if a result for the intent says `executed`, no rail call is made. The response is the same `allowed` response, and an `execution.requested` entry marked as a replay, holding the raw proposal and the first request's `seq`, is the only thing written;
  - otherwise (no result yet, `unknown` or `failed`), it writes that replay request and re-sends the refund with the same request ID, then appends a result. This only happens within 6 hours of the first request. After that nothing is sent, and the response is `denied` with `DUPLICATE_REFUND`, its detail naming the first request and telling the operator to run `npm run reconcile`.
- **Two intents on one capture.** Because a request with no result counts as executed, the second of two concurrent intents on one capture is denied `DUPLICATE_REFUND`, whichever finishes its rail call first.
- If recording fails (a mandate version logged with another hash, a rejected append), nothing executes, and the result says why.

### The propose CLI

- `npm run propose -- <proposal file> [--json] [--pglite <dir>]` runs every proposal in a file through `proposeRefund` against the sandbox, the carrier mock and the audit log, in the database the other CLIs use (`DATABASE_URL`, else `--pglite <dir>`, else `.countersign/pglite`).
- A proposal file holds:
  - a description, the mandate file (relative to the proposal file) and the principal;
  - one or more proposals, each with: the seed order number (`KIK-` and four digits) or a capture ID; the ticket (an ID, a sender, and attachments, each with an ID and content type); the `create_refund` arguments other than the capture; the justification; and the expected decision and reason codes, written before it's run.
  - The sender is `payer` (the order's payer email from `seed_orders`), `buyer:A` or `buyer:B` (that seed buyer's payer email from any of their `seed_orders` rows), or an email address.
- Order numbers and senders are resolved from `seed_orders`. An order number with no row, or a buyer with no rows, is a bad file: exit 2 with "Order KIK-1035 isn't seeded. Run npm run seed first." or the buyer's equivalent.
- For each proposal it prints the phase 3 output (decision, reasons, verifier trace, amount, intent ID and hash) and then:
  - for an execution: the outcome, the refund ID and status, and "Replayed, no new refund." for a replay with no rail call;
  - each read problem, one line each;
  - "Expected <decision> <codes>, got <decision> <codes>." when the result differs from the file's expectation.
- `--json` prints, per proposal, the agent response plus the execution outcome and refund ID.
- Exit 0 when every proposal matched its expectation, 1 when any differed or an execution's outcome was `unknown`, 2 when it can't run (a bad file, missing PayPal variables named, no database, an unmigrated database, a recording failure).
- **Demo proposal files** in `apps/gate/proposals/`, against the seed catalog and the fixture mandate `kikapu-studio` v3:
  - `beat-3-attack-email.json`: one ticket from `buyer:A` asking for refunds on KIK-1038 to KIK-1042. Expected: four denials `TICKET_NOT_FROM_PAYER` and one step-up `SHIPMENT_DELIVERED` on KIK-1042;
  - `beat-4-stalled-parcel.json`: KIK-1035, $18.00, claim not received, from `payer`. Expected: allow, and it executes;
  - `beat-5-damaged.json`: KIK-1037, $240.00, claim damaged with a photo, from `payer`. Expected: step-up `ABOVE_AUTO_LIMIT`.

  Running beat 4 a second time is a replay: allowed, no new refund. Its file says so in its description.

### The PayPal webhook

- `POST /webhooks/paypal` on the gate. The body is read raw, up to 64 KB, before any parsing.
- Steps:
  1. Read the five `PAYPAL-*` transmission headers with zod. Missing or malformed: 400.
  2. Verify the signature with `PAYPAL_WEBHOOK_ID` over the raw body. `PAYPAL_WEBHOOK_ID` missing, or the verification can't complete: 503, so PayPal redelivers. Verification fails: 400. Nothing is written in any of these cases.
  3. Parse the event (its ID, type and resource ID) with zod. Unreadable: 400.
  4. An event ID already in a `reconciliation` entry: 200, nothing written.
  5. `PAYMENT.CAPTURE.REFUNDED`: re-read the refund by the resource ID with get refund. Then append a `reconciliation` entry (source `webhook`, the event ID and type, the refund as re-read, the matched result's `seq`), with the intent ID as its ref when an `execution.result` names that refund ID, and null when none does. A refund that can't be read: 503.
  6. Any other event type: 200, nothing written. Later phases handle disputes.
- The handler never logs the body, headers or any secret. Its answers carry no detail beyond a short fixed message.

### The reconcile CLI

- `npm run reconcile [-- --pglite <dir>]` reads the audit log and, for each `execution.result` that's `executed` with a refund ID and no `reconciliation` for that refund, re-reads the refund and appends a `reconciliation` (source `poll`).
- It prints one line per refund reconciled (intent ID, refund ID, status, amount), then lists requests that have no result or an `unknown` result, oldest first, each with its intent ID, capture and age.
- Exit 0 when everything is reconciled and nothing is unknown; 1 when a re-read refund is `FAILED` or `CANCELLED`, its amount differs from the request, or unknown requests remain; 2 when it can't run.
- It never moves money. It's what the hosted cron runs from phase 13.

## Constraints

- No AI anywhere in this phase. The no-AI test still covers `mandate`, `verifiers` and `ledger`, and now also `rail-paypal`'s new calls and the gate's execution code paths (the gate itself may later host the MCP server, but its decide and execute modules import no AI SDK).
- The agent never holds credentials: `proposeRefund` takes a rail client built by the gate from the environment, never from the proposal.
- Sandbox only. Money is integer minor units. Only USD reaches PayPal; a KES refund intent is refused before any call (and the fixture mandate gives no allow rule for one).
- Every external input goes through zod: proposal files, webhook headers and events, PayPal responses, and audit-log payloads read back.
- Payloads read back from the log are parsed from their stored text for use, and never re-hashed (ADR 0003, ADR 0022).
- No secret, access token, vault token, `DATABASE_URL` or `Authorization` header appears in any output, error, log line or audit-log entry. Webhook transmission signatures aren't logged either.
- CLIs follow tech-stack.md's CLI conventions: a run function `(args, env)` returning `{ exitCode, stdout, stderr }`, a thin main file, env passed explicitly in tests, counts pluralised, no exclamation marks.

## Technical needs

- Workspace links `@countersign/gate` → `@countersign/rail-paypal` and `@countersign/carrier-mock` (installed by the planner).
- Root scripts: `propose` (`tsx --env-file-if-exists=.env.local apps/gate/src/propose-main.ts`) and `reconcile` (same shape).
- The gate's `createApp` takes its dependencies (the database, a rail client factory, the env) so tests can inject fakes; `/health` keeps working with none.
- README: a section "Refund on live records" with the three demo files, the replay, `npm run reconcile`, and a note that the ticket in phase 6 is simulated. The PayPal integration map gains refund, get refund, list disputes and webhook verification rows (sandbox IDs filled in by the live check).
- `CONTEXT.md` gains execution request, execution outcome, replay and unmatched refund, in the existing format.
