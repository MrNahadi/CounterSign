# Countersign

Countersign is a money firewall for merchant AI agents. Agents propose money actions, and a deterministic gate allows, steps up or denies each one using rail records and the merchant's signed mandate, never the words in a message. Decisions are recorded in `docs/adr/`.

## Language

### Parties

**Merchant**:
The business that owns the rails, signs the mandate and approves step-ups. In the demo this is Kikapu Studio.
_Avoid_: owner, seller, shop

**Principal**:
An agent identity that may propose money actions, such as support-agent or ops-agent. Each principal has exactly one mandate.
_Avoid_: bot, user, client

**Customer**:
A person who contacts the merchant through Resolve. What they say is untrusted.
_Avoid_: user, buyer

**Payer**:
The person who paid for an order, as the rail's records say. It may or may not be the customer writing in.
_Avoid_: buyer, customer (when you mean the person on the payment record)

**Sender**:
The email address or phone number a ticket came from.
_Avoid_: author, requester

### Money actions and decisions

**Rail**:
A payment system Countersign can act on: PayPal or M-Pesa.
_Avoid_: provider, processor, channel

**Guarded action**:
A kind of action that moves money or releases goods, such as a refund, payout, dispute acceptance, invoice send, M-Pesa B2C, reversal or mark-paid. It always goes through the gate.
_Avoid_: money tool, write action

**Read-only action**:
A kind of action that only reads rail data. It passes straight through the gate.
_Avoid_: pass-through tool, safe action

**Intent**:
One normalized proposal of a guarded action: rail, action, amount, currency, target and ticket. Its hash identifies it exactly.
_Avoid_: request, proposal (as a noun for the stored thing), transaction

**Proposal**:
The agent's request to run one tool: the tool name, its PayPal-shaped arguments, and a justification naming the ticket and the claim. The gate normalizes it into an intent, or denies it.
_Avoid_: tool call, request

**Intent hash**:
SHA-256 over the canonical JSON of what would execute: the principal, rail, action, amount, currency, capture and ticket. The order isn't hashed. The decision record keeps the exact JSON it covers. An approval is bound to it.
_Avoid_: fingerprint, checksum

**Decision**:
The gate's result for an intent: allow, step-up or deny.
_Avoid_: verdict, outcome, ruling

**Reason code**:
A stable code naming why a decision came out as it did, such as `TICKET_NOT_FROM_PAYER`.
_Avoid_: error code, flag

**Decision record**:
Everything behind one decision: the intent and its hash, the mandate version and its hash, the verifier trace, today's usage, the matched rules, the reasons and the decision time.
_Avoid_: decision log, result object

**Safe reply hint**:
A suggestion returned with a denial, telling the agent what it can safely say to the customer.
_Avoid_: canned response

**Agent response**:
What the agent gets back for one proposal: allowed, pending approval or denied, with the reasons, and for a denial a safe reply hint.
_Avoid_: result, reply

**Execution**:
The rail call that carries out an allowed or approved intent, made at most once per intent.
_Avoid_: payment, transaction

**Execution request**:
The `execution.requested` audit-log entry written with an allow, in the same transaction, before the rail call is made. A request counts as executed unless its result says failed.
_Avoid_: pending refund, attempt

**Execution outcome**:
What the rail call's `execution.result` entry records: executed (the refund is completed or pending), failed (PayPal refused it or it failed), or unknown (no definite answer, so money may have moved).
_Avoid_: status, success

**Replay**:
A proposal whose intent was already requested. It isn't decided again: an executed intent gets the same answer and no rail call, and any other is re-sent with the same request ID within 6 hours.
_Avoid_: retry, duplicate

**Unmatched refund**:
A refund reconciled from PayPal that no execution result names, so Countersign didn't make it. Its reconciliation entry has no intent.
_Avoid_: orphan refund, unknown refund

**Reconciliation**:
Matching an execution to the webhook or callback that confirms it.
_Avoid_: sync, settlement

### Records and verification

**Record**:
Data held by a rail, the carrier or the audit log, such as a capture, tracker, dispute or receipt. Records are the only input an allow can rest on.
_Avoid_: evidence (except in disputes), source data

**Record snapshot**:
The fields a verifier needs from one record, with the call it came from and the record's ID.
_Avoid_: mock, fixture (for the snapshot itself), raw response

**Today's usage**:
The count and total of a principal's executed money actions in each currency, on today's date in the mandate's time zone. Limits are checked against it.
_Avoid_: spend, daily total

**Claim**:
What a customer asserts about an order, such as not received or damaged. A claim selects which rule applies but never proves anything.
_Avoid_: complaint, reason

**Verifier**:
A check that derives one fact from records. Its result is pass, fail or unknown.
_Avoid_: validator, check, guard

**Fact**:
A statement about an order, payment or receipt that a verifier derived from records.
_Avoid_: signal, attribute

**Verifier trace**:
The list of verifiers run for an intent, each with its result and the record it read.
_Avoid_: log, debug output

**Claims vs records**:
The two-column view of a decision: what the message claims beside what the records say.
_Avoid_: comparison view

**Shipment status**:
The carrier's state for an order's tracking number: lost, stalled for 10+ days, in transit or delivered. The carrier mock stores it; it's never worked out from the clock.
_Avoid_: delivery state, tracking status

**Tracker**:
PayPal's record, on an order, that one capture shipped under a tracking number. Its ID is the capture ID, a hyphen and the tracking number. Its own status is only shipped or cancelled.
_Avoid_: shipment (that's the carrier's record), tracking

### Mandate

**Mandate**:
A merchant's signed, versioned set of rules for one principal. What no rule allows is denied.
_Avoid_: policy, ruleset, config

**Rule**:
One entry in a mandate. It names an action, the facts it applies to, the facts it requires, an optional amount cap, and a decision.
_Avoid_: policy line, condition

**Limit**:
A daily total or count, per currency, that escalates any further intent to step-up once reached.
_Avoid_: quota, budget

**Fallback**:
The mandate's decision when no rule matches. It is always deny in this project.
_Avoid_: default rule

**Mandate version**:
One immutable, signed state of a mandate. Signing creates the next version.
_Avoid_: revision, draft (a draft is unsigned and decides nothing)

**Mandate compiler**:
The step that turns plain-English rules into a mandate draft and reads it back in plain English. It never takes part in a decision.
_Avoid_: rule parser, policy generator

### Approvals and the audit log

**Step-up**:
The decision that holds an intent until the merchant approves or denies exactly that intent.
_Avoid_: hold, escalation, manual review

**Approval**:
The merchant's answer to one step-up. It is single-use, bound to the intent's hash, and expires as a deny.
_Avoid_: confirmation, sign-off

**Audit log**:
The append-only, hash-chained record of every intent, decision, approval, execution and reconciliation.
_Avoid_: ledger, history, event log

**Audit-log entry**:
One row of the audit log: its sequence number, entry type, ref, time, payload, and the hashes that chain it to the entry before it.
_Avoid_: log line, record (reserved for rail, carrier and audit-log data a verifier reads)

**Entry type**:
The kind of an audit-log entry, such as `mandate.version` or `decision`. The ledger never appends a type it doesn't know.
_Avoid_: event type, kind

**Genesis hash**:
The fixed previous hash of the first audit-log entry: 64 zeros.
_Avoid_: root hash, seed

**Chain head**:
The last audit-log entry's sequence number and hash. `ledger verify` prints it, so it can be compared with a copy kept elsewhere.
_Avoid_: tip, latest hash

**Evidence pack**:
The facts drawn from the audit log and tracking to defend a dispute.
_Avoid_: dispute bundle

### M-Pesa rail

**Receipt**:
An M-Pesa transaction code for a payment to the merchant's shortcode, with its amount, time and payer fields.
_Avoid_: SMS, confirmation message, transaction ID

**Shortcode**:
The merchant's M-Pesa till or paybill number that receives payments.
_Avoid_: till ID, account number

**C2B payment**:
A customer-to-merchant M-Pesa payment, stored as a receipt.
_Avoid_: incoming transfer

**B2C payment**:
A merchant-to-person M-Pesa payment, used here for overpayment refunds.
_Avoid_: payout (reserved for PayPal Payouts), M-Pesa refund

**Overpayment**:
The amount by which a verified receipt exceeds its order's total.
_Avoid_: excess, change

**Reversal**:
A request to undo an M-Pesa transaction. It always needs a step-up.
_Avoid_: chargeback, refund

### Evaluation

**Bench**:
The fixed suite of attack cases and genuine cases used to measure Countersign against the baseline.
_Avoid_: test suite, evals

**Attack case**:
A bench ticket where no money should move without authorization.
_Avoid_: adversarial test, red-team prompt

**Genuine case**:
A bench ticket that deserves a correct resolution.
_Avoid_: happy path, benign case

**Case family**:
A named kind of attack (A1–A12) or genuine situation that groups bench cases.
_Avoid_: category, scenario type

**Decision case**:
A case file holding a moment, a mandate, record snapshots and proposals, each with the decision expected of it, written before it's run. `npm run decide` runs one.
_Avoid_: test case, scenario

**Hold-out slice**:
Bench cases written without sight of the mandate or gate, committed unread and run once at the final bench.
_Avoid_: test set, blind set

**Baseline mode**:
Resolve's agent wired straight to PayPal's tools with no gate, used only for comparison in sandbox.
_Avoid_: unprotected mode, control

**Protected mode**:
Resolve's agent acting on money only through Countersign.
_Avoid_: safe mode, guarded mode

### Demo

**Resolve**:
The reference AI support inbox for the merchant, where customers write in by email or simulated chat.
_Avoid_: support bot, helpdesk

**Kikapu Studio**:
The illustrative demo merchant, a Kisumu basket and bag maker.
_Avoid_: the shop, the store (when you mean the merchant)

**Storefront**:
The demo shop page that creates real sandbox orders for Kikapu Studio.
_Avoid_: checkout app

**Seed state**:
The known starting data (orders, trackers, receipts, tickets) that a demo reset restores.
_Avoid_: fixtures (reserved for tests), sample data

**Seed catalog**:
The fixed list of 30 demo orders (`KIK-1013` to `KIK-1042`): each one's product, seed buyer, shipment status, scan events and demo role.
_Avoid_: seed data, fixtures

**Seed run**:
One run of the seed script, named by its run ID. It creates the seed catalog's orders as real sandbox orders, and rerunning it with the same ID resumes it rather than repeating it.
_Avoid_: seeding job, import

**Seed buyer**:
One of the two vaulted sandbox buyer accounts (A and B) that pay for seeded orders. Two exist so that a ticket can come from someone other than an order's payer.
_Avoid_: test user, customer

**Visitor attack**:
A message a hosted-demo visitor writes in "Attack it yourself" to try to make money move.
_Avoid_: user attack, judge test

**Risk desk**:
The merchant's dashboard of decisions, money protected, chain status and refund spikes, with an analyst agent.
_Avoid_: analytics page, admin dashboard
