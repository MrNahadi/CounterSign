# Phase 7 requirements: the gate over MCP

Brief §5 item 1, §6 (the propose flow, steps 1 to 6), §8 (credential custody, fail closed, what you approve is what executes). Design baseline: original brief §6, §9 and §12. Decisions: ADRs 0027, 0028 and 0029, which amend ADRs 0001, 0019 and 0020. Where this file and the brief disagree, the brief wins.

## Behaviour

### Authentication

- The gate serves MCP at `POST /mcp`: stateless Streamable HTTP in JSON mode, a new server and transport per request (ADR 0001). `GET` and `DELETE /mcp` answer 405.
- Every `/mcp` request needs `Authorization: Bearer <principal key>`. The gate knows one principal in this phase: `support-agent`, whose key is `COUNTERSIGN_SUPPORT_AGENT_KEY`. A key under 32 characters counts as unset.
- A missing header, a scheme other than `Bearer`, an empty key, or a key that matches no principal gets HTTP 401 with one fixed JSON body. It never says which principals exist or which keys are set, and no MCP server is built for it. Keys are compared as SHA-256 digests in constant time.
- With no key set at all, every `/mcp` request gets the same 401, and the gate logs one line at startup naming the unset variable (never a value).
- The principal comes only from the key. The principal's mandate is fixed by the gate: `support-agent` uses `kikapu-studio` v3 from `packages/mandate/fixtures/kikapu-studio-v3.json`, parsed with the mandate schema once at startup. A mandate that doesn't parse stops the gate from serving `/mcp` (401 for all), and startup says why.
- `/health` and `/webhooks/paypal` behave as in phase 6.

### Tools

`tools/list` returns these tools, each with a description and an input JSON Schema generated from the same zod schema the gate normalizes with. Guarded tools also take a `justification` object: `ticket_id` (required for `create_refund`, optional otherwise) and `claim` (`not_received`, `damaged`, `wrong_item`, optional).

| Tool | Kind | Action | Arguments (besides `justification`) |
|---|---|---|---|
| `create_refund` | guarded | `paypal.refund` | `capture_id`; optional `amount` `{ value, currency_code }`, `note_to_payer`, `invoice_id` (accepted and ignored, as in phase 6 for the note) |
| `accept_dispute_claim` | guarded | `paypal.dispute.accept_claim` | `dispute_id`; `note` (1 to 2,000 characters) |
| `provide_dispute_evidence` | guarded, extension | `paypal.dispute.provide_evidence` | `dispute_id`; `evidence`: 1 to 10 items of `{ evidence_type, notes, tracking_numbers? }`, where `evidence_type` is one of PayPal's (`PROOF_OF_FULFILLMENT`, `PROOF_OF_REFUND`, `OTHER`, …) and `notes` is 1 to 2,000 characters |
| `make_offer` | guarded, extension | `paypal.dispute.make_offer` | `dispute_id`; `offer_type` (`REFUND`, `REFUND_WITH_RETURN`, `REFUND_WITH_REPLACEMENT`, `REPLACEMENT_WITHOUT_REFUND`); `offer_amount` `{ value, currency_code }` (required unless the type is `REPLACEMENT_WITHOUT_REFUND`, and refused with it); `note` (1 to 2,000 characters) |
| `send_invoice` | guarded | `paypal.invoice.send` | `invoice_id`; optional `note`, `send_to_recipient`, `additional_recipients` (emails, at most 100) |
| `pay_order` | guarded | `paypal.order.capture` | `id` (the order ID) |
| `create_payout` | guarded, extension | `paypal.payout` | `receiver` (email); `amount` `{ value, currency_code }`; optional `note` |
| `get_order` | read-only | | `id` |
| `get_refund` | read-only | | `refund_id` |
| `list_disputes` | read-only | | optional `disputed_transaction_id`, `dispute_state`, `page_size` |
| `get_dispute` | read-only | | `dispute_id` |
| `get_shipment_tracking` | read-only | | `order_id` (optional `transaction_id` narrows it to one capture) |
| `list_transactions` | read-only | | optional `transaction_id`, `start_date`, `end_date` (ISO 8601, at most 31 days apart; default the last 31 days) |

- Tool names and argument names follow PayPal's Agent Toolkit 1.11.0 where it has the tool. Extensions are named so in their description ("Countersign extension: PayPal's Agent Toolkit has no such tool.").
- Any other tool name is a guarded call to an unknown action: denied `UNKNOWN_ACTION` and recorded.

### Guarded calls

- `tools/call` for a guarded tool hands its name and raw arguments to the gate as a proposal (`{ tool, args, justification }`) without validating them first. The gate's normalization is the only validation, so a malformed call is denied `INVALID_PROPOSAL` and recorded like any other.
- The result is the agent response (original brief §6, phase 3's schema), as `structuredContent` and as its JSON text in `content`, with `isError: false` for allowed, pending approval and denied alike.
- If recording fails, nothing executes and the result is `isError: true` with a fixed message ("Countersign couldn't record this proposal, so nothing was done."). Nothing a database or rail error carries reaches the agent.
- The flow is phase 6's, for every action: live reads outside any transaction; then one audit-log transaction under the ledger lock reads the execution history, answers a replay or decides, and writes the decision entry and, for an allowed refund, `execution.requested`; then the refund call and `execution.result`. The decision time is read once per call at the edge.

### Normalizing each action (ADR 0027)

- Each guarded tool normalizes into an intent with its action, its target, its amount, the ticket ID (or null), the claim (or null), the mandate version, and for actions other than a refund its hashed parameters. Every argument is read with zod; unknown argument keys are `INVALID_PROPOSAL`, as in phase 3.
- Targets and amounts:
  - `create_refund`: phase 3 and 6 behaviour, unchanged.
  - Dispute tools: target the dispute ID, and always read the dispute, so an unreadable dispute is `TARGET_UNKNOWN`. The amount is the dispute's amount, except a `make_offer` with an `offer_amount`, which uses the offer amount. An offer amount in another currency than the dispute's is `INVALID_PROPOSAL`.
  - `send_invoice`: target the invoice ID; the amount is the invoice's amount from get invoice.
  - `pay_order`: target the order ID; the amount is the order's first purchase unit amount from get order. An order with several purchase units is `TARGET_UNKNOWN`.
  - `create_payout`: target the receiver's email, compared and hashed lower-cased and trimmed; the amount is the agent's.
- A target record that's missing, unreadable, or in a currency other than USD or KES denies the proposal `TARGET_UNKNOWN`, with a detail naming the record and the read problem. A refund with no amount and no capture record stays `INVALID_PROPOSAL`.
- Money in arguments is parsed as in phase 3: strict, USD and KES only, at most two decimals, greater than zero.
- The intent hash for a refund is byte-for-byte phase 6's. For every other action the hashed JSON adds `params`, whose keys are fixed per action, with absent optional values as `null`. A changed note, offer type, recipient list or evidence item changes the hash.

### Verifiers and decisions for the new actions

- A refund runs every refund verifier, as before. Other actions run only the verifiers their matched mandate's rules require. The capture-based verifiers return `unknown` for an intent whose target isn't a capture, naming the target in the detail.
- The demo mandate gives these decisions, which the fixture cases pin:
  - `accept_dispute_claim`, `provide_dispute_evidence`, `make_offer` and `send_invoice` with a readable target: step-up `ALWAYS_NEEDS_APPROVAL`, `expires_at` 15 minutes after the decision.
  - `pay_order` and `create_payout`: deny `NO_MATCHING_RULE` (the support agent can never pay out).
  - A dispute or invoice that can't be read: deny `TARGET_UNKNOWN`.
- `decide()` turns an allow for any action the gate can't execute (every action but a refund, in this phase) into a deny `ACTION_UNAVAILABLE`, keeping the intent, the trace and the matched rules. So the `decide` CLI, the propose CLI and MCP all show it, and nothing is sent. The list of executable actions lives in the gate, beside the executors.
- Replays (ADR 0026) apply to refunds only. A repeated step-up or deny for another action is decided and recorded again.

### Reason codes

Two codes join the catalog, phase 3's rules for words and hints applying:

| Code | Raised when | Words for the merchant | Safe reply hint |
|---|---|---|---|
| `TARGET_UNKNOWN` | The record an action targets can't be read, or holds an unsupported currency | There's no record of what this action targets. | We couldn't find the record for this request. Tell them we'll follow up. |
| `ACTION_UNAVAILABLE` | The mandate allows an action the gate can't carry out yet | Countersign can't carry out this action yet. | We can't do that automatically. Tell them the team will look at it. |

Neither is a rule reason. The "every code is reached" test covers both.

### Tickets (ADR 0029)

- `@countersign/db` gains a `tickets` table: ID, channel (`email` or `chat`), sender email (nullable), sender phone (nullable), subject (nullable), body, attachments (ID and content type each), received time (shared timestamp rule), and a simulated flag. A migration adds it. It isn't append-only and isn't hashed.
- A writer inserts a ticket. The same ID with the same contents is a no-op; with different contents it's refused with a typed error, never overwritten. A reader returns a ticket by ID, or none.
- The gate reads the ticket named by `justification.ticket_id` with the other live reads and maps it to a `TicketSnapshot` (call `ticket`, the ticket ID, sender email, attachments). No ticket ID, an unknown ID or a failed read leaves the snapshot out; a failed read adds a read problem. The gate never writes a ticket.
- `proposeRefund`'s caller-supplied ticket is removed. The propose CLI writes each proposal file ticket to the store first (simulated), resolving `payer`, `buyer:A` and `buyer:B` as it does now, then proposes.

### Read-only tools (ADR 0028)

- Each read-only tool calls `@countersign/rail-paypal` (or, for tracking status, the carrier mock) and returns the parsed record as `structuredContent` and JSON text. Money is shown as PayPal's `{ value, currency_code }`, converted from minor units with the rail client's `toPayPalAmount`.
- `get_shipment_tracking` returns the order's trackers and, for each tracking number, the carrier's status and scan events, with `"carrier": "simulated"` on every carrier field group.
- `list_disputes` without `disputed_transaction_id` lists the merchant's disputes (first page only, at most `page_size`, default 10); with it, phase 6's lookup by capture.
- `list_transactions` searches Transaction Search with the given range; a range over 31 days or with an unreadable date is refused before any call, with `isError: true`.
- A read that fails answers `isError: true` with the read problem's fixed one-line message (never PayPal's raw body). Reads need a principal key but aren't recorded.

### The stand-in agent CLI

- `npm run agent -- <proposal file> [--json] [--url <gate MCP URL>] [--pglite <dir>]` plays the agent until Resolve exists (phase 8). It writes each proposal's simulated ticket to the store (Resolve's job, labelled simulated), connects to the gate (default `http://127.0.0.1:8787/mcp`) with `COUNTERSIGN_SUPPORT_AGENT_KEY` through the MCP SDK's client, calls each proposal's tool, and prints each agent response in the propose CLI's style, or the responses as JSON with `--json`.
- The proposal file format is phase 6's, plus an optional `tool` per proposal (default `create_refund`). Only `create_refund` proposals name an `order` or `capture`; other tools carry their full `args`. A file's `principal` must be `support-agent`.
- Exit codes follow the propose CLI: 0 when every decision matched `expect`, 1 when one differed, 2 when it can't run (missing variable, unreadable file, the gate unreachable or answering 401). Missing variables are named, never shown.
- `apps/gate/proposals/guarded-actions.json` holds the demo: a `create_payout` and a `pay_order` on a seed order, both denied `NO_MATCHING_RULE`, and a `send_invoice` for an invoice that doesn't exist, denied `TARGET_UNKNOWN`. Its description says the tickets are simulated and the people illustrative.

## Constraints

- No AI anywhere in this phase. The existing no-AI test covers the gate's decide, propose and MCP modules.
- Fail closed: no key, no mandate, no record, no ticket or a failed read never leads to an allow. Only a matched allow rule with every requirement passing can allow, and only a refund can then execute.
- The agent never holds or sees a PayPal credential, access token or `DATABASE_URL`. No tool returns one, and no error message carries one.
- Validate every external input with zod 4: MCP arguments, the bearer header, the principal key variables, PayPal responses and the proposal file.
- Money is integer minor units everywhere inside the gate; PayPal's `{ value, currency_code }` exists only at the MCP boundary and inside the rail client.
- Display and wording follow the brand book and the CLI conventions in tech-stack.md: plain, short, no exclamation marks, pluralised counts.

## Technical needs

- The gate's MCP server is the low-level `Server` with `tools/list` and `tools/call` handlers (ADR 0028). Input JSON Schemas come from `z.toJSONSchema` of the normalization schemas, with the `justification` object included.
- `createApp` gains the MCP route, with its dependencies injected (database, rail factory, carrier, env, clock), like the webhook route. `server.ts` wires the real ones.
- New rail calls (ADR 0028): get dispute (`GET /v1/customer/disputes/{id}`: ID, status, amount, disputed capture IDs), get invoice (`GET /v2/invoicing/invoices/{id}`: ID, status, amount, invoice number, recipient emails), transaction search (`GET /v1/reporting/transactions`: transaction ID, status, amount, initiation time, one page). Each zod-parsed into minor units, each with recorded fixtures and contract tests, each a `PayPalError` on failure.
- The root `package.json` gains `"agent": "tsx --env-file-if-exists=.env.local apps/gate/src/agent-main.ts"`.
- `CONTEXT.md` already has this phase's terms (principal key, Countersign extension, target, ticket). The README gains a section on connecting an agent.
