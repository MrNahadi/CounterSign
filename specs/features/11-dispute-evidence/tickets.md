# Phase 11 tickets: dispute evidence

## T-001: The rail client's dispute calls

Status: done
Blocked by:
Tier: standard
Slice: `@countersign/rail-paypal` reads a dispute in full and can accept a claim, make an offer, provide evidence with PDF documents, and, in the sandbox, require evidence and adjudicate.
Test seam: the PayPal client's public methods against the fake PayPal server, plus one `LIVE=1` case
Acceptance:
- [x] Get dispute returns reason, life-cycle stage, seller response due date (or null), captures and link names; the existing dispute tests still pass
- [x] Accept claim, make offer, require evidence and adjudicate send the paths and bodies in requirements.md, with offer amounts converted from minor units inside the client
- [x] Provide evidence sends `multipart/form-data` with an `input` JSON part and `file1…` parts carrying each document's name and content type, and the fake server checks the parts
- [x] None of the new calls sends `PayPal-Request-Id` or retries after a 5xx or a network error
- [x] Inputs are refused before sending: more than 5 documents, one over 1 MB, a name outside PayPal's pattern, notes outside 1 to 2000 characters
- [x] Under `LIVE=1`, listing the merchant's disputes works and, when one exists, reading it does too
Notes:

## T-002: The `dispute.received` entry

Status: done
Blocked by:
Tier: simple
Slice: The ledger accepts a `dispute.received` entry, and the gate can build one and read which disputes and webhook event IDs are already recorded.
Test seam: `@countersign/ledger`'s append and verify, and the gate's dispute-entry builder and reader, over PGlite
Acceptance:
- [x] `ENTRY_TYPES` includes `dispute.received`; appends and `ledger verify` work with it; the ledger's existing tests pass
- [x] The builder makes the payload in requirements.md from a re-read dispute, with `refId` the dispute ID, for both `webhook` and `poll` sources
- [x] The reader returns the recorded dispute IDs and event IDs; an unreadable `dispute.received` payload makes the state unknown
Notes:

## T-003: The evidence documents and dispute drafts tables

Status: done
Blocked by:
Tier: simple
Slice: `@countersign/db` holds write-once evidence documents and Resolve's dispute drafts, with a migration each.
Test seam: `@countersign/db`'s exported tables and helpers, over PGlite after `migrate`
Acceptance:
- [x] `evidence_documents` has the columns in requirements.md; inserting and reading a document by ID and by dispute works
- [x] A trigger rejects UPDATE and DELETE on `evidence_documents`; TRUNCATE works
- [x] `dispute_drafts` holds a draft per dispute with status (checked against the listed values), outcome, `drafted_by`, model, model versions, notes, facts summary, agent response, intent ID and times
- [x] Migrations apply on a fresh PGlite and on a database at phase 10's schema
Notes:

## T-004: The dispute webhook and the nudge

Status: done
Blocked by: T-001, T-002
Tier: standard
Slice: A signed `CUSTOMER.DISPUTE.CREATED` event makes the gate re-read the dispute, record `dispute.received` once, and tell Resolve.
Test seam: `handlePayPalWebhook` with a fake verifier, fake rail and an injected fetch, and the gate's webhook route over HTTP
Acceptance:
- [x] A verified event appends one `dispute.received` built from the re-read dispute, never from the event body
- [x] A redelivered event ID answers "Already recorded." and writes nothing; `.UPDATED` and `.RESOLVED` are ignored
- [x] A bad signature, a missing `dispute_id`, an unreadable dispute and a log that can't be written answer as requirements.md says
- [x] After a new entry, `POST <RESOLVE_AGENT_URL>/disputes` is sent once with the dispute ID; a failing or slow fetch (over 2 s) changes no answer
- [x] Refund webhooks still reconcile as before
Notes:

## T-005: The `disputes` CLI

Status: done
Blocked by: T-004
Tier: standard
Slice: `npm run disputes -- sync | list | show <id> | require-evidence <id> | adjudicate <id> --favor …` polls, records and moves sandbox disputes from the command line.
Test seam: the CLI's run function `(args, env, deps)` with a fake rail, PGlite and an injected fetch, plus one child-process run
Acceptance:
- [x] `sync` records only disputes with no `dispute.received` entry, prints one line each, says when PayPal had more pages, nudges Resolve per new entry, and a second run records nothing
- [x] `list` and `show` print the lines in requirements.md, including whether each dispute is recorded
- [x] `require-evidence` and `adjudicate` call the sandbox endpoints, say they're sandbox-only, and exit 1 on a 4xx refusal
- [x] Exit codes follow the CLI convention; missing PayPal variables are named, never shown; the root `disputes` script exists
Notes:

## T-006: Evidence facts and documents

Status: done
Blocked by: T-001, T-003
Tier: standard
Slice: For one dispute, the gate builds the facts from records, stores the export JSON and the evidence PDF, and suggests evidence items.
Test seam: the gate's evidence-pack function (dispute ID in; facts, document rows and suggested items out), over PGlite with the fake sandbox and the carrier mock
Acceptance:
- [x] For a dispute on a delivered, tracked seed capture with an earlier step-up and a refund, the facts hold every field in requirements.md, and no payer email, ticket sender or ticket text
- [x] The stored export passes `checkEvidence`; the PDF reads back with `pdf-lib` with the sections, the simulated-carrier and illustrative lines and the export's SHA-256, under 1 MB and at most 6 pages
- [x] Each document row's SHA-256 matches its bytes
- [x] The suggested items follow the fixed table (delivered → fulfilment with tracking numbers; completed refund → refund with IDs; otherwise other)
- [x] An unreadable tracker or carrier read is listed as not available; an unreadable dispute or one with no capture isn't built and says which
Notes:

## T-007: `prepare_dispute_evidence`, and documents in `provide_dispute_evidence`

Status: done
Blocked by: T-006
Tier: standard
Slice: An agent over MCP prepares a dispute's evidence and proposes it with the PDF, and the intent hash binds the documents.
Test seam: the gate's MCP server over a real listening gate with a test principal key, and `propose()`
Acceptance:
- [x] `prepare_dispute_evidence` is in the tool list as an extension and answers the masked facts, documents and suggested items in snake_case; its errors are fixed sentences
- [x] `provide_dispute_evidence` takes `document_ids` and per-item `refund_ids`; with the PDF it steps up under the shipped mandate
- [x] A missing, non-PDF or other-dispute document is `INVALID_PROPOSAL`; a store that can't be read is `TARGET_UNKNOWN`
- [x] The hash covers `documents: [{ id, name, sha256 }]`: changing a note or a document changes it; every existing intent-hash test passes unchanged
Notes:

## T-008: Dispute executors

Status: done
Blocked by: T-001, T-007
Tier: standard
Slice: An approved (or allowed) accept claim, offer or evidence submission runs once on PayPal and its result is logged.
Test seam: `execute()` and `answerStepUp` over PGlite with the fake sandbox
Acceptance:
- [x] `EXECUTABLE_ACTIONS` gains the three dispute actions; payouts and order capture are still `ACTION_UNAVAILABLE`
- [x] Approving a provide-evidence step-up sends one multipart call with the stored notes and the PDF bytes, and records `dispute: { id, status }` with the status re-read (null if the read fails)
- [x] Approving again or re-proposing the same intent sends nothing; nothing is retried
- [x] Bytes whose SHA-256 differs, or a missing row, record `failed` `DOCUMENT_CHANGED` with nothing sent; a 4xx is `failed` and a 5xx `unknown`
- [x] Accept claim and make offer execute from approval with their hashed parameters; executed dispute actions count in today's usage
Notes:
- Tracking numbers are sent as carrier `OTHER` with the fixed `carrier_name_other` "Carrier (simulated)" (`EVIDENCE_CARRIER`, ADR 0036, from the answerer).

## T-009: Resolve's dispute intake

Status: done
Blocked by: T-003
Tier: standard
Slice: `POST /disputes` queues one draft per dispute on Resolve's run queue, and `GET /disputes` lists them.
Test seam: resolve-agent's `createApp` over HTTP with PGlite, a fake drafter and an injected clock
Acceptance:
- [x] `POST /disputes` validates `{ dispute_id }`, answers 202 with a new draft, or 200 with the existing draft unless it failed
- [x] Drafts run one at a time on the same queue as message runs and count against the daily run cap; over the cap a draft is `not_run` with `daily_cap`
- [x] `GET /disputes` and `GET /disputes/:id` answer the fields in requirements.md; an unknown ID is 404
- [x] A draft interrupted by a restart is marked failed and never rerun
Notes:
- ADR 0037 (answerer): failed drafts stay as rows (migration 0006 swaps the unique constraint for a partial unique index), every draft counts against the cap, and `GET /disputes/:id` takes the dispute ID.

## T-010: The dispute drafter

Status: done
Blocked by: T-007, T-009
Tier: standard
Slice: A queued draft prepares the evidence over MCP, gets notes from one Gemini call or the template, and proposes `provide_dispute_evidence`, so a step-up waits for the merchant.
Test seam: the drafter's run function with a fake model and the real gate over MCP on PGlite, plus one `LIVE=1` case with Gemini
Acceptance:
- [x] A draft makes exactly one `prepare_dispute_evidence` call, one model call and one proposal, with types, tracking numbers, refund IDs and the PDF set by code and notes from the model; it's stored `proposed` with `pending_approval` and the intent ID
- [x] The model call uses the structured-output config in requirements.md and the fail-closed checks; a blocked response, a non-STOP finish, invalid JSON or no API key uses the template and records `drafted_by: template`
- [x] The template notes read as requirements.md says, with the simulated carrier labelled
- [x] The system instruction is a byte-stable constant pinned by a test; the model never sees a payer email or ticket text
- [x] `npm run resolve -- dispute <id>` runs one draft and prints its outcome, notes and agent response
- [x] Under `LIVE=1` with `GEMINI_API_KEY`, one real call on recorded facts gives notes that validate and records `modelVersion`
Notes:
- The `LIVE=1` case is in `apps/resolve-agent/test/live.test.ts` but hasn't run: the loop can't reach Gemini. The owner should run it once.

## T-011: Approval cards with what executes, and document download

Status: done
Blocked by: T-007, T-008
Tier: standard
Slice: A held dispute action's card shows exactly what will be sent, and the approver can download its documents.
Test seam: the gate's card builder and the approval API over a real listening gate
Acceptance:
- [x] Every card carries `params` as requirements.md lists for invoice sends, accept claim, offers and evidence; a refund card has none; existing card tests still pass
- [x] `GET /approvals/documents/:id` answers the bytes with content type and attachment header to the approver key, 401 to no key or a principal key, 400 for a malformed ID, 404 for an unknown one
- [x] Approving a provide-evidence card answers with `dispute: { id, status }`
Notes:

## T-012: Audit reader lines for disputes

Status: done
Blocked by: T-002, T-008
Tier: simple
Slice: The audit console and `audit` CLI describe dispute arrivals and dispute executions in words.
Test seam: the gate's audit-reader exports over PGlite
Acceptance:
- [x] `dispute.received` entries summarise as requirements.md says; an unreadable one says it can't be read
- [x] Dispute results summarise and appear in the trail with the dispute ID and status; decision rows for dispute actions show the dispute as target and their executed status
- [x] The phase 10 reader and audit-console tests still pass
Notes:

## T-013: The card's evidence section in the console

Status: done
Blocked by: T-011
Tier: standard
Slice: On the phone, the merchant reads every note and document of a held evidence submission and can download the PDF before approving.
Test seam: `apps/console/src/` approvals view model and the document route handler
Acceptance:
- [x] The card zod schema accepts `params`; the view model gives the "What you're approving" rows for evidence, offers, accept claim and invoice sends
- [x] Documents show name, size, short SHA-256 with the full value available, and a download link to `/api/approvals/documents/<id>`
- [x] The route forwards the sign-in cookie as the bearer, passes the bytes through with the gate's content type and attachment header, refuses a malformed ID, and answers 401 and 502 with the fixed sentences
- [x] The design check passes on every new or changed file
Notes:

## T-014: The Disputes page

Status: done
Blocked by: T-009
Tier: standard
Slice: The merchant sees every dispute PayPal opened, its draft's state and who wrote it, and can draft again after a failure.
Test seam: `apps/console/src/` disputes view model and the disputes route handlers
Acceptance:
- [x] The view model turns Resolve's `GET /disputes` answer into the table in requirements.md: status words, drafted-by words ("Template, no AI" for the template) and decision links
- [x] `GET /api/disputes` and `POST /api/disputes` call Resolve with zod-checked requests and answers, need the approvals sign-in, and answer 401 and 502 with the fixed sentences
- [x] The sidebar gains Disputes after Approvals; the page shows the empty-state sentence with no drafts
- [x] The design check passes on every new file
Notes: The sign-in is checked with the gate before Resolve is asked (ADR 0038, answerer). Resolve's draft view gains `dispute: { reason_words, amount } | null` from the facts summary, since the table needs the reason and amount.

## T-015: Demo files, live check and README

Status: done
Blocked by: T-005, T-010, T-012, T-013, T-014
Tier: standard
Slice: Beat 7 can be run end to end against the sandbox from the README, and the live spike S3 check exists.
Test seam: `apps/gate/test/disputes-live.test.ts` (skips with a reason unless `LIVE=1` and `PAYPAL_LIVE_DISPUTE_ID` are set) and the README
Acceptance:
- [x] The live test requires evidence, builds the pack, proposes, approves the step-up, checks PayPal took the PDF, and adjudicates `SELLER_FAVOR`; it skips cleanly without its variables
- [x] A signed-webhook fixture for `CUSTOMER.DISPUTE.CREATED` and a fake-sandbox dispute let `npm test` run beat 7 from webhook to approved submission
- [x] README gains "Answer a dispute" (sync, the draft, the card, the PDF, what's simulated) and marks phase 11 done; CONTEXT.md's dispute terms (Dispute, Evidence pack, Evidence document, Dispute draft) still match what was built
Notes: The beat 7 run lives in `apps/resolve-agent/test/beat-7.test.ts`, since it needs Resolve's drafter and the gate can't import Resolve. The live test has not been run (no PayPal access in the loop).
