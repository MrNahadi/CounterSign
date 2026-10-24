# Phase 12 requirements: ops-agent supplier payouts

Brief §5 item 15, §8 (fail closed; what you approve is what executes; the agent never holds PayPal credentials; no AI in the decision path; every number real and simulation labelled; Graphite), §9 (direct REST so we control `PayPal-Request-Id`). Decisions: ADR 0039, applying 0019, 0025 to 0028 and 0032 to 0034. Design baseline: original brief §7 (rule 6 and the separate ops mandate), §8 (`payee.allowlisted`), §9 (`paypal.payout`), §12 (`sender_batch_id` = intent ID; separate mandates). Where this file and the brief disagree, the brief wins.

## Behaviour

### The mandate (`@countersign/mandate`)

- **Payee list.** `MandateSchema` gains an optional `payees: [{ email, name }]`: at most 100 entries; `email` a valid email already lower-cased and trimmed; `name` 1 to 100 characters; no email twice (an issue at the repeated entry). A mandate without `payees` parses and hashes exactly as before; the kikapu-studio v3 fixture's hash is unchanged.
- **Reason codes.** `PAYEE_NOT_ALLOWLISTED` — words "The payee isn't on your list of suppliers.", hint "We can only pay suppliers on the merchant's list. Ask the team to add them first." `PAYEE_LIST_UNKNOWN` — words "Countersign couldn't read your list of suppliers.", hint "We need to check this payment before sending it. The team will follow up." The evaluator maps `payee.allowlisted` to them (fail / unknown).
- **Reference.** `IntentParams` gains `reference`. A payout hashes `note` (as now) and `reference` only when set, so a payout intent without one keeps its hash.
- **The ops mandate**, `packages/mandate/fixtures/kikapu-studio-ops-v1.json`: `id` `kikapu-studio-ops`, version 1, principal `ops-agent`, time zone `Africa/Nairobi`, fallback `deny`, limits `[{ currency: USD, per_day_total: 50000, per_day_count: 5 }]`, payees "Nyanza Sisal Collective (illustrative)" `sisal.collective@example.com` and "Kisumu Dye Works (illustrative)" `dyeworks@example.com`, and one rule: `{ id: payout-listed-supplier, action: paypal.payout, require: [payee.allowlisted], decide: step_up, reason: ALWAYS_NEEDS_APPROVAL }`.

### The verifier (`@countersign/verifiers`)

- `RecordSnapshots` gains `payees?: PayeeListSnapshot` (`{ call, id, payees: [{ email, name }] }`); `CALLS.payees` is `mandate payees`.
- `payee.allowlisted`, pure: unknown "Not a payout" for an intent whose target isn't a payee; unknown "No payee list" when the snapshot is absent; pass "<name> (<email>) is on payee list <id>" when the normalized email is listed; fail "<email> isn't on payee list <id>" otherwise. Its trace entry reads the snapshot (or names the call it looked for). It runs only when a rule requires it.

### The gate's decisions

- **Principals.** `ops-agent` joins `support-agent`: key `COUNTERSIGN_OPS_AGENT_KEY` (32+ characters), mandate the ops fixture. Each key authenticates only its own principal and mandate. Two principal variables with the same value both count as unset (named in the startup line, values never shown). A mandate file that doesn't load leaves only its own principal refused; the startup line names which. The approver key must differ from both principal keys. `Principals.mandates` holds every mandate that loaded.
- **`create_payout`** (extension): arguments `{ receiver, amount, reference, note? }` plus `justification`. `reference` is required: 1 to 63 characters, `^[A-Za-z0-9][A-Za-z0-9._/-]*$`. `amount` must be USD; any other currency is `INVALID_PROPOSAL` ("Payouts are paid in USD only"). The intent: target the payee email (lower-cased, trimmed), amount the agent's, params `{ note, reference }`, ticket ID null unless a justification names one. The MCP description becomes "Pay a supplier on the merchant's list by PayPal email, for one bill (reference)."
- **The payee snapshot.** `decide()` sets `records.payees` from the deciding mandate's `payees` (absent when the mandate has none), replacing any `payees` the records already held. The call is `mandate payees`, the ID `<mandate id> v<version>`.
- **Outcomes**, all recorded in the audit log as now:
  - ops agent, listed payee → `step_up` `ALWAYS_NEEDS_APPROVAL`, the agent gets `pending_approval`;
  - ops agent, unlisted payee → `deny` `PAYEE_NOT_ALLOWLISTED`;
  - ops agent, any other guarded tool → `deny` `NO_MATCHING_RULE`;
  - support agent, `create_payout` → `deny` `NO_MATCHING_RULE`, as before.
- **A decision case**, `apps/gate/fixtures/cases/ops-payouts.json`, runs with `npm run decide` under the ops mandate and expects the three ops outcomes above.

### The agent CLI

- `npm run agent -- <file>` proposes as the file's `principal`: `support-agent` with `COUNTERSIGN_SUPPORT_AGENT_KEY`, `ops-agent` with `COUNTERSIGN_OPS_AGENT_KEY`; any other principal can't run (exit 2, named). A 401 names the variable it used. Proposals without a ticket write no ticket.
- `apps/gate/proposals/ops-payouts.json` (principal `ops-agent`, the ops mandate): a $45.00 payout to Kisumu Dye Works for `KDW-2026-0412` (expect `step_up` `ALWAYS_NEEDS_APPROVAL`), a payout to `refunds.desk@example.com` (expect `deny` `PAYEE_NOT_ALLOWLISTED`), and a KES payout (expect `deny` `INVALID_PROPOSAL`). `guarded-actions.json`'s payout gains a reference and still expects `NO_MATCHING_RULE`.

### The rail client (`@countersign/rail-paypal`)

- **Create payout:** `POST /v1/payments/payouts` with `PayPal-Request-Id` (required input), body `{ sender_batch_header: { sender_batch_id, recipient_type: "EMAIL", email_subject }, items: [{ recipient_type: "EMAIL", amount: { value, currency }, receiver, note?, sender_item_id }] }`. Input checked with zod first: USD only, amount 1 minor unit or more, receiver an email, note 1 to 4000 characters, `sender_item_id` as the reference rule, `sender_batch_id` 1 to 256 characters. Amounts converted from minor units only here. Answers `{ batchId, batchStatus }` from a 201. Retries only as other POSTs with a request ID do.
- **Get payout batch:** `GET /v1/payments/payouts/{id}` → `{ batchId, batchStatus, senderBatchId, items: [{ itemId, status, amount, receiver, senderItemId, errorName }] }`.
- **Get payout item:** `GET /v1/payments/payouts-item/{id}` → `{ itemId, batchId, senderBatchId, status, amount, receiver, senderItemId, errorName, timeProcessed }`.
- Statuses are kept as text, unknown values included. Amounts are minor units; a currency the client can't hold is a read error.
- `PayPalError` gains a way to tell a reused-batch refusal: `isDuplicateBatch(error)` is true for a 4xx whose name or any issue contains `DUPLICATE` or `SENDER_BATCH_ID`.

### The payout executor (gate)

- `EXECUTABLE_ACTIONS` gains `paypal.payout`; order capture stays `ACTION_UNAVAILABLE`. The executor serves both an allow and an approval.
- It sends exactly the stored intent: request ID the intent hash, `sender_batch_id` the intent ID, receiver the target email, the amount, the note when set, `sender_item_id` the reference, and the fixed subject "You have a payment from Kikapu Studio (illustrative)" (exported as a constant).
- The gate sends it once: approving again, or proposing the same intent again, sends nothing (as invoice sends). `execution.requested` carries the intent hash as its request ID.
- After a 201 it reads the batch once and records the first item. Outcomes: batch `PENDING`, `PROCESSING`, `SUCCESS` or `NEW` → `executed`; `DENIED` or `CANCELED` → `failed`; any other batch status → `unknown`; a 4xx → `failed`, except a duplicate-batch refusal → `unknown`; anything else → `unknown`.
- `execution.result` gains a payout form: `payout: { batchId, batchStatus, item: { id, status } | null }` (item null when the batch read fails or names no item), allowed on `executed`, `failed` (with or without `error`) and `unknown`. Every older entry still reads.
- Executed payouts count in the ops agent's today's usage. The approve answer's `execution` carries `payout` (or null).

### Reconciliation (gate)

- `reconciliation` gains a payout form: `{ source: "poll" | "webhook", event? (webhook), payout: { batchId, itemId, status, amount }, resultSeq }`, ref the intent ID (from the item's `sender_batch_id` when it's a known intent, else null). Every older entry still reads.
- Final item statuses: `SUCCESS`, `FAILED`, `RETURNED`, `REFUNDED`, `REVERSED`, `BLOCKED`, `DENIED`, `CANCELED`. Others (`PENDING`, `UNCLAIMED`, `ONHOLD`, `NEW`) are open.
- **`npm run reconcile`** also re-reads every executed payout whose latest known item status (from its result or its latest reconciliation) is open or missing, and logs a reconciliation when the status differs. It prints one line each ("Payout int_… to dyeworks@example.com: UNCLAIMED, waiting for the payee to claim it." / "… SUCCESS."). A payout still open at PayPal doesn't change the exit code; a read that fails is listed and makes it exit 1, as a refund read does. "No refunds to reconcile." becomes "Nothing to reconcile." only when there are neither refunds nor payouts.
- **The webhook** handles any `PAYMENT.PAYOUTS-ITEM.*` event after the signature check: it reads `resource.payout_item_id` (zod), re-reads the item, and logs one reconciliation per event ID ("Reconciled." / "Already reconciled."). An item whose batch is no payout of Countersign's is logged with a null ref and no result. An item that can't be re-read, or a log that can't be read or written, answers 503. `PAYMENT.PAYOUTSBATCH.*` answers 200 "Event type not handled." Refund and dispute handling is unchanged.

### Approval cards and the audit reader

- A payout card's `params`: `{ kind: "payout", reference, note, payee_name }`, where `payee_name` comes from the deciding mandate's list (null when not listed). The card's `can_execute` is true for a payout.
- Entry summaries: a payout result "Paid out $45.00 to dyeworks@example.com (batch <id>, item <status>)." / "PayPal refused the payout: <name>." / "PayPal denied the payout batch <id>."; a payout reconciliation "Payout to dyeworks@example.com is now <status>." Decision rows for payouts show the payee as target and "Payout sent" as executed status words. A payout intent's trail includes its request, result and reconciliations.
- `payee.allowlisted` in claims vs records reads "Payee is on your list" with the source "Your mandate's payee list".

### The console

Every screen follows `Graphite Design/DESIGN.md` and the brand book, semantic tokens only, Lucide icons, no emojis, light and dark, desktop and phone widths.

- **The approval card** for a payout shows "What you're approving": Payee (name, and the email in mono), Amount, Bill reference (mono), Note (or "No note"). Copy: "Approving sends exactly this payout through PayPal. Nothing is sent until you approve." The approve answer reads "Approved. Payout sent, batch <id> (<item status words>)." The 40px approve and deny buttons stay at the bottom.
- **Decisions and a decision's page** read payout results and reconciliations: status "Payout sent", the result line with batch and item status, reconciliation lines with the new status. Item status words: `UNCLAIMED` "Waiting for the payee to claim it", `SUCCESS` "Paid", `PENDING` "Pending", `RETURNED` "Returned to you", `FAILED` "Failed", others as PayPal's code.
- Console schemas (`approval-schemas.ts`, `audit-schemas.ts`) accept the new fields; older answers still parse.

## Constraints

- No AI in the gate, `packages/mandate`, `packages/verifiers` or `packages/ledger`; the existing no-AI test covers them. The ops agent adds no AI.
- Fail closed: no payee list, a list that can't be read, an unlisted payee or a non-payout target never allows; a payout is never sent twice by the gate; an unclear PayPal answer is `unknown`, never `failed`.
- The payee list comes only from the signed mandate that decides; nothing the agent sends can add a payee.
- The agent never holds a PayPal credential; the ops key never works on the approval or audit API, and the approver key never on `/mcp`.
- Every external input is read with zod 4: MCP arguments, PayPal payout answers, webhook events, the console's gate answers.
- Money is integer minor units; converted to PayPal's strings only inside `@countersign/rail-paypal`.
- Every illustrative supplier is labelled illustrative. Copy follows the brand book: plain, short, no exclamation marks, pluralised counts.
- Never log, store or show a secret.

## Technical needs

- No new dependencies.
- New env: `COUNTERSIGN_OPS_AGENT_KEY` (gate and the agent CLI). `PAYPAL_LIVE_PAYEE_EMAIL` (optional) names a sandbox personal account for the live payout check.
- Live checks run only under `LIVE=1`, never in the Feedback commands: in `packages/rail-paypal`, a $1.00 payout created, its replay with the same request ID answering the same batch, a second create with the same `sender_batch_id` and a new request ID refused as a duplicate, and the batch and item read back; in `apps/gate/test/payouts-live.test.ts`, the ops agent's payout over a listening gate stepped up, approved and executed once, then reconciled.
