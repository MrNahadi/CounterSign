# 0032. A step-up is its decision entry; the merchant answers it with an approver key, never a principal key; every answer is an `approval` entry, and an approval executes the stored intent, never a re-decided one

Status: accepted
Decided-by: autopilot (delegated), phase 9 feature spec, 21 Oct 2026, under brief §14 v1.4. The answerer's rules escalate it, because it's a stored audit-log format, a service API and an authentication scheme, all expensive to reverse. The planner session had no way to start the answerer agent, so it applied the answerer's rules itself. Decided by brief §10 trade-offs 1 (fail-closed money safety), 3 (the judge path works every time) and 4 (a stranger understands it). The owner can overturn it (`.ralph/human.md`, Decided for you)
Question: Phase 9 lets the merchant approve or deny a held intent with one tap on their phone. What identifies a held intent, who may answer it and how they prove it, what the audit log records, what exactly executes after an approval, and what happens to a re-proposed, expired or doubly answered step-up?
Decision:
- **A step-up is its decision entry.** Every `decision` entry whose record says `step_up` and has an intent is a step-up, identified by the entry's `seq` (shown as its step-up ID). No new table: the audit log already holds the intent, its hash, its canonical JSON, the trace, the reasons and the agent response with `expires_at` (decision time plus 15 minutes, `APPROVAL_WINDOW_MS`).
- **States, worked out from the log and the clock, never stored:**
  - *answered*: an `approval` entry with outcome `approved` or `denied` for the same intent comes after the step-up (higher `seq`). One answer closes every earlier step-up of that intent;
  - *expired*: not answered, and the time is past `expires_at`. Expired means denied (brief §8); nothing executes and no entry is needed;
  - *open*: neither.
  The approvals list shows one card per intent: its newest open step-up. An agent that proposes the same intent again gets a new step-up (it's decided again, as every non-replay proposal is), and the card simply moves to the newer one.
- **The approver key.** The gate's approval API takes `Authorization: Bearer <COUNTERSIGN_APPROVER_KEY>`. As with principal keys, a value under 32 characters counts as unset, and then every approval call answers 401. A value equal to any principal key also counts as unset, so no agent can ever answer its own step-up. Keys are compared in constant time. Principal keys are never accepted on the approval API, and the approver key is never accepted on `/mcp`.
- **The approver login.** The console's approvals page asks for the approver key once (the judge guide's "approver login"). The console's server route checks it against the gate and keeps it in an `HttpOnly`, `SameSite=Strict` cookie (`Secure` over HTTPS) for 12 hours; its server routes forward it to the gate. The console never reads the key from its own environment and never sends it to the browser's JavaScript.
- **The `approval` entry type,** ref the intent ID, payload: the step-up's `seq`, the intent hash the approver was shown and sent back, the answer (`approve` or `deny`), the outcome (`approved`, `denied` or `rejected`), for `rejected` one code, the approver (`merchant`, the one approver while there's one merchant, brief §5 Out of scope) and the channel (`approvals_page` or `cli`). Rejection codes, checked in this order:
  1. `HASH_MISMATCH`: the hash sent back isn't the step-up's intent hash, or the stored intent no longer hashes to it;
  2. `ALREADY_ANSWERED`: the step-up is answered;
  3. `EXPIRED`: the step-up has expired;
  4. `ALREADY_REQUESTED` (approve only): the intent already has an `execution.requested` entry;
  5. `ACTION_UNAVAILABLE` (approve only): the gate can't carry out the action yet (disputes until phase 11, payouts until phase 12, order capture);
  6. `DUPLICATE_REFUND` (approve only, refunds): the execution history can't be read, or another intent has executed on the same capture since.
  A rejected answer leaves the step-up as it was. A request naming a `seq` that isn't a step-up answers 404 and writes nothing. An unauthenticated request writes nothing.
- **What executes is the stored intent.** An approval never re-reads live records or re-decides: the merchant approved exactly the intent on the card, and its hash binds it. The checks, the `approval` entry and, for an approved answer, the `execution.requested` entry (pointing at the approval's `seq` instead of a decision's) are written in one audit-log transaction under the ledger's lock. The rail call happens after it commits and its result is appended afterwards, exactly as an allowed intent (ADR 0026).
- **Denials go nowhere else.** The agent isn't called back. Resolve's inbox reads the `approval` and execution entries (read-only, as it already reads results) to show what happened to a held call.
Basis:
- Brief §5 item 3 ("approve or deny a held action with one tap on their phone, and only that exact intent executes. Approvals are hash-bound, single-use and expire after 15 minutes; an unanswered card means deny"), §8 ("What you approve is what executes", "An expired approval means deny", "The agent never holds PayPal or Daraja credentials"), §12 ("an approval for a changed amount is rejected"; the judge guide's "approver login").
- Original brief §12: "Approvals: single-use, 15-minute expiry, bound to the intent hash. Expiry means deny"; its `approvals` table (intent ID, intent hash, approver, decision, channel, at), held here as audit-log entries instead.
- ADR 0022 (later phases add their own entry types), ADR 0026 ("Phase 9's approved executions write the same two entries, with the approval's `seq` in place of the decision's"), ADR 0028 (principal keys).
Consequences:
- `ledger verify` learns `approval`. Its payload can only grow by a new type, never an edit of old rows.
- Anyone with the approver key can approve. On the hosted demo it's a sandbox-only judge credential (brief §8), named in the judge guide in phase 13.
- Web push stays a bonus (brief §15 decided 3); the judge path is the QR code plus the console's live card.
- A deny can't be taken back; the agent must propose again, which makes a new card.
