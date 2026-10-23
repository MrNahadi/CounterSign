# Phase 11 requirements: dispute evidence

Brief §5 item 13, §6 beat 7, §8 (no AI in the decision path; fail closed; credential custody; what you approve is what executes; every number real and simulation labelled; Graphite), §13 spike S3 and §5's S3 cut line. Decisions: ADR 0035, applying 0025, 0027, 0028, 0030 to 0034 and 0013 to 0017. Design baseline: original brief §9 (dispute actions always step up; "the merchant reviews the evidence pack"), §13 (evidence drafting) and §14 (disputes and dispute webhooks). Where this file and the brief disagree, the brief wins.

## Behaviour

### The rail client (`@countersign/rail-paypal`)

- **Get dispute** also returns `reason`, `lifeCycleStage`, `sellerResponseDueDate` (or null), the disputed capture IDs (as now) and the names of the HATEOAS links PayPal offers (such as `provide_evidence`, `accept_claim`, `make_offer`, `require_evidence`, `adjudicate`). Unknown values are kept as text.
- **Accept claim:** `POST /v1/customer/disputes/{id}/accept-claim` with `{ note }`.
- **Make offer:** `POST /v1/customer/disputes/{id}/make-offer` with `{ note, offer_type, offer_amount? }` (amount converted from minor units only here).
- **Provide evidence:** `POST /v1/customer/disputes/{id}/provide-evidence` as `multipart/form-data`: a part named `input` (`application/json`) holding `{ evidences: [{ evidence_type, evidence_info?: { tracking_info?: [{ carrier_name, carrier_name_other?, tracking_number }], refund_ids?: [...] }, notes }] }`, and one part per document (`file1`, `file2`, …) with its file name and content type. Documents are PDF bytes, each under 1 MB, at most 5, with names matching PayPal's pattern.
- **Require evidence** (sandbox only): `POST …/require-evidence` with `action` `SELLER_EVIDENCE` or `BUYER_EVIDENCE`. **Adjudicate** (sandbox only): `POST …/adjudicate` with `adjudication_outcome` `SELLER_FAVOR` or `BUYER_FAVOR`.
- None of these send a `PayPal-Request-Id` and none is ever retried (ADR 0035). Each answers PayPal's status, or throws a `PayPalError` as the other calls do. Inputs are checked with zod before anything is sent.

### Dispute intake (gate, ADR 0035)

- **Webhook.** `POST /webhooks/paypal` now also handles `CUSTOMER.DISPUTE.CREATED`: after the same signature check over the raw body, it reads `resource.dispute_id` (zod), re-reads the dispute with get dispute, and appends one `dispute.received` entry: `{ disputeId, source: "webhook", event: { id, type }, dispute: { status, reason, lifeCycleStage, amount, sellerResponseDueDate, captureIds } }`, `refId` the dispute ID. A redelivered event ID writes nothing and answers 200 "Already recorded." `CUSTOMER.DISPUTE.UPDATED` and `.RESOLVED` answer 200 "Event type not handled." A dispute that can't be re-read, or a log that can't be read or written, answers 503 so PayPal redelivers. The refund handling is unchanged.
- **Polling.** `npm run disputes -- sync` reads the first page of the merchant's disputes in `WAITING_FOR_SELLER_RESPONSE` (up to 50), and for each dispute ID with no `dispute.received` entry yet, re-reads it and appends `dispute.received` with `source: "poll"` and `event: null`. It prints one line per dispute ("Recorded dispute PP-D-123 on capture 9AB… for $240.00." or "Already recorded PP-D-123.") and says when PayPal had more pages.
- **The nudge.** After each new `dispute.received` entry, the gate sends `POST <RESOLVE_AGENT_URL>/disputes` with `{ dispute_id }`, at most 2 seconds, and ignores the outcome; the webhook's answer and the CLI's exit code never depend on it. The CLI prints "Resolve wasn't reachable; run npm run resolve -- dispute <id>." when it fails.
- **Other `disputes` commands:** `list` (the merchant's disputes, one line each: ID, status, reason, amount, due date, whether it's recorded), `show <id>` (the dispute as re-read and its `dispute.received` entry `seq`), `require-evidence <id> [--buyer]` and `adjudicate <id> --favor seller|buyer`, both labelled sandbox-only in their output and usage. Exit codes follow the CLI convention (0, 1 for a negative result such as a 4xx refusal, 2 when it can't run).

### Evidence facts and documents (gate, ADR 0035)

- **Facts**, built without AI from records for one dispute:
  - the dispute: ID, status, reason (and words), life-cycle stage, amount, seller response due date;
  - the disputed capture (the first capture ID the dispute names that the merchant holds): ID, amount, status, time; the order's number when seeded (`seed_orders`), never the payer's email;
  - the order's trackers for that capture (tracking number, carrier name) and, for each, the carrier mock's shipment status and scan events, every one labelled "Carrier (simulated)";
  - the capture's refunds (ID, amount, status, and PayPal's own time for each, null when PayPal gave none);
  - Countersign's decisions on the capture, oldest first: time, action words, amount, decision, reason codes, and the claim words; never the ticket's sender or text;
  - the capture-scoped evidence export (ADR 0034): its entry count, chain verdict and head.
  - A record that can't be read is listed as "Not available: <call>" and the facts say so; the pack is still built. A dispute that can't be read, or names no capture, isn't built (`DISPUTE_UNREADABLE` / `NO_CAPTURE`).
- **Documents.** Two rows in `evidence_documents` per build: the export file (`application/json`, `countersign-evidence-capture-<id>.json`) and the evidence PDF (`application/pdf`, `countersign-evidence-<dispute ID>.pdf`). Each row: ID (`doc_…`), dispute ID, kind (`export` or `pdf`), name, content type, size, SHA-256 (hex) of the bytes, the bytes, created time. Never updated or deleted (a trigger rejects UPDATE and DELETE; TRUNCATE allowed for the demo reset, as for the audit log).
- **The PDF** (A4, Helvetica, at most 6 pages): title "Evidence for dispute <ID>", "Prepared by Countersign for Kikapu Studio (illustrative) from PayPal sandbox records on <date>.", then sections Dispute, Payment, Shipping (with "Carrier data is simulated in this demo."), Refunds, Countersign decisions, Audit log (entry count, chain intact or broken, head `#seq` and hash, the export's file name and SHA-256, and "Recompute it with npm run ledger -- check-export."). Text outside WinAnsi is replaced with "?". No AI text appears in the PDF.
- **Suggested evidence items**, by a fixed table over the facts:
  - a tracker with carrier status `delivered` → `PROOF_OF_FULFILLMENT` with its tracking numbers;
  - any refund with status `COMPLETED` → `PROOF_OF_REFUND` with those refund IDs;
  - otherwise → `OTHER`.
  - Every item gets the PDF as its document.

### `prepare_dispute_evidence` (MCP extension, ADR 0035)

- A Countersign extension tool for principal keys, input `{ dispute_id }` (zod, strict). It builds the facts and documents and answers `{ dispute, capture, order_number, shipping, refunds, decisions, audit, documents: [{ id, kind, name, size, sha256 }], suggested: [{ evidence_type, tracking_numbers, refund_ids }] }` in snake_case. It isn't a guarded tool and isn't decided or logged, but it never moves money and never answers a payer email, ticket text or credential.
- Errors are tool results with one fixed sentence: the dispute can't be read, names no capture, or the documents couldn't be stored.
- The tool list names it as an extension, with a one-line description.

### `provide_dispute_evidence` with documents

- Arguments gain `document_ids` (1 to 5 IDs) and each evidence item gains optional `refund_ids` (up to 20).
- Normalization reads every document from `evidence_documents`: one that's missing, isn't a PDF, or has another dispute ID makes the proposal `INVALID_PROPOSAL` with a detail naming it. A store that can't be read leaves the target unknown (`TARGET_UNKNOWN`).
- The hashed parameters are the evidence list (type, notes, tracking numbers, refund IDs, normalized as before) plus `documents: [{ id, name, sha256 }]` in the order given. Every existing intent hash (refunds, invoice sends, other dispute actions) is unchanged.

### Dispute executors (ADR 0035)

- `EXECUTABLE_ACTIONS` gains `paypal.dispute.accept_claim`, `paypal.dispute.make_offer` and `paypal.dispute.provide_evidence`, each with an executor used by both an allow and an approval. `ACTION_UNAVAILABLE` remains for payouts and order capture.
- Each sends exactly what the stored intent's parameters say; provide evidence reads each document's bytes by ID and, if the SHA-256 differs from the hashed one or the row is gone, records `failed` with the error name `DOCUMENT_CHANGED` and sends nothing.
- Each is sent once, with no request ID, never retried or re-sent; a later proposal of the same intent can't execute again, as for invoice sends. A 2xx is `executed`, a 4xx `failed`, anything else `unknown`.
- `execution.result` holds `dispute: { id, status }`, the status from a get dispute after the call, or null if that read fails. Reconciliation ignores these results.
- Executed dispute actions count in today's usage (the dispute's amount, or the offer's).

### Resolve's dispute drafts (ADR 0035)

- **`POST /disputes { dispute_id }`** (zod, strict): queues one dispute draft. If a draft for that dispute exists and isn't `failed`, it answers it (200) and queues nothing; otherwise 202 with the new draft. Drafts share the run queue (one at a time) and the daily run cap with message runs; over the cap, the draft is stored `not_run` with outcome `daily_cap`.
- **`GET /disputes`**: drafts newest first (dispute ID, status, outcome, `drafted_by`, model and model versions, the proposal's agent response status and intent ID, times). **`GET /disputes/:id`**: one draft with its facts summary, notes and agent response.
- **The draft run**, in protected mode only (it has no baseline):
  1. call `prepare_dispute_evidence` over MCP with the support agent's principal key;
  2. one Gemini call (`generateContent`, `GEMINI_MODEL`, `thinkingLevel: MEDIUM`, `responseMimeType: application/json`, `responseJsonSchema` from zod) with a byte-stable system instruction and the facts as JSON, asking for `{ summary, notes: [one per suggested item] }`, each note 1 to 2000 characters; the fail-closed response checks (ADR 0015) apply;
  3. if the call fails any check, the model isn't configured, or the JSON doesn't validate, the notes come from the template (below) and `drafted_by` is `template`; otherwise `drafted_by` is the model ID and `modelVersion` is recorded;
  4. propose `provide_dispute_evidence` with the suggested types, tracking numbers and refund IDs, the PDF's document ID, and the notes; store the agent response (expected `pending_approval`).
- **The template**, one note per item: fulfilment "Shipped with <carrier> under tracking <numbers>; the carrier shows it delivered on <date> (simulated carrier data). Records attached."; refund "Refunded <amount> on <date> (refund <IDs>). Records attached."; other "Order <number>, paid <amount> on <date>. Countersign's records for this payment are attached."
- Draft statuses: `queued`, `running`, `proposed` (with the agent response), `failed` (with an outcome such as `gate_unavailable`, `prepare_failed:<sentence>`, `proposal_rejected`), `not_run`. Interrupted drafts are marked failed, never rerun.
- `npm run resolve -- dispute <id>` queues and runs one draft from the CLI and prints its outcome, the notes and the agent response.

### Approval cards and the approval API

- Every card gains `params`, the parameters that execute, in words: an invoice send's note and recipients; accept claim's note; an offer's type, amount and note; an evidence submission's items (type words, notes, tracking numbers, refund IDs) and documents (name, size, SHA-256, document ID). A refund has none.
- `GET /approvals/documents/:id` (approver key, as the rest of the approval API) answers a stored document's bytes with its content type and `Content-Disposition: attachment`. A malformed ID is 400, an unknown one 404.
- An approved provide-evidence step-up executes through its executor; the approve answer carries `dispute: { id, status }`.

### Audit reader lines

- Entries: `dispute.received` summarises "PayPal opened dispute PP-D-123 on capture <id> for $240.00 (<reason words>)." A dispute result: "PayPal took the evidence for PP-D-123: <status>." / "Accepted the claim on PP-D-123." / "Sent an offer on PP-D-123." / "PayPal refused it: <name>."
- Decision rows for dispute actions show the dispute ID as the target and, when executed, "Evidence sent" / "Claim accepted" / "Offer sent" as status words in the console.
- The trail of a dispute intent includes its request, its result with the dispute and status, and its approval.

### The console

Every screen follows `Graphite Design/DESIGN.md` and the brand book, semantic tokens only, Lucide icons, no emojis, light and dark, desktop and phone widths.

- **The approval card** for a dispute action shows a "What you're approving" section from `params`. For evidence: each item as a row (type words, notes in full, tracking numbers and refund IDs in mono), and each document as a row with its name, size, a short SHA-256 (full value in a tooltip) and a "Download" link through a console route to `/approvals/documents/:id`. The 40px approve and deny buttons stay at the bottom. Copy: "Approving sends exactly this evidence to PayPal. Nothing is sent until you approve."
- **Disputes (`/disputes`)**, after Approvals in the sidebar (Lucide `ShieldAlert`): title "Disputes", subtitle "Disputes PayPal opened, and the evidence your agent drafted." A Graphite table: When, Dispute (ID mono, reason words), Amount, Draft (status words: "Drafting", "Waiting for you" linking to `/approvals`, "Couldn't draft: <outcome>", "Not run: daily limit"), Drafted by ("Gemini <model>" or "Template, no AI"), Decision (link to `/decisions/intent/<intent ID>` when there is one). A "Draft again" button on a failed draft calls the console route that posts to Resolve. An empty list says "No disputes yet. They appear here when PayPal opens one, or after npm run disputes -- sync." It needs the approvals sign-in like Decisions.
- **Server routes:** `GET /api/disputes`, `POST /api/disputes` (`{ dispute_id }`) to Resolve at `RESOLVE_AGENT_URL`; `GET /api/approvals/documents/[id]` to the gate. They validate requests and answers with zod and behave as the existing routes do for a missing sign-in, a 401 and an unreachable service.

## Constraints

- No AI in the gate, `packages/mandate`, `packages/verifiers` or `packages/ledger`; the existing no-AI test covers the gate too. The drafter's text never reaches a decision: the mandate steps every dispute action up, and the hash covers what the merchant sees.
- Fail closed: an unreadable dispute, document or store denies or fails, never guesses; a document whose bytes changed is never sent; a dispute action is never sent twice.
- The agent never holds a PayPal credential; `prepare_dispute_evidence` never answers a payer email, ticket text, token or key.
- Every external input is read with zod 4: webhook events, MCP arguments, CLI arguments, `POST /disputes`, the model's JSON, every gate and Resolve answer the console reads.
- Money is integer minor units; converted to PayPal's strings only inside `@countersign/rail-paypal`.
- Simulated carrier data is labelled in the facts, the PDF, the card and the template notes. The shop is labelled illustrative in the PDF.
- Never log, store or show a secret. Copy follows the brand book: plain, short, no exclamation marks, pluralised counts.

## Technical needs

- `pdf-lib` 1.17.1 in `apps/gate` (installed).
- New env for the gate: `RESOLVE_AGENT_URL` (default `http://127.0.0.1:8788`). The gate still reads `PAYPAL_WEBHOOK_ID` for the webhook (missing until phase 13).
- Root `package.json` gains `"disputes": "tsx --env-file-if-exists=.env.local apps/gate/src/disputes-main.ts"`.
- Migrations: `evidence_documents` (with its write-once trigger) and `dispute_drafts`.
- Live checks run only under `LIVE=1`, never in the Feedback commands: listing the merchant's disputes and reading one; with `PAYPAL_LIVE_DISPUTE_ID` set, require evidence, provide evidence with a built PDF through an approved step-up, and adjudicate; with `GEMINI_API_KEY`, one real draft call against recorded facts.
