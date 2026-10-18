# Phase 7 tickets: the gate over MCP

## T-001: An intent target for every guarded PayPal action

Status: open
Blocked by:
Tier: standard
Slice: Intents for a dispute action, an invoice send, an order capture and a payout carry their own target and hashed parameters, while a refund's intent hashes exactly as before.
Test seam: the intent and `hashIntent` exports of `@countersign/mandate`, and `runVerifiers` in `@countersign/verifiers`
Acceptance:
- [ ] The intent target is one shape per action (capture, dispute, invoice, order, payee email), per ADR 0027; the ticket ID may be null for every action but a refund
- [ ] Phase 3's hand-written reference canonical string for a refund still hashes to the refund intent's hash, unchanged
- [ ] For each non-refund action, the hashed JSON adds `params` with that action's fixed keys (absent optional values as `null`); changing the target, amount or any parameter changes the hash, key order doesn't
- [ ] The capture-based verifiers return `unknown` for a target that isn't a capture, naming the target; a refund's trace is unchanged
- [ ] Every existing mandate, verifier and gate test passes, with only type-level changes in the tests
Notes:

## T-002: Get dispute, get invoice and transaction search

Status: open
Blocked by:
Tier: standard
Slice: The rail client reads one dispute with its amount and disputed captures, one invoice with its amount and recipients, and a page of transactions.
Test seam: `createPayPalClient(...)`'s new calls in `@countersign/rail-paypal`, against recorded fixtures and an injected `fetch`
Acceptance:
- [ ] Get dispute returns the ID, status, amount in minor units and disputed capture IDs; get invoice returns the ID, status, amount, invoice number and recipient emails; transaction search returns each transaction's ID, status, amount and initiation time, for a date range of at most 31 days
- [ ] A malformed ID, or a range over 31 days or with an unreadable date, is refused as `invalid_request` before any call
- [ ] A 404, a 403 and a 5xx become `PayPalError`s with PayPal's name, issues and debug ID; GETs retry as the client already does
- [ ] An amount in a currency other than USD or KES makes the record unreadable (`invalid_response`), never a guessed figure
- [ ] No captured request, error or return value holds the fake secret or access token
Notes:

## T-003: Normalize the dispute tools, and two new reason codes

Status: open
Blocked by: T-001
Tier: standard
Slice: `accept_dispute_claim`, `provide_dispute_evidence` and `make_offer` proposals become intents on the dispute's record, and the demo mandate holds each one for approval; an unreadable dispute is denied `TARGET_UNKNOWN`.
Test seam: the proposal normalization and `decide` functions in `apps/gate/src/`, and fixture cases in `apps/gate/fixtures/cases/`
Acceptance:
- [ ] The catalog gains `TARGET_UNKNOWN` and `ACTION_UNAVAILABLE` with requirements.md's words and hints; neither is a rule reason
- [ ] Each dispute tool's arguments are read with zod per requirements.md; a bad note, evidence item, offer type, offer amount or an unknown key is `INVALID_PROPOSAL`
- [ ] The intent's amount is the dispute's amount, or the offer amount for `make_offer` with one; no dispute record, or one in another currency, is `TARGET_UNKNOWN` with a detail naming the dispute
- [ ] The verifiers' snapshots and the case-file schema gain a dispute record (call `GET /v1/customer/disputes/{id}`, its ID); fixture cases give each dispute tool step-up `ALWAYS_NEEDS_APPROVAL` under the demo mandate, and an unreadable dispute deny `TARGET_UNKNOWN`
- [ ] `create_refund` accepts and ignores `invoice_id`, and its behaviour is otherwise unchanged
Notes:

## T-004: Normalize send_invoice, pay_order and create_payout, and ACTION_UNAVAILABLE

Status: open
Blocked by: T-003
Tier: standard
Slice: Invoice sends, order captures and payouts become intents; the demo mandate holds the invoice and denies the capture and the payout; and an allow for any action the gate can't execute becomes a deny `ACTION_UNAVAILABLE`.
Test seam: the proposal normalization and `decide` functions in `apps/gate/src/`, and fixture cases in `apps/gate/fixtures/cases/`
Acceptance:
- [ ] `send_invoice` takes the invoice's amount, `pay_order` the order's single purchase unit amount, `create_payout` the agent's amount and a lower-cased, trimmed receiver email; a missing invoice or order, or an order with several purchase units, is `TARGET_UNKNOWN`
- [ ] The case-file schema gains invoice records and an order's amount; fixture cases give `send_invoice` step-up `ALWAYS_NEEDS_APPROVAL`, and `pay_order` and `create_payout` deny `NO_MATCHING_RULE`, under the demo mandate
- [ ] With a fixture mandate that allows `paypal.order.capture`, `decide()` gives `pay_order` deny `ACTION_UNAVAILABLE`, keeping the intent, trace and matched rule; a refund allow is untouched
- [ ] The "every code is reached" test covers 25 codes, and every earlier fixture case still passes
Notes:

## T-005: The ticket store

Status: open
Blocked by:
Tier: standard
Slice: A ticket written once to the `tickets` table reads back by ID, and a changed rewrite is refused.
Test seam: the ticket writer and reader exported by `@countersign/db`, over PGlite
Acceptance:
- [ ] A migration adds `tickets` with requirements.md's columns; `npm run db:migrate` applies it on a fresh and on a phase 6 database
- [ ] Writing a ticket and reading it by ID returns the same channel, sender, subject, body, attachments, received time and simulated flag; an unknown ID reads as none
- [ ] Writing the same ID with the same contents is a no-op; with different contents it's refused with a typed error and the stored ticket is unchanged
- [ ] The writer validates its input with zod, including the shared timestamp rule for the received time
Notes:

## T-006: propose() for every guarded action, reading tickets from the store

Status: open
Blocked by: T-002, T-004, T-005
Tier: standard
Slice: Any guarded PayPal proposal is decided on its live records and the stored ticket, recorded in the audit log, and, only for an allowed refund, executed as in phase 6.
Test seam: the gate's propose function in `apps/gate/src/propose.ts`, with the fake sandbox and a PGlite database
Acceptance:
- [ ] Live reads follow the action: a refund reads what phase 6 reads; dispute tools read the dispute, `send_invoice` the invoice, `pay_order` the order, `create_payout` nothing; every action reads its ticket from the store; a failed read leaves its snapshot out and adds one read problem
- [ ] The caller-supplied ticket input is gone; a refund whose ticket ID isn't stored has `ticket.from_payer` unknown and is denied, and beat 4 with its stored payer ticket is allowed and refunded once, as in phase 6
- [ ] A dispute, invoice, capture or payout proposal writes a decision entry and no execution entries, and the fake sandbox records no money-moving call; `ledger verify` passes
- [ ] Replays still apply to refunds only, and every phase 6 propose, replay and execution test passes
- [ ] The propose CLI writes each file ticket to the store (simulated) before proposing, and its beat 3, 4 and 5 tests pass unchanged
Notes:

## T-007: Principal keys

Status: open
Blocked by:
Tier: simple
Slice: A bearer header is turned into the principal and its mandate, or refused, from keys in the environment.
Test seam: the gate's principal-key module in `apps/gate/src/` (its exported parse and authenticate functions)
Acceptance:
- [ ] `COUNTERSIGN_SUPPORT_AGENT_KEY` of 32+ characters authenticates `Bearer <key>` as `support-agent` with the `kikapu-studio` v3 mandate, parsed once
- [ ] No header, another scheme, an empty or wrong key, and a configured key under 32 characters all give the same refusal; comparison is constant-time over SHA-256 digests
- [ ] With no key configured, every header is refused, and the env parser names the unset variable without showing any value
- [ ] Env is validated with zod and passed explicitly in tests
Notes:

## T-008: The MCP endpoint with guarded tools

Status: open
Blocked by: T-006, T-007
Tier: standard
Slice: An MCP client with the support agent's key lists the guarded tools and calls `create_refund` on beat 4, getting `allowed` and one sandbox refund, with the decision in the audit log.
Test seam: `createApp(...)` listening on `127.0.0.1` port 0, driven by the MCP SDK's `Client` over `StreamableHTTPClientTransport`
Acceptance:
- [ ] `POST /mcp` serves stateless JSON-mode MCP with a low-level `Server` per request; `GET` and `DELETE` answer 405; a missing or wrong key answers 401 with one fixed body before any MCP handling
- [ ] `tools/list` returns the seven guarded tools with input schemas from the normalization zod schemas, extensions described as such
- [ ] A guarded call returns the agent response as `structuredContent` and JSON text with `isError: false`; beat 4 is allowed and refunds once, a second call is a replay with no second refund, beat 3's five proposals give 4 denials and 1 step-up
- [ ] A malformed `create_refund` and an unknown tool name are denied (`INVALID_PROPOSAL`, `UNKNOWN_ACTION`) and recorded, not MCP errors; a recording failure is `isError: true` with requirements.md's fixed message
- [ ] `server.ts` wires the database, rail, carrier and keys from the environment, and the gate still starts and answers `/health` with none of them set
Notes:

## T-009: Read-only tools

Status: open
Blocked by: T-002, T-008
Tier: standard
Slice: An MCP client reads an order, a refund, disputes, one dispute, an order's tracking with the simulated carrier's status, and transactions through the gate.
Test seam: `createApp(...)` listening on `127.0.0.1` port 0, driven by the MCP SDK's `Client`, with the fake sandbox and carrier store
Acceptance:
- [ ] `tools/list` adds `get_order`, `get_refund`, `list_disputes`, `get_dispute`, `get_shipment_tracking` and `list_transactions` with PayPal's argument names
- [ ] Each returns the record as `structuredContent` and JSON text, money as `{ value, currency_code }`; `get_shipment_tracking` labels carrier data simulated
- [ ] A failing read, a malformed ID and a date range over 31 days answer `isError: true` with a fixed one-line message, with nothing from PayPal's body or any secret
- [ ] No read adds an audit-log entry, and every read needs the principal key
Notes:

## T-010: The stand-in agent CLI

Status: open
Blocked by: T-008
Tier: standard
Slice: `npm run agent -- <proposal file>` writes the file's simulated tickets and calls the gate over MCP with the principal key, printing each decision and whether it matched.
Test seam: the CLI's exported run function against a listening gate and a PGlite directory, plus one child-process run of the real entry point
Acceptance:
- [ ] On `beat-4-stalled-parcel.json` and the new `guarded-actions.json`, every decision matches its `expect` and the CLI exits 0; a differing decision exits 1
- [ ] The proposal file schema gains an optional `tool`; only `create_refund` proposals may name an `order` or `capture`
- [ ] A missing `COUNTERSIGN_SUPPORT_AGENT_KEY` is named, never shown; a 401 or an unreachable gate exits 2 with one line saying which
- [ ] `--json` prints the agent responses, which validate against the agent response schema; the root `package.json` has the `agent` script
Notes:

## T-011: Live checks for the new rail calls

Status: open
Blocked by: T-002
Tier: simple
Slice: Under `LIVE=1`, the sandbox's answers to get dispute, get invoice and transaction search parse with the rail client's schemas.
Test seam: `packages/rail-paypal/test/live-sandbox.test.ts` (runs only with `LIVE=1` and the PayPal variables set)
Acceptance:
- [ ] Get dispute and get invoice of made-up IDs give `PayPalError`s with HTTP 404 (or the status the sandbox really answers, asserted and noted)
- [ ] Transaction search over the last day parses, or the test asserts the sandbox's 403 and says the app lacks Transaction Search
- [ ] Without `LIVE=1` the checks are skipped, and `npm test` stays green with no credentials
Notes:

## T-012: README: connect an agent

Status: open
Blocked by: T-009, T-010
Tier: simple
Slice: A developer reading the README can connect an MCP client to the gate with a principal key and knows which tools are PayPal's and which are Countersign extensions.
Test seam: the README, plus the existing doc-free test suite staying green
Acceptance:
- [ ] A README section shows the `/mcp` URL, the bearer key variable, the tool table (guarded, read-only, extensions marked), what each guarded tool decides under the demo mandate, and that only refunds execute in this phase
- [ ] It shows `npm run agent` on the beat 4 and guarded-actions files, says the tickets are simulated and the people illustrative, and the project status section lists phase 7
- [ ] `CONTEXT.md` terms used in the section match the glossary (principal key, Countersign extension, target, ticket)
Notes:
