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

Status: done
Blocked by: T-009
Slice: `npm run decide -- <case file>` prints each proposal's decision, reasons as words with codes, verifier trace and intent hash, or the agent responses with `--json`.
Test seam: the CLI's exported run function, plus one child-process run of the real entry point
Acceptance:
- [x] On the beat 3 case, the readable output shows 4 denials with `TICKET_NOT_FROM_PAYER` and 1 step-up with `SHIPMENT_DELIVERED`. Each reason shows its words with the code beside it, and each trace line its result, call and record ID
- [x] `--json` prints responses that validate against the agent response schema
- [x] An unreadable or invalid case file exits with code 2 and a one-line error that says what's wrong. Any decision exits with code 0
- [x] The root `package.json` has a `decide` script, and `CONTEXT.md` gains this phase's new terms
Notes:

## T-011: decide never throws on a valid case: safe-integer totals

Status: done
Blocked by:
Slice: A case file whose execution history adds up past the safe-integer range gets a decision instead of a crash: usage is unknown, so an allow escalates to step-up `DAILY_LIMIT_UNKNOWN`. The CLI still exits with code 0.
Test seam: `todaysUsage` in `@countersign/verifiers`, the `decide` function in `apps/gate/src/`, and the CLI's exported run function
Acceptance:
- [x] Usage is unknown, with a detail that says why, when a principal's total for a currency would pass `Number.MAX_SAFE_INTEGER`. The check is `Number.isSafeInteger` on every running total
- [x] The evaluator never calls `formatMoney` with a value that isn't a safe non-negative integer. A regression test feeds it the overflowing usage and gets a decision
- [x] A new fixture case (one `MAX_SAFE_INTEGER` execution today, plus beat 4's $18 proposal) expects step-up `DAILY_LIMIT_UNKNOWN`. The CLI run on it exits 0 with no stack trace
- [x] A test runs `decide` on every fixture case and asserts that none of them throws
Notes: Found by the phase 3 spec review (ADR 0020). It reproduced "THREW Can't format 9007199254742792 minor units".

## T-012: One timestamp rule, shared

Status: done
Blocked by:
Slice: Case files, execution history and usage all check timestamps with one shared zod schema, so `2026-02-31T10:00:00Z` is rejected everywhere instead of rolling over to 3 March.
Test seam: a timestamp schema exported from `@countersign/mandate`, `loadCase` in `apps/gate/src/case-file.ts`, and `todaysUsage`
Acceptance:
- [x] `@countersign/mandate` exports one timestamp schema built on `z.iso.datetime({ offset: true })`. It rejects `2026-02-31T10:00:00Z`, `2026-02-29T10:00:00Z`, a timestamp with no seconds and one with no offset. It accepts `2028-02-29T10:00:00Z` and `2026-10-17T06:00:00.123+03:00`
- [x] The case-file schema uses it for `now` and every `executedAt`. A case file with `2026-02-31` gives exit code 2 and names the bad field's path
- [x] `todaysUsage` uses the same rule. The hand-written pattern and calendar check in `packages/verifiers/src/usage.ts` and the regex in `case-file.ts` are gone, so the rule lives in one place
Notes: zod 4.6.7's `z.iso.datetime({ offset: true })` rejects calendar rollovers (tested 17 Oct, ADR 0020).

## T-013: Record lookups fail closed

Status: done
Blocked by:
Slice: Verifiers that reach an order through the intent's capture need the capture record, and the record must name that order. Without it, `ticket.from_payer` and `shipment.status` are unknown, even when the intent carries an order ID.
Test seam: `runVerifiers` in `@countersign/verifiers`, and the proposal normalization function in `apps/gate/src/`
Acceptance:
- [x] One `captureFor` lookup in `packages/verifiers/src/lookups.ts` replaces the three separate capture finds (`capture.ts`, `lookups.ts`, `apps/gate/src/proposal.ts`)
- [x] With no capture record, `orderFor` finds no order. A test gives an intent with an order ID but no capture record, and gets `ticket.from_payer` and `shipment.status` unknown
- [x] A capture record that names a different order than the intent still gives unknown, as it does today
- [x] Every existing verifier and fixture-case test still passes unchanged
Notes: Found by the phase 3 standards review. The gate path was already safe, because normalization derives the order ID from the capture. This is defence in depth.

## T-014: The intent hash covers the capture, and hashes keep their bytes

Status: done
Blocked by: T-013
Slice: The intent hash covers the capture ID but not the order ID. Every hash comes back with the exact canonical JSON it hashed, and the decision record stores the intent's.
Test seam: `hashIntent` and `hashMandate` in `@countersign/mandate`, and the `decide` function's decision record
Acceptance:
- [x] The same intent with `orderId: null` and with an order ID set hashes the same. Changing the capture ID, amount, currency, ticket or principal changes the hash
- [x] `hashIntent` and `hashMandate` return the canonical JSON along with the hash, and the SHA-256 of that JSON equals the hash
- [x] T-001's hand-written reference canonical string is updated: the order ID leaves the hashed target. It still hashes to the intent's hash
- [x] The decision record gains the intent's canonical JSON. The agent response is unchanged apart from the new hash values
- [x] Fixture cases and CLI tests that pin hash values are updated to the new values, and nothing else changes
Notes: ADR 0020, which amends ADR 0019. A refund executes as `POST /v2/payments/captures/{capture_id}/refund`, so the capture is the target. No fixture case or CLI test pinned a hash value, so none needed updating.

## T-015: No daily limit for a currency means step-up

Status: done
Blocked by: T-011
Slice: An intent the rules would allow, in a currency the mandate sets no daily limit for, escalates to step-up `NO_DAILY_LIMIT`.
Test seam: `evaluate` and the reason-code catalog in `@countersign/mandate`
Acceptance:
- [x] The catalog gains `NO_DAILY_LIMIT` with the words "Your rules set no daily limit for this currency." and no reply hint. It's step-up only, and not a rule reason
- [x] With no `limits` entry for the intent's currency, an allow escalates to step-up `NO_DAILY_LIMIT`. A deny stays a deny
- [x] The seeded fail-closed property test also generates mandates with missing limits, and still finds no allow without a matched, fully passing allow rule and no escalation
- [x] A fixture case reaches `NO_DAILY_LIMIT`, and the suite's "every code is reached" test covers it. That makes 23 codes
Notes: ADR 0020.

## T-016: Rule reasons say what the records showed

Status: done
Blocked by: T-015
Slice: Step-up and deny reasons that come from a rule state the facts behind them. So #1042 in beat 3 reads "Carrier shows TRK1042 delivered; rule refund-delivered-claim asks you first", not just the rule's name.
Test seam: `evaluate` in `@countersign/mandate`, and the CLI's exported run function on the beat 3 case
Acceptance:
- [x] The `SHIPMENT_DELIVERED` detail names the carrier status and the tracking number, both read from the `shipment.status` trace entry, and then the rule
- [x] The `ALWAYS_NEEDS_APPROVAL` detail names the action and the rule
- [x] The `RULE_DENIES` detail names the rule and the facts it matched, such as the claim and the shipment status
- [x] The readable output for beat 3 shows the tracking number on #1042's step-up reason
Notes: Found by the phase 3 spec review: "Each reason in a decision carries a `detail` with the specifics."

## T-017: Validate the tool with zod, and put the mandate's helpers in the mandate package

Status: done
Blocked by: T-014, T-016
Slice: The proposal's tool name is read through zod. The helpers that walk a mandate's rules live in `@countersign/mandate`, so the decision module no longer imports the case-file loader.
Test seam: the proposal normalization and `decide` functions in `apps/gate/src/`, and the mandate package's exports
Acceptance:
- [x] The proposal's `tool` is read through a zod pre-parse, never by reading the raw object. Behaviour is unchanged: any other string tool is `UNKNOWN_ACTION`, and a missing or non-string tool is `INVALID_PROPOSAL`
- [x] `ReasonCodeSchema` moves beside the reason catalog in `@countersign/mandate`, and `apps/gate/src/decide.ts` no longer imports `./case-file`
- [x] `@countersign/mandate` exports a rule's action list and the verifiers a mandate's rules require for an action. `evaluate` and `decide` both use them, so the "one action or a list" switch is written once
- [x] All tests pass unchanged apart from import paths
Notes: From the phase 3 standards review: "validate every external input with zod 4", plus Feature Envy and a misplaced dependency.

## T-018: Names from the glossary, and one copy of each helper

Status: done
Blocked by: T-017
Slice: The decision type uses the glossary's word, and the helpers duplicated across the packages exist once, with no change in behaviour.
Test seam: the public exports of `@countersign/mandate` and `@countersign/verifiers`, through the existing test suites
Acceptance:
- [x] The decision type and list are named after `CONTEXT.md`'s "Decision", not "outcome", which the glossary's Avoid list rules out. That covers the type, the list and the `Record<…>` keys, everywhere
- [x] There is one ID schema, one zod-path formatter and one "first zod issue as a message" helper, each shared by the mandate, case-file and proposal parsers
- [x] The verifiers share one helper for building a trace entry, instead of each defining its own `result` closure
- [x] The snapshot schema builder `from()` is renamed `snapshotSchema`, and `runVerifiers`' `also` parameter becomes `requiredVerifiers`
- [x] No behaviour changes. Every test passes, with only renames in the tests
Notes: Phase 3 standards review: Mysterious Name, Duplicated Code, and CONTEXT.md's _Avoid_ list for Decision.
