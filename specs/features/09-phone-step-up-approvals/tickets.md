# Phase 9 tickets: phone step-up approvals

## T-001: The `approval` entry and the step-up reader

Status: done
Blocked by:
Tier: standard
Slice: A beat 5 step-up decided by `propose()` reads back as an open card, and after an `approval` entry for its intent it reads as answered, with `ledger verify` passing over both.
Test seam: `@countersign/ledger`'s entry types and verify, and the gate's approval-entry writer and step-up reader (list and by ID), over PGlite
Acceptance:
- [x] `ENTRY_TYPES` gains `approval`; `ledger verify` and `tail` accept it, and the existing ledger tests pass unchanged
- [x] The approval payload (ADR 0032) is a strict zod schema; its writer refuses any other shape, so nothing invalid is appended
- [x] The reader finds step-ups (decision `step_up` with an intent), works out open, answered and expired from the log and an injected time, lists one open card per intent (its newest open step-up) and the last 20 answered or expired ones, and says not found for any other `seq`
- [x] A deny for an intent answers every earlier step-up of that intent; a later step-up of it stays open
- [x] An unreadable decision or approval entry makes the read unknown, never skipped
Notes:

## T-002: Execution entries for approved and non-refund intents

Status: done
Blocked by:
Tier: standard
Slice: An `execution.requested` entry pointing at an approval, and an invoice's request and result, are written and read back by every execution reader beside phase 6's entries.
Test seam: the gate's execution-entry writers and readers (`readExecutionHistory`, `readIntentRecord`, the reconciliation state)
Acceptance:
- [x] `execution.requested` gains the approved shape (`replay: false`, `approvalSeq`) and an optional `target` that new entries always carry; `captureId` stays, null for an invoice
- [x] `execution.result` gains `invoice: { id, status }` (`SENT` or `SCHEDULED` when executed) in place of `refund`
- [x] Entries in the shapes phases 6 to 8 wrote still read the same; a fixture log from phase 8's tests reads identically before and after
- [x] An executed invoice counts in the execution history (so in today's usage) with its amount; reconciliation ignores results without a refund
Notes:

## T-003: Invoice send and draft invoices in the rail client

Status: done
Blocked by:
Tier: simple
Slice: The PayPal client can create a draft invoice and send an invoice, against the fake PayPal server, with their answers zod-parsed.
Test seam: `createPayPalClient(...).sendInvoice` and `.createDraftInvoice` from `@countersign/rail-paypal`, against `test/fake-paypal.ts`
Acceptance:
- [x] `sendInvoice({ invoiceId, sendToRecipient, note?, additionalRecipients? })` posts to `/v2/invoicing/invoices/{id}/send` with `send_to_invoicer: true` and only the fields given, sends no `PayPal-Request-Id`, is never retried, and returns `SENT` for 200 and `SCHEDULED` for 202
- [x] A 4xx throws a `PayPalError` with name and issues; a 5xx or network failure throws without a retry
- [x] `createDraftInvoice({ requestId, recipientEmail, items })` takes minor-unit amounts, posts with the readable request ID, and returns the new invoice ID
- [x] Contract tests cover each answer; no token appears in any error
Notes:

## T-004: One executor per action, and invoice send made executable

Status: done
Blocked by: T-002, T-003
Tier: standard
Slice: `propose()` executes an allowed refund exactly as before and, under a mandate that allows it, an allowed invoice send once, both through the same executors an approval will use.
Test seam: `propose()` and the gate's executor module, with the fake sandbox and PGlite
Acceptance:
- [x] `EXECUTABLE_ACTIONS` is `paypal.refund` and `paypal.invoice.send`; every other allow is still denied `ACTION_UNAVAILABLE`
- [x] Every existing propose, replay, reconcile and MCP test passes unchanged
- [x] An allowed invoice send writes its request (with target), sends once with the hashed note and recipients, and logs `SENT`, `SCHEDULED`, `failed` or `unknown` as ADR 0033 says
- [x] Proposing the same allowed invoice intent again never sends a second time
- [x] The gate's fake sandbox gains invoice send with selectable answers and a call log
Notes:

## T-005: Answering a step-up

Status: done
Blocked by: T-001, T-004
Tier: standard
Slice: Approving beat 5's step-up with its hash executes exactly that $240.00 refund once; every other answer is denied or rejected with its code and nothing moves.
Test seam: `answerStepUp()` in `apps/gate/src/`, with the fake sandbox, PGlite and an injected clock
Acceptance:
- [x] Approve writes `approval` then `execution.requested` (with `approvalSeq`) in one transaction, then one refund with the intent hash as request ID, then its result; the answer carries the outcome and refund
- [x] Deny writes a `denied` entry and makes no rail call
- [x] Each rejection code in requirements.md, in order, writes a `rejected` entry and makes no rail call: `HASH_MISMATCH`, `ALREADY_ANSWERED`, `EXPIRED`, `ALREADY_REQUESTED`, `ACTION_UNAVAILABLE`, `DUPLICATE_REFUND`
- [x] A `seq` that isn't a step-up is `not_found` and writes nothing; an unreadable history rejects `DUPLICATE_REFUND` for a refund
- [x] Two approvals of one step-up started together make one refund; an approved invoice step-up sends once
- [x] The agent's later replay of an approved refund intent is answered from the log, with no second refund
Notes:

## T-006: The approver key and the approval API

Status: done
Blocked by: T-005
Tier: standard
Slice: Over a listening gate, the approver lists beat 5's card with every field, approves it with its hash and gets the refund back, while agents and wrong keys get 401.
Test seam: the gate's `createApp` approval routes over HTTP, and its card-view builder
Acceptance:
- [x] `COUNTERSIGN_APPROVER_KEY` is read with the principal-key rules: under 32 characters or equal to any principal key counts as unset, with a startup line naming the variable only; constant-time comparison
- [x] `GET /approvals`, `GET /approvals/:id` and `POST /approvals/:id` answer as requirements.md says (200, 400, 401, 404, 503), with a 16 KB strict body
- [x] A card holds every field in requirements.md: action words, amount and display text, target, seeded order number, ticket excerpt and attachment IDs, claim, reasons with catalog words, the checks the matched rules use with source call and record ID, times, state and `can_execute`
- [x] A principal key is refused on the approval routes, and the approver key is refused on `/mcp`
- [x] No answer or log line holds a key
Notes:

## T-007: The `approvals` CLI

Status: done
Blocked by: T-006
Tier: simple
Slice: From the terminal, the operator lists open cards, approves beat 5's with its hash and sees the refund ID.
Test seam: `runApprovals(args, env, deps)` in `apps/gate/src/`, plus one child-process run of `approvals-main.ts`
Acceptance:
- [x] `list`, `show <id>`, `approve <id> --hash <hash>` and `deny <id>` print what requirements.md says, with reason words and codes, and `--json` prints the answers
- [x] Exit codes 0, 1 and 2 as requirements.md says; missing variables are named, never shown
- [x] Answers from the CLI are written with channel `cli`
- [x] Root `package.json` gains the `approvals` script
Notes:

## T-008: Step-up end to end over MCP

Status: done
Blocked by: T-006
Tier: standard
Slice: An agent's beat 5 refund over `/mcp` waits for approval, the merchant approves it through the API, exactly one refund executes and reconciles, and a changed-amount approval is refused.
Test seam: the gate's `createApp` over HTTP (MCP client and approval API), its fake sandbox and the webhook fixture
Acceptance:
- [x] `create_refund` for beat 5 answers `pending_approval` with `expires_at` 15 minutes after the decision
- [x] Approving through `POST /approvals/:id` executes one refund; a webhook for it reconciles; `ledger verify` passes
- [x] An approval sent with the hash of the same intent at $241.00 is rejected `HASH_MISMATCH` and the sandbox has no refund
- [x] An approval after the clock passes `expires_at` is rejected `EXPIRED`; the card then lists as expired
Notes:

## T-009: Console approval routes and the approver login

Status: open
Blocked by: T-006
Tier: standard
Slice: The console signs the approver in with the key, keeps it in an HttpOnly cookie, and lists and answers cards through its own routes.
Test seam: the route handlers and zod schemas in `apps/console/src/` (approval routes, session), with an injected `fetch`
Acceptance:
- [ ] `POST /api/approvals/session` checks the key against the gate and sets `countersign_approver` (`HttpOnly`, `SameSite=Strict`, `Path=/`, 12 hours, `Secure` over HTTPS); a wrong key sets nothing; `DELETE` clears it
- [ ] `GET /api/approvals`, `GET /api/approvals/[id]` and `POST /api/approvals/[id]` forward the cookie's key as the bearer to `GATE_URL` and validate the request and every answer with zod
- [ ] A gate 401 clears the cookie and answers 401 "Sign in again."; an unreachable gate or junk answer gives 502 with the fixed sentence
- [ ] No answer, error or log holds the key; the routes stay browser-safe where a client component imports them
Notes:

## T-010: The approvals page

Status: open
Blocked by: T-009
Tier: standard
Slice: On a phone-width screen, the approver signs in, sees beat 5's itemized card, taps Approve and reads "Approved. Refund … is done."
Test seam: the approval view models in `apps/console/src/` (card view, time left, outcome sentences, button classes), plus the Graphite design check
Acceptance:
- [ ] `/approvals` shows the sign-in field without the cookie, and the open cards, newest first, with every part requirements.md lists; a card that can't execute shows its sentence and only Deny
- [ ] Each outcome and rejection maps to its exact sentence in requirements.md
- [ ] Approve sends the card's hash; the page polls every 3 seconds; "Sign out" clears the session
- [ ] Approve and Deny are 40px tall, every other control at least 24px; reasons show words with the code in inline code
- [ ] The sidebar gains Approvals with an open-card count; the page works in light and dark at phone and desktop widths
Notes:

## T-011: The QR code and the manifest

Status: open
Blocked by: T-010
Tier: simple
Slice: On desktop, the approvals page shows a QR code that opens the same page on a phone, and the page can be added to a phone's home screen.
Test seam: the QR view model in `apps/console/src/` (URL choice and module matrix to SVG rects), and `app/manifest.ts`'s output
Acceptance:
- [ ] The URL is `CONSOLE_PUBLIC_URL` plus `/approvals` when set, else the request origin plus `/approvals`
- [ ] The SVG comes from `uqr`'s matrix for that URL, with a quiet zone, token classes only and a text label; shown at 768px and up
- [ ] The manifest has the name, short name, start URL and `standalone`, and no colour values
- [ ] The design check passes
Notes:

## T-012: What happened to held calls, in the inbox

Status: open
Blocked by: T-001, T-002
Tier: simple
Slice: In the inbox, beat 5's "Waiting for approval" row turns into "Approved by you" with the refund ID once the merchant approves.
Test seam: resolve-agent's execution read (`GET /threads/:id`'s per-run executions) and the console's inbox view model
Acceptance:
- [ ] For each `pending_approval` call in a run's trace, Resolve reports the latest answer for that intent (approved, denied, expired by its `expires_at`, or waiting) and, for approved, the execution outcome and refund or invoice ID
- [ ] The console schema and inbox rows show "Approved by you" with the ID, "Denied by you", "Expired, so denied" or "Waiting for approval"
- [ ] Old answers without the new fields still parse
Notes:

## T-013: Live checks for invoice send and approvals

Status: open
Blocked by: T-005
Tier: simple
Slice: Under `LIVE=1` with the PayPal variables, a real draft invoice is created, approved through `answerStepUp` and sent once in the sandbox.
Test seam: `packages/rail-paypal/test/live-sandbox.test.ts` and `apps/gate/test/approvals-live.test.ts`, skipped without `LIVE=1`
Acceptance:
- [ ] The rail-paypal live test creates a draft to an `example.com` recipient, sends it, and expects a 4xx on a second send
- [ ] The gate live test decides a `send_invoice` step-up on a fresh draft, approves it and checks one send and its result entry
- [ ] Both skip cleanly without `LIVE=1` or the variables, and stay out of the Feedback commands
Notes:

## T-014: README and glossary

Status: open
Blocked by: T-010, T-011
Tier: simple
Slice: The README tells someone new how to approve a held refund from their phone, and the glossary names the new terms.
Test seam: none (docs); the Feedback commands still pass
Acceptance:
- [ ] README gains "Approve from your phone": start the services, `/approvals`, the approver key, the QR code, `npm run approvals`, and the variable names (`COUNTERSIGN_APPROVER_KEY`, `GATE_URL`, `CONSOLE_PUBLIC_URL`); the status table gains phase 9
- [ ] `CONTEXT.md` has approver key, step-up card and approval answer if any is missing
Notes:
