# 0027. Each guarded PayPal action hashes its own target and the parameters that execute; only refunds need a ticket; a missing target record denies `TARGET_UNKNOWN`

Status: accepted, amends ADRs 0019 and 0020 (the intent target and hash) for actions other than a refund
Decided-by: autopilot (delegated), phase 7 feature spec, 18 Oct 2026, under brief §14 v1.4. The answerer's rules escalate it, because the intent hash is a stored format that binds approvals and idempotency, which is expensive to reverse. The planner session couldn't reach the answerer agent, so it applied the answerer's rules itself. Decided by brief §10 trade-off 1 (fail-closed money safety), then 5 (PayPal depth). The owner can overturn it (`.ralph/human.md`, Decided for you)
Question: Phase 7 decides every guarded PayPal action, not just refunds. The intent's target is a capture and its hash covers the capture alone. What is the target of a dispute action, an invoice send, an order capture and a payout? What does the hash cover when a note, an offer type or a list of recipients changes what executes? Where does the amount come from when the agent doesn't state one, and does every action need a ticket?
Decision:
- **One target per action**, and the hash covers only the ID that executes:

  | Action | MCP tool | Target (hashed) | Amount | Hashed parameters |
  |---|---|---|---|---|
  | `paypal.refund` | `create_refund` | capture | the agent's, or what's left on the capture | none (unchanged) |
  | `paypal.dispute.accept_claim` | `accept_dispute_claim` | dispute | the dispute's amount, from get dispute | `note` |
  | `paypal.dispute.provide_evidence` | `provide_dispute_evidence` (extension) | dispute | the dispute's amount | the evidence list (type, notes, tracking numbers) |
  | `paypal.dispute.make_offer` | `make_offer` (extension) | dispute | the offer amount the agent states, or the dispute's amount for `REPLACEMENT_WITHOUT_REFUND` | `offer_type`, `note` |
  | `paypal.invoice.send` | `send_invoice` | invoice | the invoice's amount, from get invoice | `note`, `send_to_recipient`, `additional_recipients` |
  | `paypal.order.capture` | `pay_order` | order | the order's amount, from get order | none |
  | `paypal.payout` | `create_payout` (extension) | payee email | the agent's | `note` |

- **A refund's hashed JSON is byte-for-byte what ADR 0020 says**: `{ principal, rail, action, amount, currency, target: { captureId }, ticketId }`. Every other action adds a `params` object of its hashed parameters, in their normalized form (absent optional values as `null`, recipient lists as given). So every refund already in an audit log keeps its intent ID and request ID.
- **Only refunds need a ticket.** A refund without `ticket_id` is `INVALID_PROPOSAL`, as before. Dispute actions arrive from webhooks (phase 11) and payouts from the ops agent (phase 12), so for them the ticket ID is optional and hashed as `null` when absent.
- **A target's record decides the amount** wherever the agent doesn't state it. If that record can't be read (not found, or the read failed), the proposal is denied with a new code, `TARGET_UNKNOWN` ("There's no record of what this action targets."), never given a guessed amount. A refund with no amount and no capture record stays `INVALID_PROPOSAL`, as phase 3 specified.
- **A record whose currency the gate can't hold** (anything but USD and KES) is `TARGET_UNKNOWN` too.
- **Verifiers read the target they need.** The capture-based verifiers (`capture.refundable`, `ticket.from_payer`, `dispute.none_open`, `shipment.status`, `ledger.not_duplicate`) are `unknown` for an intent whose target isn't a capture. A refund still runs every refund verifier; other actions run only the verifiers their rules require.
Basis:
- Brief §8: "What you approve is what executes: an approval is single-use and bound to the hash of the exact intent." A note sent to a customer or an offer type is part of what executes, so it must be inside the hash.
- Brief §6 step 2 ("Normalize into an intent: rail, action, amount, currency, target, ticket") and §5 item 1 (the guarded actions).
- Original brief §9 (each action's upstream call) and §12 (`sender_batch_id` = intent ID for payouts).
- ADR 0020: the refund hash target is the capture, because the refund executes on it.
- PayPal's Agent Toolkit 1.11.0 tool parameters: `accept_dispute_claim { dispute_id, note }`, `send_invoice { invoice_id, note, send_to_recipient, additional_recipients }`, `pay_order { id }`, `create_refund { capture_id, amount, invoice_id, note_to_payer }` (from `@paypal/agent-toolkit/mcp` in `node_modules`).
- PayPal Customer Disputes v1 (`dispute_amount`, `make-offer` `offer_type` values) and Invoicing v2 (`amount` on show invoice): https://developer.paypal.com/docs/api/customer-disputes/v1/ and https://developer.paypal.com/docs/api/invoicing/v2/
Consequences:
- `TARGET_UNKNOWN` joins the reason-code catalog with words and a reply hint, and the "every code is reached" test covers it.
- Phase 9 binds approvals to these hashes, so an approved invoice send can't go out with a different note. Phase 11 may add evidence documents to `provide_dispute_evidence`'s parameters; that's a new parameter, hashed, and changes no refund.
- A refund's `note_to_payer` and `invoice_id` still aren't sent or hashed (phase 6 behaviour).
