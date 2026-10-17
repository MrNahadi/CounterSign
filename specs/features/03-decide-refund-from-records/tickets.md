# Phase 3 tickets: decide a refund from records

## T-001: Money, canonical JSON and the intent hash

Status: done
Blocked by:
Slice: A refund intent built in code gets a stable intent hash and ID, with its amount held as integer minor units and printable as `$96.00`.
Test seam: the money, canonical JSON and intent exports of `@countersign/mandate` (public interface only)
Acceptance:
- [x] Money parsing accepts `"12.00"`, `"12.5"` and `"12"` for USD and KES as minor units. It rejects a sign, an exponent, more than two decimals, thousands separators, zero and other currencies
- [x] Money formats as `$96.00` and `KSh 4,500`
- [x] Canonical JSON matches the RFC 8785 examples in our subset, including UTF-16 key ordering and string escaping. It rejects non-integer, non-finite and unsafe numbers
- [x] The intent hash ignores key order and the claim and mandate version. It changes with the amount, currency, target, ticket or principal. The intent ID is `int_` plus 24 hex characters of the hash
- [x] A hand-written expected canonical string for one reference intent hashes to the same SHA-256 as the intent
Notes:

## T-002: Reason codes and the mandate schema

Status: done
Blocked by: T-001
Slice: The fixture mandate `kikapu-studio` v3 for `support-agent` loads, validates and hashes, and every reason code has its words and reply hint.
Test seam: the mandate schema, mandate hash and reason-code catalog exports of `@countersign/mandate`
Acceptance:
- [x] The fixture mandate (rules and limits in plan.md, amounts in minor units) parses, and its hash ignores key order
- [x] Parsing rejects, with the bad field's path:
  - a fallback other than deny;
  - an unknown action, verifier name or `when` key;
  - a non-integer or negative amount;
  - a currency other than USD or KES;
  - a step-up or deny rule without a rule reason code
- [x] The catalog holds every code in requirements.md with its words, and a reply hint wherever the table gives one. Only rule reason codes are allowed in a rule's reason
Notes:

## T-003: Verifier trace, capture.refundable and ticket.from_payer

Status: done
Blocked by: T-001
Slice: Given capture, order and ticket snapshots and a refund intent, the verifiers return a trace whose entries name their result, source call and record ID.
Test seam: the verifier-running export of `@countersign/verifiers`
Acceptance:
- [x] `capture.refundable` passes for `COMPLETED` and `PARTIALLY_REFUNDED` within the remaining amount. It fails for other statuses, another currency or too much asked for. It's unknown without a capture
- [x] `ticket.from_payer` passes on equal emails, ignoring case and outer spaces. It fails on different emails, and is unknown without a payer or sender email
- [x] Each trace entry names the call (such as `GET /v2/payments/captures/{id}`) and the record ID
- [x] Every verifier name in the schema that isn't built yet returns unknown
Notes:

## T-004: shipment.status, dispute.none_open and evidence.photo_present

Status: done
Blocked by: T-003
Slice: The trace for a refund intent includes the carrier's shipment status for the order's tracker, the dispute check and the photo check.
Test seam: the verifier-running export of `@countersign/verifiers`
Acceptance:
- [x] `shipment.status` passes with the value `lost`, `stalled_10d`, `in_transit` or `delivered`, read through the tracker's tracking number. It's unknown with no tracker or no carrier record
- [x] `dispute.none_open` passes when the lookup ran and finds no open dispute on the capture, and fails on an open one. It's unknown when the lookup didn't run
- [x] `evidence.photo_present` passes with an image attachment, fails without one, and is unknown without a ticket
Notes:

## T-005: ledger.not_duplicate and today's usage

Status: done
Blocked by: T-003
Slice: Given an execution history, the trace says whether the capture was already refunded, and today's usage gives the count and total per currency for the principal.
Test seam: the verifier-running and usage exports of `@countersign/verifiers`
Acceptance:
- [x] `ledger.not_duplicate` passes with no earlier execution on the capture, fails with one, and is unknown without a history
- [x] Usage counts only the principal's executed money actions on today's date in the mandate's time zone. An execution at 23:30 UTC counts as the next day in `Africa/Nairobi`
- [x] Usage is unknown without a history
Notes:

## T-006: Rule evaluation: match, require, fallback

Status: done
Blocked by: T-002, T-003
Slice: Given a mandate, an intent and a trace, the evaluator returns allow, step-up or deny with reason codes for brief §6 steps 1, 2, 5 and 6.
Test seam: the evaluator export of `@countersign/mandate`
Acceptance:
- [x] Step 1: `when` matches on the claim, on `shipment.status` (an unknown status never matches) and on the rail. A rule with no `when` matches its action, and a rule with a `max` matches only its currency
- [x] Step 2: a matched rule with any requirement not `pass` denies, with one reason per failed or unknown requirement. The codes come from the catalog
- [x] Step 5: no match falls back to deny `NO_MATCHING_RULE`, followed by the unknown code for an unknown `when` fact
- [x] Step 6: an unknown action denies `UNKNOWN_ACTION`, and a principal that isn't the mandate's denies `WRONG_MANDATE`
- [x] A step-up or deny rule's outcome carries the rule's reason code
Notes:

## T-007: Escalations, most restrictive wins, and the fail-closed property

Status: done
Blocked by: T-006, T-005
Slice: Allowed intents above a cap or past a daily limit become step-ups, the most restrictive matched outcome wins, and a randomized test proves allow only comes from a fully passing allow rule.
Test seam: the evaluator export of `@countersign/mandate`
Acceptance:
- [x] Step 3: an amount above the rule's `max` escalates allow to step-up `ABOVE_AUTO_LIMIT`. Its detail names both amounts and the rule
- [x] Step 3: passing the day's total or count escalates allow to step-up `DAILY_LIMIT_REACHED`. Unknown usage escalates to `DAILY_LIMIT_UNKNOWN`. Escalations never turn a deny into a step-up
- [x] Step 4: with several matched rules, deny beats step-up beats allow
- [x] A seeded randomized test over at least 1,000 generated mandates, traces and usages finds no allow without a matched allow rule whose requirements all passed and with no escalation
Notes:

## T-008: Normalize a create_refund proposal

Status: done
Blocked by: T-001, T-002
Slice: The gate turns a `create_refund` proposal and the capture record into an intent, or into a denial when the proposal is invalid or the tool is unknown.
Test seam: the proposal normalization function in `apps/gate/src/` (its public function only)
Acceptance:
- [x] A valid proposal becomes an intent with the principal, rail, action, amount in minor units, currency, capture and order IDs, ticket ID and claim
- [x] A missing amount becomes the capture's remaining refundable amount. With no capture record, it's invalid
- [x] Bad money, a missing capture ID, a missing ticket ID or an unknown claim value is denied `INVALID_PROPOSAL`, and nothing is thrown. An unknown tool name is denied `UNKNOWN_ACTION`
- [x] Every proposal input is validated with zod
Notes:

## T-009: decide() end to end, the agent response and the fixture cases

Status: done
Blocked by: T-004, T-007, T-008
Slice: A case file's proposals and records run through normalize, verify and evaluate, giving each proposal a decision record and its agent response.
Test seam: the `decide` function in `apps/gate/src/`, run over every file in `apps/gate/fixtures/cases/`
Acceptance:
- [x] Each fixture case returns its expected decision and reason codes. The suite covers beats 3, 4 and 5 and every reachable code (requirements.md, Fixture cases)
- [x] Agent responses validate against a zod schema of original brief §6's shapes. `pending_approval` expires 15 minutes after `now`, and `denied` carries the first reason's reply hint
- [x] The decision record holds the intent and hash, the mandate ID, version and hash, the trace, usage, matched rules, outcome, reasons and decision time
- [x] Case files are validated with zod, and each expected outcome sits in the case file beside its proposal
Notes:

## T-010: The decide CLI

Status: open
Blocked by: T-009
Slice: `npm run decide -- <case file>` prints each proposal's decision, reasons as words with codes, verifier trace and intent hash, or the agent responses with `--json`.
Test seam: the CLI's exported run function, plus one child-process run of the real entry point
Acceptance:
- [ ] On the beat 3 case, the readable output shows 4 denials with `TICKET_NOT_FROM_PAYER` and 1 step-up with `SHIPMENT_DELIVERED`. Each reason shows its words with the code beside it, and each trace line its result, call and record ID
- [ ] `--json` prints responses that validate against the agent response schema
- [ ] An unreadable or invalid case file exits with code 2 and a one-line error that says what's wrong. Any decision exits with code 0
- [ ] The root `package.json` has a `decide` script, and `CONTEXT.md` gains this phase's new terms
Notes:
