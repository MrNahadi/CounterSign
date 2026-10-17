# Phase 3 requirements: decide a refund from records

Brief §5 item 1, §6 (rule evaluation), §8 (fail closed, no AI), §11 (tests). Design baseline: original brief §6 to §9. Shapes and placement: ADR 0019. Where this file and the brief disagree, the brief wins.

## Behaviour

### Proposals become intents

- A proposal is the agent's request: a tool name, PayPal-shaped arguments, and a justification with a ticket ID and an optional claim. Phase 3 normalizes one tool, `create_refund`. Its arguments are a capture ID, an optional amount as `{ value, currency_code }`, and an optional note.
- A normalized intent holds:
  - the principal, rail `paypal` and action `paypal.refund`;
  - the amount in integer minor units, and the currency;
  - the target: the capture ID, plus the order ID from the capture's record;
  - the ticket ID and the claim.
- Money parsing is strict. USD and KES only, at most two decimals, no sign, no exponent, no thousands separators, and greater than zero. Anything else makes the proposal invalid.
- A proposal with no amount means "refund what's left". The intent's amount is then the capture's remaining refundable amount, read from the capture record, so the intent always states the exact amount that would execute. If that record is missing, the proposal is invalid.
- An invalid proposal is denied with `INVALID_PROPOSAL`, never thrown as an error. A tool name the gate doesn't know is denied with `UNKNOWN_ACTION`.
- The intent hash is SHA-256 over the canonical JSON (RFC 8785) of the principal, rail, action, amount, currency, capture ID and ticket ID. The order ID, claim and mandate version are kept with the intent but not hashed (ADRs 0019 and 0020). The hash comes back with the exact canonical JSON it covers, and the decision record stores that JSON. The intent ID is `int_` followed by the first 24 hex characters of the hash.

### Verifiers derive facts from records

- Each verifier is a pure function over record snapshots and the intent. It returns `pass`, `fail` or `unknown`, plus the record it read: the call it came from, and that record's ID. A missing record is `unknown`, never `pass`.
- For a `paypal.refund` intent, every verifier below runs, whatever the rules need, so the trace is complete:

| Verifier | Pass | Fail | Unknown | Record it reads |
|---|---|---|---|---|
| `capture.refundable` | The capture is `COMPLETED` or `PARTIALLY_REFUNDED`, its currency matches the intent, and the amount ≤ captured − already refunded | Any other status, another currency, or too much asked for | No capture record | `GET /v2/payments/captures/{id}` |
| `ticket.from_payer` | The ticket's sender email equals the order's payer email, ignoring case and outer spaces | The emails differ | No capture record linking the intent's capture to its order, no payer email on the order, or no sender email on the ticket | `GET /v2/checkout/orders/{id}` and the ticket |
| `dispute.none_open` | The disputes lookup ran and finds no open dispute on the capture | An open dispute on the capture (any status except `RESOLVED`) | The disputes lookup didn't run | `GET /v1/customer/disputes` |
| `shipment.status` | Pass, with the value `lost`, `stalled_10d`, `in_transit` or `delivered`, for the tracking number on the order's live `SHIPPED` tracker for the capture | Never fails | No capture record linking the capture to its order, no such tracker, several trackers whose carrier statuses disagree (ADR 0020), or no carrier record for the tracking number | The order's trackers and the carrier |
| `evidence.photo_present` | The ticket has an image attachment | No image attachment | No ticket record | The ticket |
| `ledger.not_duplicate` | No earlier execution targets the same capture | An earlier execution targets it. A second partial refund is denied by design (ADR 0020) | No execution history given | The audit log |

- Every other verifier name in the schema (the M-Pesa verifiers, `payee.allowlisted`, `ledger.velocity`) returns `unknown` until its phase builds it.
- Today's usage, for limits, is the count and total of executed money actions for the principal in each currency, on today's calendar date in the mandate's time zone. Usage is unknown, which escalates an allow to step-up (`DAILY_LIMIT_UNKNOWN`), when:
  - the execution history is missing;
  - an execution of the principal's is malformed;
  - a total would leave the safe-integer range.

### Rules decide

Rule evaluation follows brief §6 exactly:

1. Find the rules for the intent's action whose `when` matches. `when` can test:
   - the claim, against one value;
   - `shipment.status`, against a list of values, where an unknown status never matches;
   - the rail.

   A rule with no `when` matches every intent for its action. A rule with a `max` only matches intents in the `max`'s currency.
2. If any `require` on a matched rule isn't `pass`, that rule's outcome is **deny**, with one reason per failed or unknown requirement.
3. Otherwise the rule's `decide` applies. These escalate an allow to **step-up**:
   - an amount above the rule's `max` (`ABOVE_AUTO_LIMIT`);
   - an intent that would push today's total or count past the mandate's limit for its currency (`DAILY_LIMIT_REACHED`);
   - an intent in a currency the mandate sets no limit for (`NO_DAILY_LIMIT`, ADR 0020).
4. If several rules match, the most restrictive outcome wins: deny over step-up over allow. The reasons come from the winning outcome's rules.
5. If no rule matches, the mandate's fallback applies. The fallback is always deny (`NO_MATCHING_RULE`). If a rule failed to match only because a verified `when` fact was unknown, the matching unknown code (such as `SHIPMENT_STATUS_UNKNOWN`) comes after it.
6. An unknown action is always denied (`UNKNOWN_ACTION`). So is an intent whose principal isn't the mandate's principal (`WRONG_MANDATE`).

**Allow is only possible through a matched rule whose `decide` is allow and whose requirements all passed, with no escalation.** No other path produces it.

### Reason codes

Each code has stable words for the merchant and, for denials, a reply hint the agent can safely use with the customer. Codes never change once used. Rule reasons (`SHIPMENT_DELIVERED`, `ALWAYS_NEEDS_APPROVAL`, `RULE_DENIES`) are the only codes a mandate rule may name. A deny rule may name only the two that have a reply hint (`SHIPMENT_DELIVERED`, `RULE_DENIES`), so every denial has one. A step-up rule may name only the two whose words fit a hold (`SHIPMENT_DELIVERED`, `ALWAYS_NEEDS_APPROVAL`). A rule reason's detail uses a verb that matches the rule's decision ("asks you first" or "denies"). `SHIPMENT_DELIVERED` claims a delivery only when the carrier's reading says delivered; otherwise its detail gives the actual reading.

| Code | Raised when | Words for the merchant | Safe reply hint |
|---|---|---|---|
| `TICKET_NOT_FROM_PAYER` | `ticket.from_payer` fails | The ticket didn't come from the person who paid. | Refunds go only to the customer who placed the order. Ask them to write from the email address they paid with. |
| `PAYER_UNKNOWN` | `ticket.from_payer` is unknown | There's no payer email to check the sender against. | We can't match this request to the order's payer. Ask them to write from the email address they paid with. |
| `CAPTURE_NOT_REFUNDABLE` | `capture.refundable` fails | The payment can't be refunded for this amount. | This order can't be refunded for that amount. Offer to check the order details with them. |
| `CAPTURE_UNKNOWN` | `capture.refundable` is unknown | There's no payment record for this refund. | We couldn't find the payment for this order. Ask them to confirm the order number. |
| `DISPUTE_OPEN` | `dispute.none_open` fails | The payment has an open PayPal dispute. | This order has an open PayPal case, and it will be resolved there. |
| `DISPUTES_UNKNOWN` | `dispute.none_open` is unknown | Countersign couldn't check for open disputes. | We need to check this order before refunding. Tell them we'll follow up. |
| `SHIPMENT_STATUS_UNKNOWN` | `shipment.status` is unknown and a rule for the action tests it, in `require` or beside `NO_MATCHING_RULE` when no rule matched because of it | There's no carrier record for this order. | We couldn't find tracking for this order. Tell them we'll check with the carrier. |
| `NO_PHOTO_EVIDENCE` | `evidence.photo_present` fails | The damage claim has no photo. | Ask them for a photo of the damage. |
| `TICKET_UNKNOWN` | `evidence.photo_present` is unknown | There's no ticket record for this claim. | We need the original message to look into this. Ask them to write in again. |
| `DUPLICATE_REFUND` | `ledger.not_duplicate` fails | This payment was already refunded once. | This order has already been refunded. |
| `HISTORY_UNKNOWN` | `ledger.not_duplicate` is unknown | Countersign couldn't check earlier refunds. | We need to check this order before refunding. Tell them we'll follow up. |
| `VERIFIER_UNAVAILABLE` | A required verifier that isn't built yet returns unknown | Countersign can't check this yet. | We need to check this request before acting on it. Tell them we'll follow up. |
| `ABOVE_AUTO_LIMIT` | The amount is above the rule's `max` | It's over your auto-refund cap. | None (step-up only) |
| `DAILY_LIMIT_REACHED` | The intent would pass a daily limit | It would pass your daily refund limit. | None (step-up only) |
| `DAILY_LIMIT_UNKNOWN` | Today's usage is unknown | Countersign couldn't count today's refunds. | None (step-up only) |
| `NO_DAILY_LIMIT` | The mandate sets no daily limit for the intent's currency | Your rules set no daily limit for this currency. | None (step-up only) |
| `SHIPMENT_DELIVERED` | Rule reason | The carrier shows the parcel delivered. | Our carrier shows this order as delivered. Suggest they check with neighbours or their building's front desk. |
| `ALWAYS_NEEDS_APPROVAL` | Rule reason | Your rules always ask you first for this. | None (step-up only) |
| `RULE_DENIES` | Rule reason | Your rules don't allow this. | We can't do that for this order. |
| `NO_MATCHING_RULE` | Fallback | No rule in your mandate allows this. | We can't do that automatically. Tell them the team will look at it. |
| `UNKNOWN_ACTION` | Unknown action | Countersign doesn't know this action. | We can't do that. Tell them the team will look at it. |
| `WRONG_MANDATE` | Principal mismatch | This agent isn't covered by this mandate. | We can't do that. Tell them the team will look at it. |
| `INVALID_PROPOSAL` | Normalization fails | The proposal was incomplete or malformed. | We need a few more details. Ask them to confirm the order number and amount. |

Each reason in a decision carries a `detail` with the specifics, such as "$96.00 is over the $80.00 cap in rule refund-lost-parcel" or "Sender grace.w@example.com, payer sb-87z5x@personal.example.com". Rule reasons state the facts behind them as well as the rule:
- `SHIPMENT_DELIVERED` names the carrier status and the tracking number;
- `ALWAYS_NEEDS_APPROVAL` names the action;
- `RULE_DENIES` names what the rule matched.

Details show emails in full, because the CLI and the decision record are merchant-only. Public pages mask them (ADR 0020, phase 15). A detail never contains a credential or a full token. The decision's safe reply hint is the hint of its first reason that has one, falling back to `NO_MATCHING_RULE`'s.

### What the agent and the CLI get

- The agent response follows original brief §6:
  - `allowed`, with `intent_id` and `intent_hash`;
  - `pending_approval`, with `reasons` and `expires_at` 15 minutes after the decision;
  - `denied`, with `reasons` and `safe_reply_hint`.

  Each reason is `{ code, detail }`. In phase 3, `allowed` means the gate would execute. Nothing executes yet.
- The full decision record holds, for phases 4 and 10:
  - the intent and its hash;
  - the mandate's ID, version and hash;
  - the verifier trace and today's usage;
  - the matched rules, the outcome and its reasons;
  - the decision time.
- `npm run decide -- <case file>` from the repo root prints:
  - the decision;
  - each reason as its words with the code beside it;
  - the verifier trace, one line per verifier, with its result, the call and the record ID;
  - the amount, the intent ID and the intent hash.

  `--json` prints the agent response for each proposal instead. The exit code is 0 for a decision of any kind, and 2 for an unreadable or invalid case file.
- Every parser reports its first problem as one line in the same shape: what was parsed, the field's path in brackets, then the message. For example, "Case file (now): Invalid ISO datetime" or "Mandate (rules[0].max.amount): …". A problem at the root reads "Mandate: …".

### Fixture cases

- A case file holds:
  - a description and `now`;
  - the mandate file it uses;
  - the record snapshots: captures, orders, disputes lookup, carrier shipments, ticket and execution history;
  - one or more proposals, each with its expected decision and reason codes.

  The expected outcome is written when the case is written, before running it (brief §4 item 4).
- The suite covers at least these:
  - **Beat 3 (the attack email):** five proposals from one ticket. Orders #1038 to #1041 are denied `TICKET_NOT_FROM_PAYER`. #1042, whose payer did send it, is held `SHIPMENT_DELIVERED`.
  - **Beat 4:** a stalled parcel at $18 is allowed.
  - **Beat 5:** a $240 damaged item with a photo is held `ABOVE_AUTO_LIMIT`.
  - Each other row of the reason-code table that a refund can reach, with at least one case per code.
  - A lost parcel under the cap is allowed. A wrong-item claim is held `ALWAYS_NEEDS_APPROVAL`. A claim with the parcel in transit, and a proposal with no claim, are denied `NO_MATCHING_RULE`.

## Constraints

- No AI in the decision path. `@countersign/mandate` and `@countersign/verifiers` import no AI SDK; the existing repo test enforces it. Nothing here calls the network, a database or the clock: `now` is always passed in.
- Fail closed everywhere (brief §8). `unknown` counts as a fail for `require`. Unrecognized input is invalid, not defaulted. `decide` never throws on input that passed its schemas. Arithmetic that would leave the safe-integer range makes the fact unknown instead.
- Timestamps follow one rule everywhere: case files, execution history and usage. A timestamp is ISO 8601 with seconds and an offset (`Z` or `±hh:mm`), and the date must be a real calendar date. The rule is zod 4's `z.iso.datetime({ offset: true })`, defined once and shared (ADR 0020).
- Money is integer minor units plus a currency. It's never a float, including inside fixtures and the mandate.
- Validate every external input with zod 4: mandate files, case files and proposals.
- The mandate schema:
  - allows only `deny` as the fallback;
  - rejects unknown actions, unknown verifier names, unknown `when` keys and non-integer amounts;
  - holds the mandate's ID, its principal and every rule ID to the shared ID rule: not blank, and no leading or trailing spaces, rejected rather than trimmed;
  - rejects a `step_up` or `deny` rule without a rule reason code.

  Mandate amounts are minor units (a $80 cap is `8000`).
- The fixture mandate is `kikapu-studio` version 3 for `support-agent`, with the rules and limits in plan.md. It's illustrative test data.
- Display money as `$96.00` and `KSh 4,500`. Words follow the brand book: plain and short, "you" for the merchant, no exclamation marks.

## Technical needs

- New package links: `@countersign/verifiers` → `@countersign/mandate`, and `@countersign/gate` → both (plan.md). Imports use package names, never relative paths across workspaces.
- Tests use Vitest from the existing root config. The CLI exports a function the tests call, and one test also runs it as a child process.
- `CONTEXT.md` gains the terms this phase introduces, such as record snapshot and today's usage, in the existing format.
