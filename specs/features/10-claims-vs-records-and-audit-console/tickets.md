# Phase 10 tickets: claims vs records, and the audit console

## T-001: Claims vs records, and the checks that decided

Status: open
Blocked by:
Tier: standard
Slice: A beat 3, 4 or 5 decision entry, with its ticket, order number and mandate, becomes the pairs "what the message claims" beside "what the records say", each with its verdict, source and sandbox ID.
Test seam: the gate's `claimsVsRecords` and checks-that-decided exports (public interface only), over decision entries written by `propose()` on PGlite
Acceptance:
- [ ] The checks that decided are the matched rules' `require` plus `shipment.status` when a matched `when` tests it; with no matched rule, the facts the action's rules test in `when`; with a mandate the gate doesn't hold, the whole trace
- [ ] Pairs follow requirements.md's table: claim side, record words, detail, value, sources in words with call and record ID ("none" for a missing ID), and verdict; every row of the `shipment.status` verdict table has a test, and an unknown check is "No record"
- [ ] The message pair is last whenever the ticket exists, marked simulated when the ticket is, with the fixed record line and Not used; a decision with no intent gives the one "couldn't read" pair
- [ ] No ticket ID, and a ticket ID the store lacks, give their fixed claim sentences
- [ ] Every verifier in `VERIFIERS` has words; beat 3's KIK-1039 and KIK-1042, beat 4 and beat 5 read as requirements.md describes
- [ ] A test fails if `decide`, `@countersign/verifiers` or `@countersign/mandate` imports this module
Notes:

## T-002: The audit reader

Status: open
Blocked by:
Tier: standard
Slice: From a log holding beats 3 to 5, an approved and reconciled step-up and an unreadable entry, the gate lists decision rows with statuses, filters and pages them, and reads one decision with its intent's trail, plus the raw entry pages.
Test seam: the gate's audit-reader exports (rows, detail by `seq`, newest decision by intent, entries), over PGlite with an injected time
Acceptance:
- [ ] Rows come newest first with every field in requirements.md and each status: executed, failed, unknown, pending, not executable, open, approved (with its execution), denied, expired
- [ ] `decision`, `q`, `before` and `limit` filter and page as specified, with counts for the current `q` and the next cursor
- [ ] An unreadable decision entry is a `readable: false` row with its problem; the other rows still list
- [ ] The detail holds the intent hash and canonical JSON, the mandate and its entry `seq`, usage, reasons with words, the full trace, the ticket, the proposal text, the entry's hashes, and the trail of approval, request, result and webhook reconciliation in order with their parts; an unreadable trail entry shows its problem
- [ ] A `seq` that isn't a decision is not found; an unreadable decision returns its problem and raw payload text; by-intent returns the newest decision's `seq`
- [ ] Entries page newest first with one summary sentence per entry type and the total
Notes:

## T-003: The evidence file and `ledger check-export`

Status: open
Blocked by:
Tier: standard
Slice: Chosen audit-log rows become a `countersign-evidence-v1` file with the chain verdict and head, and `npm run ledger -- check-export <file>` re-hashes every row in it.
Test seam: `@countersign/ledger`'s evidence builder, `checkEvidence` and `runLedgerCli`, over PGlite
Acceptance:
- [ ] The file holds `format`, `exported_at`, `scope`, `chain` (from a fresh verify), the rows exactly as stored in ascending `seq`, and the fixed `check` sentence; it's validated by an exported zod schema
- [ ] `checkEvidence` passes on a built file, and names the `seq` when a payload character, a hash, the `seq` order or a payload's canonical form is changed
- [ ] `check-export` exits 0 with the intact sentence and head, 1 with one line per problem, 2 for an unreadable or invalid file; the usage line names it; one child-process run
- [ ] The existing ledger tests pass unchanged, and the ledger still imports no AI SDK
Notes:

## T-004: Evidence selection by intent and by capture

Status: open
Blocked by: T-002, T-003
Tier: simple
Slice: The gate picks the rows for an intent's or a capture's evidence and builds the file, so an approved and reconciled beat 5 exports with everything that happened to it.
Test seam: the gate's evidence-export function (scope in, file or not found out), over PGlite
Acceptance:
- [ ] Intent scope: every entry with the intent's ref plus the `mandate.version` entries its decisions point at
- [ ] Capture scope: the same for every intent on the capture, plus every reconciliation whose refund names the capture, unmatched ones included
- [ ] An intent or capture with nothing selected is not found; the built file passes `checkEvidence`
Notes:

## T-005: The audit API

Status: open
Blocked by: T-001, T-002, T-004
Tier: standard
Slice: Over a real listening gate, the approver key lists decisions, opens one with its claims vs records and trail, pages entries, verifies the chain and downloads evidence; nothing else gets in.
Test seam: HTTP against `createApp` on `127.0.0.1` port 0, with PGlite and the fake sandbox
Acceptance:
- [ ] `GET /audit/decisions`, `/audit/decisions/:seq`, `/audit/intents/:id`, `/audit/entries`, `/audit/verify` and `/audit/export` answer the snake_case JSON (or file) requirements.md describes; the detail includes the pairs from T-001
- [ ] No key, a wrong key and a principal key answer 401 on every route before anything is read; the approver key still never works on `/mcp`
- [ ] Unknown or bad query parameters, and both or neither of `intent` and `capture`, answer 400; unknown `seq`, intent or empty export 404; no database 503; answers never echo the request
- [ ] The export carries an attachment header named `countersign-evidence-<scope>-<id>.json`; verify reports a row edited behind the trigger as broken at its `seq`
- [ ] Every route and reader leaves the log's head and row count unchanged; no test key appears in any answer
Notes:

## T-006: Approval cards gain claims

Status: open
Blocked by: T-001
Tier: simple
Slice: The beat 5 card from `GET /approvals` carries the same claims-vs-records pairs as its decision page, and its checks use the shared rule.
Test seam: the gate's card builder and `GET /approvals` over the real gate
Acceptance:
- [ ] Each card gains `claims`, equal to `claimsVsRecords` for its step-up
- [ ] `checks` uses the shared checks-that-decided rule; the phase 9 card, API and CLI tests pass unchanged or with only the narrowing they already expected
Notes:

## T-007: The `audit` CLI

Status: open
Blocked by: T-005
Tier: simple
Slice: `npm run audit -- show <seq>` prints a decision's claims vs records and trail in the terminal, and `npm run audit -- export --capture <id>` writes the evidence file.
Test seam: `runAudit(args, env, deps)` and one child-process run of `audit-main.ts`
Acceptance:
- [ ] `show` prints the decision line, the pairs under "What the message claims" and "What the records say", and the trail; `--json` prints the detail
- [ ] `export` writes the file to `--out` or the default name, prints its path and entry count, and never overwrites a file
- [ ] Exits 0, 1 (chain broken at export, file still written) and 2 (no database, unknown `seq`, nothing to export, bad argument, existing file); missing variables are named, never shown
- [ ] Root `package.json` gains the `audit` script
Notes:

## T-008: Console audit routes and the shared sign-in

Status: open
Blocked by: T-005
Tier: standard
Slice: The console's server routes reach the gate's audit API with the approvals cookie, and every signed-out page can show one shared sign-in.
Test seam: the route-handler and loader functions in `apps/console/src/`, with a fake gate fetch
Acceptance:
- [ ] `GET /api/audit/decisions`, `/decisions/[seq]`, `/intents/[id]`, `/entries`, `/verify` and `/export` forward the cookie's key as the bearer and zod-validate the request and every gate answer; the export passes through only with `format` `countersign-evidence-v1` and its attachment header
- [ ] No cookie, a gate 401 (cookie cleared), an unreachable gate and a junk answer give the approval routes' fixed sentences and statuses; gate 400, 404 and 503 sentences pass through with their status
- [ ] The sign-in form moves out of the approvals board into one shared component taking its own line of copy; the approvals page still works with it
- [ ] The modules client components import pull in neither `@countersign/mandate` nor any key; no key appears in any route answer
Notes:

## T-009: The Decisions page

Status: open
Blocked by: T-008
Tier: standard
Slice: Signed in, `/decisions` shows every decision in a Graphite table with its badge, why and status, filters by decision, searches, pages back, and shows the chain's state; the sidebar reaches it and `/` redirects to it.
Test seam: the decision-list view model in `apps/console/src/` over recorded gate answers, plus the Graphite design check
Acceptance:
- [ ] Rows show when, ticket sender with claim words, action, amount, the Allowed / Step-up / Denied badge with its tone, why (words with code, or "Allowed by rule …"), the status words in requirements.md, and the record ID; each links to `/decisions/<seq>`; unreadable rows say so
- [ ] The segmented control's counts, the search field, "Older decisions" paging and the empty-log sentence come from the view model
- [ ] The chain card shows intact with entries and time, or broken with the problem count and a link to `/audit`
- [ ] The sidebar gains Decisions and Audit log after Approvals (Lucide icons); `/` redirects to `/decisions`; signed out, the shared sign-in shows the decisions line
- [ ] The design check passes; the table scrolls inside its box at phone width
Notes:

## T-010: A decision's page

Status: open
Blocked by: T-008
Tier: standard
Slice: `/decisions/[seq]` shows one decision's claims vs records, how the gate decided, why, the suggested reply, what happened at PayPal, its audit entry and the evidence exports; `/decisions/intent/[id]` redirects to it.
Test seam: the decision-page view model in `apps/console/src/` over recorded gate answers, plus the Graphite design check
Acceptance:
- [ ] Title, breadcrumb, badge and the "Proposed by … No money moved." / "PayPal refunded it." line; "Open ticket" links to the ticket's thread
- [ ] The claims-vs-records table with result badges and tones as requirements.md lists, stacking at phone width; the full trace table; the reasons with codes; the suggested reply with "Copy reply" on denials only
- [ ] "What happened" turns each trail entry into its sentence with sandbox IDs in mono; an open step-up links to `/approvals`
- [ ] The audit entry block shows the chain badge, intent hash, hash and previous hash (truncated, full in a tooltip) and the mandate; export links for the intent and, for a capture target, the payment
- [ ] An unreadable entry shows its problem and raw payload; an unknown `seq` or intent shows its not-found sentence; by-intent redirects to the newest decision
Notes:

## T-011: The Audit log page

Status: open
Blocked by: T-008
Tier: simple
Slice: `/audit` lists every audit-log entry newest first and checks the chain on demand, showing the verdict, head and any problems.
Test seam: the audit-log view model in `apps/console/src/` over recorded gate answers, plus the Graphite design check
Acceptance:
- [ ] The table shows seq, when, type, summary, ref and a truncated hash with its full value in a tooltip; decision rows link to their page; "Older entries" pages back
- [ ] "Check the chain" shows "Chain intact: N entries. Head #S <hash>." or "Chain broken: N problems." with one line per problem
- [ ] Signed out, the shared sign-in shows; the design check passes
Notes:

## T-012: Two columns on the approvals card

Status: open
Blocked by: T-006
Tier: simple
Slice: The phone approvals card for beat 5 shows "What the message claims" beside "What the records say", with verdict badges, stacking on a phone.
Test seam: the approvals card view model in `apps/console/src/approvals-view.ts` over a recorded card answer, plus the Graphite design check
Acceptance:
- [ ] The card's schema reads `claims`, and the view model turns each pair into claim text, record words, source and record ID, and a verdict badge with its tone
- [ ] The card renders the pairs in place of its old records list: two columns from 768px up, stacked pairs below; the phase 9 approvals tests still pass
Notes:

## T-013: Inbox links to decisions

Status: open
Blocked by: T-010
Tier: simple
Slice: Each guarded call in Resolve's inbox links "Claims vs records" to its decision page, so the agent's trace shows the two columns one tap away.
Test seam: `toolRow` in `apps/console/src/inbox-view.ts` over recorded runs
Acceptance:
- [ ] A guarded call with an intent ID gets a link to `/decisions/intent/<intent ID>`; one without an intent, and every read-only call, gets none
- [ ] The existing inbox tests pass unchanged
Notes:

## T-014: README, glossary and phase 10 status

Status: open
Blocked by: T-007, T-009, T-010, T-011, T-012, T-013
Tier: simple
Slice: The README explains the decisions, decision page, audit log and evidence export, and the glossary names the new terms.
Test seam: none (docs); the Feedback commands pass
Acceptance:
- [ ] README gains a "See every decision" section: `/decisions`, the two columns, `/audit` and the chain check, exporting evidence and `npm run ledger -- check-export`, and `npm run audit`; the phase status table marks phase 10
- [ ] `CONTEXT.md` gains claim pair, verdict (Matches, Contradicts, Passes, Fails, No record, Not used), checks that decided and evidence export, in its format
Notes:
