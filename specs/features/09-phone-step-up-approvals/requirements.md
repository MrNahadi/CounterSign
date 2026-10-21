# Phase 9 requirements: phone step-up approvals

Brief §5 item 3, §6 (step 5's STEP_UP), §8 (fail closed; what you approve is what executes; an expired approval means deny; credential custody; Graphite), §11 (40px primary buttons on the phone approvals page, 24px hit targets), §12 (an approval for a changed amount is rejected; the judge guide's approver login). Decisions: ADRs 0032 and 0033, applying 0018, 0022, 0026, 0027 and 0028. Design baseline: original brief §5 (approvals), §11 (the approvals screen) and §12 (approvals security). Where this file and the brief disagree, the brief wins.

## Behaviour

### Step-ups and their states (ADR 0032)

- A step-up is a `decision` entry whose record's decision is `step_up` and whose intent isn't null. Its ID is the entry's `seq`. Its expiry is the agent response's `expires_at`.
- A step-up is *answered* when an `approval` entry with outcome `approved` or `denied` for the same intent ID has a higher `seq`; *expired* when not answered and the clock is past `expires_at`; otherwise *open*. States are worked out on every read, never stored.
- The open list holds one card per intent, its newest open step-up, newest first. The recent list holds the last 20 answered or expired step-ups, newest first, each with its outcome and, for an approved one, its execution outcome and PayPal record (refund ID and status, or invoice ID and status).
- An entry the step-up reader can't parse makes the whole read unknown: the API answers 503 with one sentence and nothing can be approved. It never skips the entry.

### Answering a step-up

`answerStepUp({ db, rail, stepUpSeq, answer, intentHash, channel, now, clock })`, one audit-log transaction under the ledger's lock:

1. Read the step-up. Not a step-up (no such `seq`, another entry type, a decision other than `step_up`, or no intent): `not_found`, nothing written.
2. Check, in this order, stopping at the first that fails, and write one `approval` entry with outcome `rejected` and that code: `HASH_MISMATCH` (the sent hash isn't the stored intent hash, or `hashIntent` of the stored intent differs from it), `ALREADY_ANSWERED`, `EXPIRED`, then for `approve` only `ALREADY_REQUESTED` (an `execution.requested` entry exists for the intent ID), `ACTION_UNAVAILABLE` (the action has no executor), `DUPLICATE_REFUND` (a refund whose capture has another counted execution in the history, or the history can't be read).
3. Otherwise write the `approval` entry with outcome `denied` (for `deny`) or `approved` (for `approve`). An approved entry is followed, in the same transaction, by `execution.requested` with `approvalSeq` and the intent's target (ADR 0033).
4. After commit, an approved intent runs through its action's executor and the result is appended as `execution.result`, exactly as an allowed intent. The rail call uses only the stored intent: a refund's capture, amount and `PayPal-Request-Id` (the intent hash); an invoice's ID and hashed parameters.
5. The answer returns the outcome, the code for a rejection, the `approval` entry's `seq`, and for an approved intent the execution (outcome, refund or invoice record, PayPal's error name and issues on a refusal).

- A deny or a rejection makes no rail call. Unknown answers (anything but `approve` or `deny`) are input errors, never written.
- An `approval` entry's payload: `stepUpSeq`, `intentHash` (as sent), `answer`, `outcome`, `code` (rejected only), `approver: "merchant"`, `channel` (`approvals_page` or `cli`). Its `at` is the answer time; its ref is the intent ID.
- An intent approved once can never be requested again by an approval. A refund intent later re-proposed by the agent is answered as a replay (ADR 0026), never decided again.

### Executors (ADR 0033)

- `paypal.refund`: phase 6's refund call, request ID the intent hash, outcomes as ADR 0026.
- `paypal.invoice.send`: `POST /v2/invoicing/invoices/{id}/send` with `{ send_to_invoicer: true, send_to_recipient, note?, additional_recipients? }` from the intent's hashed parameters (absent values left out), no `PayPal-Request-Id`, never retried. 200 is `executed` with status `SENT`, 202 `executed` with `SCHEDULED`, a 4xx `failed` with PayPal's error name and issues, anything else `unknown`. An invoice intent is never re-sent.
- `EXECUTABLE_ACTIONS` is exactly `paypal.refund` and `paypal.invoice.send`. An allowed invoice send (a mandate that allows it) executes through `propose`, once.

### The approval API on the gate

- `GET /approvals`: `{ open: [card], recent: [summary] }`. `GET /approvals/:id`: one card with its state, or 404. `POST /approvals/:id` with `{ answer: "approve" | "deny", intent_hash }` (strict): 200 with the answer, 404 for `not_found`, 400 with one sentence for a bad body. A rejected answer is still a 200 whose outcome says `rejected` and why.
- Every route needs `Authorization: Bearer <COUNTERSIGN_APPROVER_KEY>`, compared in constant time; without it, 401 with one sentence and nothing written. The key counts as unset under 32 characters or when it equals any principal key; then every route answers 401, and the gate's startup line names the variable (never its value). A principal key is never accepted here, and the approver key is never accepted on `/mcp`.
- A card: step-up ID, intent ID and hash, principal, action in words ("Refund", "Send invoice", "Accept dispute claim", …), amount (minor units, currency and display text such as `$240.00`), target (capture, invoice, dispute, order or payee ID), the seeded order number when the target's order is in `seed_orders`, the ticket (channel, sender, subject, the body's first 280 characters, received time, attachment IDs, `simulated`) or null, the claim, the reasons (code, words from the catalog, detail), the checks (each verifier the matched rules use: name, result, value where it has one, source call and record ID), decided time, `expires_at`, the state, and `can_execute` (false for an action without an executor, with the sentence "Countersign can't carry out this action yet.").
- Bodies are read with zod; the body limit is 16 KB. Errors never echo the request.

### The `approvals` CLI

- `npm run approvals -- list | show <id> | approve <id> --hash <intent hash> | deny <id> [--json] [--pglite <dir>]`, against the database the other CLIs use, channel `cli`. `list` prints the open cards (ID, action, amount, order, reasons in words with codes, time left) and the recent answers; `show` prints one card; `approve` and `deny` print the outcome in one sentence and, for an execution, the refund or invoice ID.
- Exit 0 when the answer was `approved` or `denied` (or the list printed), 1 when it was `rejected` or the execution failed, 2 when it can't run (no database, missing PayPal variables for an approval, an unknown ID). Missing variables are named, never shown.

### The console

Every screen follows `Graphite Design/DESIGN.md` and the brand book, semantic tokens only, Lucide icons, no emojis, light and dark, desktop and phone widths.

- **Approvals (`/approvals`).** Phone first, and the same page on desktop inside the console shell (sidebar gains "Approvals" with a count badge of open cards).
  - Without the login cookie: one field, "Approver key", and a "Sign in" button. A wrong key says "That key isn't right." and sets nothing.
  - Open cards, newest first. Each card: the action and amount as its title (`Refund $240.00`), the order number and customer sender, the claim, the photo thumbnails (through the existing attachment route), "Why it's waiting" (each reason's words with its code beside it in inline code, ADR 0018), "What the records say" (each check as one line: verifier in words, result, value, and the record ID in inline code), the time left ("Expires in 12 min", then "Expired"), and two 40px buttons, Approve (primary) and Deny. A card that can't execute shows the sentence above and only Deny.
  - One tap answers, sending the hash shown on the card. Then the card shows the outcome in one sentence: "Approved. Refund 4XJ… is done.", "Approved. Invoice INV2-… is sent.", "Approved, but PayPal refused it: …", "Approved. PayPal hasn't confirmed it yet.", "Denied. Nothing was sent.", or a rejection: "This card changed. Nothing was sent." (`HASH_MISMATCH`), "This was already answered." , "This card expired, so it counts as denied.", "This was already carried out.", "Countersign can't carry out this action yet.", "Another refund already went to this payment."
  - Below: "Recent" answers and expiries, one line each.
  - The page polls every 3 seconds while open, so a new card appears without a reload (the console's live card).
  - "Sign out" clears the cookie.
- **Open on your phone.** On widths of 768px and up, the approvals page shows a QR code of the approvals URL with the line "Scan to approve from your phone." The URL is `CONSOLE_PUBLIC_URL` plus `/approvals` when set, otherwise the request's own origin. The QR is drawn as SVG from `uqr`'s module matrix using token classes (foreground modules on a container background, with its quiet zone).
- **Installable.** A web app manifest (`name` "Countersign approvals", `short_name` "Approvals", `start_url` `/approvals`, `display` `standalone`). No colour values in it.
- **Server routes.** `GET /api/approvals`, `GET /api/approvals/[id]`, `POST /api/approvals/[id]`, `POST /api/approvals/session` (sign in: checks the key with `GET /approvals` on the gate, then sets the cookie), `DELETE /api/approvals/session` (sign out). They call the gate at `GATE_URL` (default `http://127.0.0.1:8787`) with the cookie's key as the bearer, validate the request and every answer with zod, and pass on nothing else. A gate 401 clears the cookie and answers 401 "Sign in again." A gate that can't be reached or answers junk gives 502 "The gate isn't reachable. Start it, then try again."
- **Cookie.** `countersign_approver`, `HttpOnly`, `SameSite=Strict`, `Path=/`, `Max-Age` 12 hours, `Secure` when the request is HTTPS. Never readable by client code.
- **Inbox.** A guarded call that answered "Waiting for approval" now shows what happened since: "Approved by you" with the refund or invoice ID, "Denied by you", "Expired, so denied", or still "Waiting for approval".

## Constraints

- No AI in `packages/mandate`, `packages/verifiers` or `packages/ledger`, and none in approvals: no model call anywhere on the approval path.
- Fail closed: every failed check rejects; an unreadable log rejects or answers 503; an expired step-up never executes; nothing executes on an answer the gate didn't write as `approved` first.
- What executes is the stored intent, bound by its hash. A changed amount, target, note or recipient is a different hash and is rejected `HASH_MISMATCH`.
- Single use: at most one `execution.requested` per intent from approvals, whatever the number of taps, tabs or step-ups.
- Never hold the ledger lock across a network call.
- Validate every external input with zod 4: API bodies and params, env, cookies, every gate answer the console reads, CLI arguments.
- Money is integer minor units; PayPal's `{ value, currency_code }` appears only inside the rail client.
- Never log, store or show a secret: no approver key, principal key, PayPal token or `DATABASE_URL` in entries, API answers, CLI output, console HTML or logs.
- Copy follows the brand book: plain, short, no exclamation marks, pluralised counts. Simulated parts and illustrative people stay labelled.

## Technical needs

- Env for the gate: `COUNTERSIGN_APPROVER_KEY`. For the console (server only): `GATE_URL`, `CONSOLE_PUBLIC_URL` (optional).
- `@countersign/ledger`'s `ENTRY_TYPES` gains `approval`; `ledger verify` and `tail` read it.
- `execution.requested` gains the approved shape and `target`; `execution.result` gains `invoice`. Every reader (history, intent record, reconciliation state, Resolve's execution read) accepts both old and new entries.
- The gate's fake sandbox gains invoice send (200, 202, 4xx and a network failure on demand) and records each call.
- Root `package.json` gains `"approvals": "tsx --env-file-if-exists=.env.local apps/gate/src/approvals-main.ts"`.
- Live checks run only under `LIVE=1` and aren't in the Feedback commands.
