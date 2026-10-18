# 0026. Executions are logged as a request before the rail call and a result after it; anything not definitely refused counts as executed; replays re-send only the same request ID

Status: accepted
Decided-by: autopilot (delegated), phase 6 feature spec, 18 Oct 2026, under brief §14 v1.4. The answerer's rules escalate it, because a stored audit-log format is expensive to reverse. Decided by brief §10 trade-off 1 (fail-closed money safety). The owner can overturn it (`.ralph/human.md`, Decided for you)
Question: Phase 6 executes allowed refunds on PayPal exactly once, even on replay, and reconciles them from `PAYMENT.CAPTURE.REFUNDED`. What does the audit log record for an execution, what counts as "already executed" for `ledger.not_duplicate` and today's usage, and what happens when the same intent is proposed again, or two intents on one capture arrive together?
Decision:
- **Three new entry types** (ADR 0022's rule that later phases add their own):
  - `execution.requested`, ref the intent ID: the intent ID and hash, principal, rail, action, capture ID, amount, the rail request ID (the intent hash), the `seq` of the decision entry that allowed it (or of the first request it replays), and for a replay the raw proposal text. Written **before** the rail call.
  - `execution.result`, ref the intent ID: the `seq` of its request, the outcome (`executed`, `failed` or `unknown`), the refund ID and status when PayPal returned one, PayPal's error name, issue codes and debug ID when it refused, and the time.
  - `reconciliation`, ref the intent ID, or null for a refund Countersign didn't make: the source (`webhook` or `poll`), the webhook event ID and type (for `webhook`), the refund ID, capture ID, status and amount as re-read from PayPal, and the `seq` of the matched result.
- **One transaction decides.** Reading the execution history, deciding, writing the decision entry and, on allow, the `execution.requested` entry happen in one audit-log transaction under the ledger's advisory lock. The rail call happens after it commits, and the result is appended in its own transaction. A second intent on the same capture therefore always sees the first one's request, even while its rail call is in flight.
- **What counts as executed.** An `execution.requested` entry counts as an execution, for `ledger.not_duplicate` and today's usage, unless a later `execution.result` for it says `failed`. A request with no result yet, or an `unknown` result, counts. Its amount and time are the request's.
- **Outcomes.** A refund PayPal returns as `COMPLETED` or `PENDING` is `executed`; `FAILED` or `CANCELLED` is `failed`. An HTTP 4xx refusal is `failed`. A network error, a 5xx after the client's retries, or a response that doesn't parse is `unknown`, because the money may have moved.
- **Replays.** Before deciding, the gate normalizes the proposal. If its intent ID already has an `execution.requested` entry, it isn't decided again:
  - if a result for it says `executed`, no rail call is made; the agent gets the same `allowed` response, and nothing new is written but an `execution.requested` entry marked as a replay, so every proposal stays in the log;
  - otherwise (no result, `unknown` or `failed`), it's re-sent with the same `PayPal-Request-Id`, but only within 6 hours of the first request, the shortest replay window we rely on. After that nothing is sent and the operator is told to check the refund (`npm run reconcile`).
- **Unmatched refunds.** A verified `PAYMENT.CAPTURE.REFUNDED` for a refund no `execution.result` names (one made in the dashboard, say) is still logged, as a `reconciliation` with a null ref, because money moved outside the gate.
Basis:
- Brief §5 item 2 ("executes exactly once on the sandbox, and replays never pay twice. The audit log reconciles the action when the webhook or callback arrives"), §8 (fail closed; what you approve is what executes), §10 trade-offs 1 and 2.
- ADR 0003 (intent hash as `PayPal-Request-Id`, advisory lock), ADR 0019 ("replays of the same intent are answered before deciding, in phase 6"), ADR 0022 (entry format), ADR 0025 (refund and reconciliation calls).
- `docs/spikes.md` S1 and S5: replaying the request ID returns the original refund with HTTP 200.
Consequences:
- A crash between the request and the result leaves a request that blocks any other refund on that capture until it's reconciled or replayed. That's the fail-closed side.
- Phase 9's approved executions write the same two entries, with the approval's `seq` in place of the decision's.
- `ledger verify` learns the three types. Changing their payloads later needs a new type, never an edit of old rows.
