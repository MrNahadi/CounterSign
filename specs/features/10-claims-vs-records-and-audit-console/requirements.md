# Phase 10 requirements: claims vs records, and the audit console

Brief §5 items 4 and 5, §5 Out of scope (no classifiers that detect lies or injections), §8 (no AI in the decision path; fail closed; credential custody; every number real; Graphite), §11 (accessibility), §12 (`ledger verify`). Decisions: ADR 0034, applying 0018, 0020, 0022, 0026, 0032 and 0033. Design baseline: original brief §5 (audit log "exports as dispute evidence"), §11 (the console's audit log screen) and §12. Layout reference: the canvas boards "Decisions" and "Decision detail" (ADR 0018). Where this file and the brief disagree, the brief wins.

## Behaviour

### Claims vs records (ADR 0034)

One gate function, `claimsVsRecords`, builds the two columns from a decision entry, its ticket (read from the ticket store by the intent's ticket ID), its seeded order number and its mandate (by hash, from the gate's loaded mandates). It is pure, has no AI and no network, and never feeds a decision.

**The checks that decided.** The verifiers the matched rules use: every `require`, plus `shipment.status` when a matched rule's `when` tests it. When no rule matched, the facts the action's rules test in `when`. When the decision's mandate isn't one of the gate's loaded mandates (by hash), every trace entry. This rule replaces the approval card's own narrowing, so the card and the console always agree.

**Pairs.** One pair per check that decided, in trace order, then the message pair. Each pair has a claim side (text, or null), a record side, and a verdict:

| Check | Claim side | Verdict when the check passes | when it fails | when unknown |
|---|---|---|---|---|
| `ticket.from_payer` | "Sent from <sender>" | Matches | Contradicts | No record |
| `shipment.status` | The claim in words (below), or null with no claim | By the table below | (never fails) | No record |
| `capture.refundable` | "Asks for <action words> <amount>" plus " on <order number>" when known | Matches | Contradicts | No record |
| `evidence.photo_present` | "<n> photos attached", or "No photo attached" | Matches | Contradicts | No record |
| Any other verifier | null | Passes | Fails | No record |

- Claim words: `not_received` "Says the parcel never arrived", `damaged` "Says the item arrived damaged", `wrong_item` "Says they got the wrong item".
- `shipment.status` verdicts: a `not_received` claim Matches `lost` and `stalled_10d` and Contradicts `delivered` and `in_transit`; a `damaged` or `wrong_item` claim Matches `delivered` and Contradicts the rest; with no claim, Passes.
- The sender is the ticket's email or phone. With no ticket ID on the intent the claim side is "No ticket named"; with a ticket ID the store doesn't hold, "Ticket <id> isn't in the ticket store".
- The record side: the verifier in words (table below), its detail, its value where it has one, and each record it read as a source in words (such as "PayPal order", "PayPal capture", "PayPal disputes", "Carrier (simulated)", "Ticket store", "Audit log") with the call and the record ID. A missing record ID shows as "none".
- **The message pair**, last, whenever the ticket exists: the claim side is the ticket's subject and the first 280 characters of its body, marked simulated when the ticket is; the record side is always "Messages can't approve money. Only your signed rules can.", sourced to the mandate's ID and version; the verdict is always Not used. Nothing ever reads the message to judge it.
- **A decision with no intent** (the proposal was malformed or named an unknown tool): one pair, claim side "The agent sent a proposal Countersign couldn't read." with the first 280 characters of the raw proposal text, record side "No records were read.", verdict Not used.

Verifier words:

| Verifier | Words |
|---|---|
| `capture.refundable` | Payment can be refunded |
| `ticket.from_payer` | Sender paid for the order |
| `dispute.none_open` | No open PayPal dispute |
| `shipment.status` | Carrier status |
| `evidence.photo_present` | Photo of the damage |
| `payee.allowlisted` | Payee is on your list |
| `ledger.not_duplicate` | Not refunded before |
| `ledger.velocity` | Within your usual pace |
| `mpesa.receipt_verified` | M-Pesa receipt confirmed |
| `mpesa.amount_matches_order` | Receipt amount matches the order |
| `mpesa.overpayment_covers_refund` | Overpayment covers the refund |
| `mpesa.recipient_is_payer` | Recipient paid the receipt |
| `mpesa.receipt_unused` | Receipt not used before |

The beat cases read like this: beat 3's KIK-1039 pairs "Sent from <buyer A>" with the order's payer (buyer B), Contradicts; KIK-1042 pairs "Says the parcel never arrived" with "Carrier status: delivered", Contradicts; beat 4 pairs it with `stalled_10d`, Matches; beat 5 pairs "1 photo attached" with the photo check, Matches, and "Asks for Refund $240.00 on KIK-1037" with the capture, Matches.

### The audit reader (gate)

Read-only, over the audit log, the ticket store and `seed_orders`. Payload text is parsed for display only and never re-hashed (ADR 0022).

- **Decision rows**, newest first: the entry's `seq` and time, principal, action and its words, amount (minor units, currency, display text), target (kind and ID), order number when seeded, ticket sender or null, claim words or null, decision (`allow`, `step_up`, `deny`), the reasons (code, words from the catalog, detail), the matched rule IDs, and a status:
  - allow: the execution outcome (`executed` with the refund or invoice ID and status, `failed`, `unknown`, `pending`), or `not_executable` when no execution was requested;
  - step-up: `open`, `approved` (with the execution outcome as above), `denied` or `expired`, as the step-up reader works them out at the request time;
  - deny: none.
- **Filters:** `decision` (one kind), `q` (case-insensitive substring of the order number, sender, target ID, intent ID or executed refund or invoice ID), `before` (a `seq` cursor) and `limit` (1 to 200, default 50). The answer also carries counts of all, allowed, stepped-up and denied rows for the current `q`, and the cursor for the next page or null.
- **An unreadable decision entry** is a row with `readable: false`, its `seq`, time, and one sentence naming the problem. It's counted under all only. It never stops the list.
- **Decision detail**, by the decision entry's `seq`: every row field, plus the intent hash and its canonical JSON, the mandate (ID, version, hash, and the `seq` of its `mandate.version` entry), today's usage as recorded, the safe reply hint (denials), `expires_at` (step-ups), the claims-vs-records pairs, the full trace (each entry with its words, result, value, detail and records), the ticket (channel, sender, subject, excerpt, received time, attachment IDs, thread ID, `simulated`) or null, the raw proposal text and its truncated flag, the entry's own `seq`, `at`, `hash` and `prev_hash`, and the intent's trail.
  - **The trail:** every entry whose ref is the intent ID, oldest first, each with `seq`, type, time, hash and its parts: an approval's answer, outcome, code and channel; a request's request ID, whether it's a replay, and the approval or decision it points at; a result's outcome, refund or invoice (ID and status) and PayPal's error (name, issues, debug ID); a reconciliation's source, the webhook event's ID and type, and the refund as re-read (ID, status, amount). An entry in the trail that can't be parsed shows its type, `seq` and problem.
  - Any `seq` that isn't a decision entry is not found. An unreadable one answers `readable: false` with its problem and its raw payload text.
- **By intent:** the newest decision entry's `seq` for an intent ID, or not found.
- **Entries:** every audit-log row, newest first, paged like the rows: `seq`, type, ref, time, hash, `prev_hash`, and one summary sentence per type ("Denied refund $96.00 on KIK-1039.", "Approved step-up 12.", "Asked PayPal to refund $240.00.", "PayPal refunded it: 4XJ12345 completed.", "Matched webhook WH-… to refund 4XJ12345.", "Mandate kikapu-studio version 3."). An unreadable payload's summary says it can't be read. Plus the total count.
- **Verify:** `verifyLog`'s verdict: intact or broken, the entry count, the head (`seq` and hash, or null for an empty log) and every problem (`seq`, code, detail).

### Evidence export (ADR 0034)

- `@countersign/ledger` builds the file from chosen rows: `format: "countersign-evidence-v1"`, `exported_at`, `scope` (`{ kind: "intent" | "capture", id }`), `chain` (intact, entry count, head, problem count, from a fresh `verifyLog`), `entries` (each row exactly as stored: `seq`, `entry_type`, `ref_id`, `at`, `payload` as its canonical text, `prev_hash`, `hash`, ascending by `seq`), and `check`, the sentence "Each entry's hash can be recomputed from its fields. Entries here aren't contiguous, so compare the head with ledger verify on the live log."
- `checkEvidence(file)` reads the file with zod and, for each entry, checks that the payload text is canonical JSON of itself and that the envelope `{ seq, entryType, refId, at, prevHash, payload }` hashes to `hash`; it also checks `seq`s are unique and ascending. It returns every problem by `seq`.
- `npm run ledger -- check-export <file>`: exit 0 with "Evidence intact: N entries, each matching its hash. The log's head at export was #S <hash>.", 1 with one line per problem, 2 for a file it can't read or parse.
- The gate selects the rows. **Intent scope:** every entry whose ref is the intent ID, plus the `mandate.version` entries its decisions point at. **Capture scope:** the same for every intent whose target is that capture, plus every reconciliation whose refund names the capture (unmatched ones included). Nothing selected is not found.

### The audit API on the gate

- `GET /audit/decisions` (filters as query parameters), `GET /audit/decisions/:seq`, `GET /audit/intents/:id` (`{ decision_seq }`), `GET /audit/entries` (`before`, `limit`), `GET /audit/verify`, `GET /audit/export?intent=<id>` or `?capture=<id>` (the file, as an attachment named `countersign-evidence-<intent|capture>-<id>.json`).
- Every route needs `Authorization: Bearer <COUNTERSIGN_APPROVER_KEY>`, checked as the approval API does and before anything is read; otherwise 401 with one sentence. A principal key never opens it.
- Query parameters and IDs are read with zod (strict: an unknown parameter is a 400). A bad parameter, or both or neither of `intent` and `capture`, is 400 with one sentence; an unknown `seq`, intent or empty export 404; no database or a database that can't be read 503. Answers never echo the request. JSON uses snake_case, as the approval API does.

### Approval cards

- Each card gains `claims`, the same pairs as the decision detail. `checks` stays and uses the shared "checks that decided" rule.

### The `audit` CLI

- `npm run audit -- show <seq> | export (--intent <id> | --capture <id>) [--out <file>] [--json] [--pglite <dir>]`, against the database the other CLIs use.
- `show` prints the decision line (action, amount, order, decision and its words with codes), then "What the message claims" and "What the records say" as pairs (verdict, claim, record words, detail, source, call and record ID), then the trail, one line each. `export` writes the evidence file (to `--out`, otherwise `countersign-evidence-<scope>-<id>.json` in the current directory) and prints its path and entry count; it never overwrites an existing file.
- Exit 0 on success, 1 when the chain at export was broken (the file is still written, and says so), 2 when it can't run (no database, an unknown `seq`, nothing to export, a bad argument, an existing file).

### The console

Every screen follows `Graphite Design/DESIGN.md` and the brand book, semantic tokens only, Lucide icons, no emojis, light and dark, desktop and phone widths. Reason codes always show as words with the code beside them in inline code (ADR 0018).

- **Sign-in.** Decisions, a decision and the audit log need the approvals sign-in cookie. Without it they show the shared sign-in (moved out of the approvals board, used by all four pages) with the line "Sign in with the approver key to see decisions." A gate 401 clears the cookie and shows the sign-in with "Sign in again."
- **Sidebar.** Gains Decisions and Audit log after Approvals. `/` redirects to `/decisions`.
- **Decisions (`/decisions`).** Title "Decisions", subtitle "Every money action your agents proposed, and what the records said." A chain card: "Chain intact" (positive badge) with "N entries, checked at <time>", or "Chain broken" (danger badge) with the problem count and a link to the audit log. A segmented control All / Allowed / Step-up / Denied with counts. A search field, "Order, sender or ID". A Graphite table: When, Ticket (sender, and the claim in words under it), Action, Amount (`gr-num`), Decision (badge: Allowed positive, Step-up warning, Denied danger), Why (first reason's words with its code; for an allow, "Allowed by rule <rule ID>"), Status (as below), Record (executed refund or invoice ID, otherwise the target ID, in mono). Each row links to its decision. "Older decisions" pages back. An unreadable row says "This entry can't be read." in the Why column. An empty log says "No decisions yet. They appear here when an agent proposes a money action." The table scrolls inside its box at phone width.
  - Status words: "Refunded" / "Invoice sent" (executed), "PayPal refused it", "Not confirmed yet" (unknown or pending), "Can't run yet" (not executable), "Waiting for you" (open, linking to `/approvals`), "Approved" plus the execution words, "Denied by you", "Expired, so denied"; nothing for a deny.
- **A decision (`/decisions/[seq]`).** Breadcrumb Decisions / "<action words> on <order number or target ID>". Title "<action words> <amount> on <order or target>" with the decision badge, and a line "Proposed by <principal> from <sender>'s ticket at <time>." ending with "No money moved." when nothing executed, or "PayPal refunded it." / "The invoice was sent." when it did. "Open ticket" links to `/inbox?thread=<thread ID>` when there is a ticket.
  - **Claims vs records**: a table, "What the message claims" | "What the records say" | "Result". The record cell shows the record words and detail, then the source in words and the record ID in mono. Result badges: Matches positive, Contradicts danger, Passes positive, Fails danger, No record and Not used neutral. At phone width each pair stacks.
  - **How the gate decided**: every trace entry: verifier words with the verifier name in mono under them, the records it read (call and ID), the result (Pass, Fail, Unknown).
  - **Why it was <allowed | held | denied>**: each reason's words with its code, or for an allow the matched rules.
  - **Suggested reply** (denials only): the safe reply hint, with "Only repeats what the records say" and a "Copy reply" button.
  - **What happened**: the trail, one line each with its time ("Approved by you on the approvals page.", "Asked PayPal to refund $240.00.", "PayPal refunded it: 4XJ12345, completed.", "PayPal refused it: <error name>.", "Matched webhook <event ID>."), with each sandbox ID in mono. A step-up still open says "Waiting for you" with a link to `/approvals`.
  - **Audit entry <seq>**: the chain badge from a fresh verify, the intent hash, the entry's hash and previous hash (mono, truncated with the full value in a tooltip), the mandate ID and version, and "Check the chain" linking to `/audit`.
  - **Export evidence** downloads the intent-scoped file; for a capture target, "Export evidence for this payment" downloads the capture-scoped file.
  - An unreadable entry shows "This entry can't be read." with the problem and the raw payload text in a code block.
- **By intent (`/decisions/intent/[id]`).** Redirects to the intent's newest decision; an unknown intent shows "There's no decision for that intent." with a link to Decisions.
- **Audit log (`/audit`).** Title "Audit log", subtitle "Every entry, hash-chained. Each one's hash covers the one before it." A "Check the chain" button that runs verify and shows "Chain intact: N entries. Head #S <hash>." or "Chain broken: N problems." with one line per problem (`#seq`, code, detail). A Graphite table: Seq, When, Type, Summary, Ref (mono), Hash (mono, truncated, full value in a tooltip). Decision rows link to their decision page. "Older entries" pages back.
- **Approvals.** Each card shows "What the message claims" and "What the records say" from `claims` in place of its current "What the records say" list: two columns on desktop, stacked pairs on a phone, with the verdict badge.
- **Inbox.** Each guarded call with an intent ID links "Claims vs records" to `/decisions/intent/<intent ID>`. A call whose proposal never became an intent shows no link.
- **Server routes.** `GET /api/audit/decisions`, `GET /api/audit/decisions/[seq]`, `GET /api/audit/intents/[id]`, `GET /api/audit/entries`, `GET /api/audit/verify`, `GET /api/audit/export`. They call the gate at `GATE_URL` with the cookie's key as the bearer, validate the request and every answer with zod, and pass on only what the schemas allow; the export passes the file through with its attachment header after checking its `format`. Missing cookie, gate 401, gate unreachable and junk answers behave as the approval routes do (401 "Sign in with the approver key.", 401 "Sign in again." and a cleared cookie, 502 "The gate isn't reachable. Start it, then try again.").

## Constraints

- No AI anywhere in this phase, and none in `packages/mandate`, `packages/verifiers` or `packages/ledger`. The claims-vs-records module is never imported by the decision path (`decide`, the verifiers or the evaluator); a test pins it.
- Read-only: nothing in this phase appends to the audit log or writes any table. A test runs every reader and API route and checks the log's head is unchanged.
- Never re-hash parsed payloads; exports carry the stored canonical text.
- Fail closed in what's shown: an unknown check is "No record", never "Matches"; an unreadable entry is shown as unreadable, never skipped or guessed at; the chain badge comes only from a verdict, never assumed.
- Validate every external input with zod 4: API query parameters and IDs, env, cookies, every gate answer the console reads, CLI arguments, the evidence file.
- Money is integer minor units; display text comes from `formatMoney`.
- Never log, store or show a secret: no approver key, principal key, PayPal token or `DATABASE_URL` in API answers, exports, CLI output, console HTML or logs. Merchant-only pages show emails in full (ADR 0020).
- Copy follows the brand book: plain, short, no exclamation marks, pluralised counts. The carrier and simulated tickets stay labelled simulated.

## Technical needs

- `@countersign/ledger` exports the evidence builder, `checkEvidence` and the evidence schema; its CLI gains `check-export` (usage line updated).
- The gate's API module mounts beside the approval API and shares its approver check.
- Root `package.json` gains `"audit": "tsx --env-file-if-exists=.env.local apps/gate/src/audit-main.ts"`.
- No new env: the gate already reads `COUNTERSIGN_APPROVER_KEY`, the console `GATE_URL`.
- No live checks: this phase calls no external service. Its checks against real sandbox data are manual (validation.md).
