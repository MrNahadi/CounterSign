# Progress

## T-001: done

`@countersign/mandate` now exports money (`parseMoney`, `formatMoney`, `Money`, `CURRENCIES`, `isCurrency`), `canonicalJson` (RFC 8785, safe integers only) and the intent (`Intent`, `hashIntent` → `{ hash, id }`, plus `RAILS`, `ACTIONS` from original brief §9, and `CLAIMS` = `not_received`, `damaged`, `wrong_item`).

Gotchas for the next iteration:
- The Write and Edit tools decode printable `\uXXXX` escapes in source into raw characters. Control-character escapes survive. In tests, build non-ASCII strings with `String.fromCharCode` (see `packages/mandate/test/canonical-json.test.ts`).
- `npx vitest` needs approval in this harness. Use `npm test -- <path>` to run a subset.
- `parseMoney` returns `{ ok: false, error }`, never throws. `formatMoney` throws on negative or non-integer minor units. Zero formats as `$0.00`.
- `Intent.target` is `{ captureId, orderId: string | null }`, and the hashed fields are `principal, rail, action, amount (minor), currency, target, ticketId`.

For the human (outside T-001, raised in review):
- The intent hash includes `target.orderId`, which comes from the capture record (requirements.md). A proposal with an explicit amount but no capture record gets `orderId: null`, so the same refund could hash differently depending on whether the record was present. `ledger.not_duplicate` still catches a second refund on the same capture, and no refund rule allows without `capture.refundable`, which is unknown without the record. Consider whether T-008 should key the target on the capture alone, or require the record.

## T-002: done

`@countersign/mandate` now exports the mandate schema (`MandateSchema`, `parseMandate` → `{ ok, mandate }` or `{ ok: false, error, issues: { path, message }[] }`, `hashMandate`, types `Mandate`, `Rule`), `VERIFIERS` (all 13 names from original brief §8), `SHIPMENT_STATUSES`, and the reason-code catalog (`REASONS` code → `{ words, hint | null }`, `REASON_CODES`, `RULE_REASON_CODES`). `sha256Canonical` in canonical-json.ts is now the one hashing helper; `hashIntent` uses it too. The fixture mandate is `packages/mandate/fixtures/kikapu-studio-v3.json`.

Gotchas for the next iteration:
- Mandate file keys: `id`, `version`, `principal`, `time_zone` (defaults to `Africa/Nairobi`), `fallback` (only `"deny"`), `limits: [{ currency, per_day_total?, per_day_count? }]`, `rules: [{ id, action (one action or a non-empty list), when?: { claim?, "shipment.status"?: [...], rail? }, require?: [...], max?: { amount, currency }, decide, reason }]`. Snake_case follows original brief §7. All amounts are minor units.
- `reason` is required on `step_up` and `deny` rules and forbidden on `allow` rules. A deny rule may only name `SHIPMENT_DELIVERED` or `RULE_DENIES`, the rule reasons with a reply hint, so every denial has a hint for T-009.
- Every object is strict. Unknown keys report their own path (`["rules", 2, "when", "purpose"]`). There's no `above_max`: per requirements step 3, going over `max` always escalates an allow to step-up.
- Rule IDs are unique, and so is each limit's currency.
- The fixture is not exported from the package index. Read it by file path (see `packages/mandate/test/mandate.test.ts`). T-009 decides how case files point at it.

For the human (outside T-002, raised in review):
- The schema's `when` takes only `claim`, `shipment.status` and `rail` (requirements.md), so original brief §7's `mpesa-overpayment-refund` rule (`when: { purpose: overpayment_refund }`) doesn't fit yet. The M-Pesa phase and the mandate compiler will need a schema change and an ADR.

## T-003: done

`@countersign/mandate` now exports the trace types (`TraceEntry` = `{ verifier, result, records: RecordRef[], detail }`, `RecordRef` = `{ call, id: string | null }`, `VerifierTrace`, `VERIFIER_RESULTS`). They live in mandate, not verifiers, because T-006's evaluator reads them (ADR 0019; plan.md's module table updated to match). `@countersign/verifiers` exports `runVerifiers(intent, records, also?)`, `REFUND_VERIFIERS`, `CALLS`, `recordRef`, and the snapshot types (`CaptureSnapshot`, `OrderSnapshot`, `TicketSnapshot`, `RecordSnapshots`, `SnapshotSource`). `capture.refundable` and `ticket.from_payer` are built.

Gotchas for the next iteration:
- `RecordSnapshots` is `{ captures?, orders?, ticket? }`. Add `disputes`, `shipments`, `executions` there in T-004 and T-005. Register a new verifier in `BUILT_VERIFIERS` in `packages/verifiers/src/run.ts`. Anything not registered returns `unknown` with `records: []`. That's why the four T-004/T-005 refund verifiers already show up as unknown in the trace.
- `runVerifiers` always runs `REFUND_VERIFIERS` for `paypal.refund`, and runs nothing by default for other actions. `also` adds names, such as the matched rules' `require` lists; T-009 should pass them. T-006 must treat a required verifier missing from the trace as unknown, never pass.
- `TraceEntry` has no typed value yet. T-004 should add one (such as `value?: ShipmentStatus`) for `shipment.status`, so T-006 can match `when` without parsing `detail`.
- VERIFIER_UNAVAILABLE: T-006 can map each built verifier's unknown to its own code (CAPTURE_UNKNOWN, PAYER_UNKNOWN, ...) and every other verifier name to VERIFIER_UNAVAILABLE. There's no "not built" flag on the entry.
- `ticket.from_payer` reads `intent.target.orderId`. If the capture record names a different order, it returns unknown. Blank emails count as missing.
- `capture.refundable` returns unknown on a capture record with malformed amounts (negative, fractional, or refunded > captured). T-009's case-file zod schema should still require non-negative integers.
- Shared test fixtures are in `packages/verifiers/test/fixtures.ts`.
- The Bash tool rejects `;`-chained commands and `/tmp` redirects in this harness. Run each Feedback command on its own, or use `&& echo OK`.

For the human (outside T-003, raised in review):
- The `ticket.from_payer` detail prints the full payer email, such as "Sender grace.w@example.com, payer sb-87z5x@personal.example.com". requirements.md's example shows `sb-87z5…@personal.example.com`. Confirm whether that ellipsis means the payer email should be masked on the phone card and in the CLI, or was only shortened for the doc.

## T-004: done

`shipment.status`, `dispute.none_open` and `evidence.photo_present` are built. `TraceEntry` gains `value?: ShipmentStatus`, which is set only on a passing `shipment.status`. T-006 should match `when` on that value, never on `detail`.

Snapshot shapes (`packages/verifiers/src/snapshots.ts`):
- `OrderSnapshot.trackers: { id, trackingNumber, status }[]` is required.
- `TicketSnapshot.attachments: { id, contentType }[]` is required.
- `RecordSnapshots` gains `disputes?: DisputesSnapshot[]` and `shipments?: ShipmentSnapshot[]`.
  - Each `DisputesSnapshot` is `{ call, id, disputes: { id, status }[] }`. Its `id` is the capture the lookup was filtered by.
  - Each `ShipmentSnapshot` is `{ call, id, status }`. Its `id` is the tracking number.
- New calls are in `CALLS`: `disputes` is `GET /v1/customer/disputes`, and `carrier` is `carrier GET /shipments/{tracking_number}`. Phase 5 may rename the carrier call when the carrier mock defines its interface.

Gotchas for the next iteration:
- `orderFor` and `ticketFor` now live in `packages/verifiers/src/lookups.ts` and aren't exported from the package. Use them for any verifier that reads the intent's order or ticket. `orderFor` checks the capture's order against the intent's.
- `shipment.status` counts only trackers with status exactly `SHIPPED` whose ID is `${captureId}-${trackingNumber}` (spike S2). T-009's case-file fixtures must build tracker IDs that way, or the status is unknown.
- `dispute.none_open` treats every dispute in the capture's own lookup as being on that capture, so any status other than `RESOLVED` fails. A lookup for another capture makes it unknown.
- `evidence.photo_present` passes on any attachment whose content type starts with `image/`, ignoring case.

For the human (outside T-004, raised in review):
- If an order has several live trackers for the same capture (a split shipment) and the carrier gives them different statuses, `shipment.status` returns unknown. That fails closed, so the refund falls to `NO_MATCHING_RULE` plus `SHIPMENT_STATUS_UNKNOWN`. requirements.md speaks of "the order's tracker" in the singular. Confirm this behaviour, or say which tracker should win.

## T-005: done

`ledger.not_duplicate` is built, and `@countersign/verifiers` exports `todaysUsage(records, { principal, timeZone, now: Date })` → `Usage`. The `Usage` type (`{ known: true, date, perCurrency: Record<Currency, { count, total: Money }> }` or `{ known: false, detail }`) lives in `@countersign/mandate` (`usage.ts`), because T-007's evaluator reads it. `@countersign/mandate` also exports `isMinorUnits`, now shared by `formatMoney`, `capture.refundable`, the ledger check and usage.

Snapshot shape: `RecordSnapshots.executions?: ExecutionSnapshot[]`, each `{ call, id, principal, captureId: string | null, amount: Money, executedAt }`. `CALLS.executions` is `audit log executions`.

Gotchas for the next iteration:
- Absent `executions` means unknown; `[]` means nothing has executed. T-009's case files must say which they mean.
- `executions` must be the whole history, for every principal and every day. `ledger.not_duplicate` fails on any earlier execution on the capture, whoever made it, and passes on anything left out. Usage filters to the principal and today itself.
- `executedAt` must be ISO 8601 with seconds and an offset (`2026-10-17T06:40:00Z`). Anything else, including impossible dates such as 31 Feb, makes usage unknown. So does a negative, fractional or unknown-currency amount on one of the principal's executions. T-009's case-file zod schema should reject these up front anyway.
- `ledger.not_duplicate`'s record is the earlier execution when it fails, and `{ call: "audit log executions", id: <captureId> }` otherwise.
- Usage counts every executed money action of the principal, not only refunds (requirements.md). The reason-code words still say "refund limit".

For the human (outside T-005, raised in review):
- Per ADR 0019, a second partial refund on a capture that was already partly refunded fails `DUPLICATE_REFUND`, even when the remaining amount covers it. Confirm that this is the intended behaviour for genuine follow-up refunds.

## T-006: done

`@countersign/mandate` exports `evaluate({ mandate, intent, trace })` → `Evaluation` (`{ outcome, reasons: Reason[], matchedRules: string[] }`), plus `OUTCOMES`, `Outcome` (`allow | step_up | deny`) and `Reason` (`{ code, detail }`) in `src/evaluate.ts`. It covers brief §6 steps 1, 2, 4 (most restrictive wins, reasons from the winning rules), 5 and 6.

Gotchas for the next iteration:
- Step 6 runs first: `UNKNOWN_ACTION` and `WRONG_MANDATE` deny with `matchedRules: []`, and both are named when both apply.
- A verifier passes only if it's in the trace and every entry for it passes. Two entries for one verifier with different results never read as pass. `shipment.status` also needs one agreed `value`.
- `SHIPMENT_STATUS_UNKNOWN` follows `NO_MATCHING_RULE` only when some rule matched on action, currency, claim and rail but its `shipment.status` couldn't be read.
- Each built verifier maps to its own fail/unknown code in `REQUIREMENT_CODES`. Any other required verifier gives `VERIFIER_UNAVAILABLE`.
- Step 3 (`max`, daily limits, `DAILY_LIMIT_UNKNOWN`) is not in yet. T-007 should add it inside `ruleOutcome` for allow rules only, and take `Usage` as a new `EvaluateInput` field.

## T-007: done

`evaluate` now takes a required `usage: Usage` and applies step 3 to allow rules whose requirements passed: `ABOVE_AUTO_LIMIT` (amount > `max`), then `DAILY_LIMIT_REACHED` (one reason each for total and count), or `DAILY_LIMIT_UNKNOWN` with the usage's own detail. The seeded property test is `packages/mandate/test/evaluate-property.test.ts` (5,000 runs, its own brief §6 oracle).

Gotchas for the next iteration:
- T-009's `decide()` must pass `todaysUsage(...)` from `@countersign/verifiers` into `evaluate`.
- Limits are inclusive: reaching the total or count exactly still allows; only going past escalates.
- Unknown usage escalates every allow, even when the mandate has no limit for the intent's currency.
- `evaluate.test.ts` wraps `evaluate` with a default of nothing used today; pass `usage` to test limits.

For the human (outside T-007, raised in review):
- A mandate with no `limits` entry for the intent's currency applies no daily limit to it (known usage never escalates). The fixture mandate has limits for both USD and KES. Confirm whether a missing limit should instead mean step-up, which would be stricter.

## T-008: done

`apps/gate/src/proposal.ts` exports `normalizeProposal({ proposal: unknown, principal, mandateVersion, records })` → `{ ok: true, intent }` or `{ ok: false, reason: { code, detail } }`, plus the types `ProposalInput` and `Normalized`. It doesn't hash; T-009 calls `hashIntent`.

Gotchas for the next iteration:
- Proposal shape (all objects strict, unknown keys are `INVALID_PROPOSAL`): `{ tool: "create_refund", args: { capture_id, amount?: { value, currency_code }, note_to_payer? (≤ 255) }, justification: { ticket_id, claim? (null allowed) } }`. T-009's case files should use these keys. `note_to_payer` is validated but not kept on the intent.
- The principal and mandate version come from the caller, never from the proposal. A `principal` key in a proposal is an unknown key, so it's invalid.
- The tool check runs first: any string `tool` other than `create_refund` is `UNKNOWN_ACTION`, whatever else is wrong. A missing or non-string tool is `INVALID_PROPOSAL`.
- IDs must be non-blank with no outer spaces. They're rejected, not trimmed.
- With no amount, a capture with nothing left (or malformed amounts) is `INVALID_PROPOSAL`, since an intent's amount must be greater than zero. With an explicit amount and no capture record, the intent is valid with `orderId: null` (see the T-001 note for the human).

## T-009: done

`apps/gate/src/decide.ts` exports `decide({ mandate, principal, proposal, records, now: Date })` → `{ record: DecisionRecord, response: AgentResponse }`, plus `AgentResponseSchema` and `APPROVAL_WINDOW_MS`. `apps/gate/src/case-file.ts` exports `CaseFileSchema`, `ReasonCodeSchema` and `loadCase(path)` → `{ ok: true, decisionCase }` or `{ ok: false, error }`, never throwing. 18 case files in `apps/gate/fixtures/cases/` reach all 22 reason codes; the suite test fails if a code goes unreached.

Gotchas for the next iteration:
- Case file keys: `description`, `now` (ISO with offset), `mandate` (a path relative to the case file), `principal` (the proposing agent), `records`, `proposals: [{ proposal, expect: { decision: allow|step_up|deny, reasons: [codes] } }]`. Records use the snapshot types' camelCase keys without `call`; the schema fills `call` from `CALLS`, and a stated `call` is rejected.
- `apps/gate/fixtures/mandates/edge-rules.json` is a test mandate whose rules reach `DAILY_LIMIT_UNKNOWN`, `VERIFIER_UNAVAILABLE` and `RULE_DENIES`, which the fixture mandate can't.
- `DecisionRecord` fields: `intent`, `intentId`, `intentHash` (all null for an invalid or unknown-tool proposal), `mandate: { id, version, hash }`, `trace`, `usage`, `matchedRules`, `decision`, `reasons`, `decidedAt` (ISO string of `now`). Usage is computed even when the proposal is invalid.
- Responses: `allowed { intent_id, intent_hash }`, `pending_approval { intent_id, reasons, expires_at }`, `denied { intent_id | null, reasons, safe_reply_hint }`. The hint is the first reason's; a denial whose first reason has none falls back to the next one with a hint, then to `NO_MATCHING_RULE`'s.
- `decide` passes the `require` lists of every rule for the intent's action to `runVerifiers`, so an unbuilt verifier shows up in the trace.
- `decide` calls `now.toISOString()`, which throws on an invalid Date. `loadCase` validates `now`; T-010's CLI should go through `loadCase`.
- CONTEXT.md gained Decision record, Record snapshot and Today's usage.

## T-010: done

`apps/gate/src/decide-cli.ts` exports `runDecideCli(args)` → `{ exitCode, stdout, stderr }` (plus `USAGE`, `EXIT_DECIDED` = 0, `EXIT_BAD_INPUT` = 2), and never writes or exits itself. `apps/gate/src/decide-main.ts` is the entry; the root script is `"decide": "tsx apps/gate/src/decide-main.ts"`. `--json` prints one JSON array of agent responses. CONTEXT.md gained Proposal, Intent hash, Agent response and Decision case.

Gotchas for the next iteration:
- `npm run decide` and `npm run <x> --workspace ...` need approval in this harness. The child-process test runs the entry with `node --import tsx` from the repo root instead, which relies on tsx being hoisted to the root `node_modules`.
- A case-file path is resolved against the working directory, which npm sets to the repo root for root scripts.
- Bad input (no path, two paths, an unknown option, an unreadable, non-JSON or invalid case file) exits 2 with one line on stderr; newlines in an error are folded into spaces.

## T-011: done

`todaysUsage` returns unknown ("Today's USD total is too large to count at execution <id>") when a running total leaves the safe-integer range. `evaluate`'s daily-limit step checks today's total plus the intent (and count + 1) before the limit lookup, and returns `DAILY_LIMIT_UNKNOWN` ("Today's USD total would be too large to count") instead of formatting it. New case `apps/gate/fixtures/cases/usage-overflow.json`; `decide.test.ts` now decides every proposal of every case and asserts none throws.

Gotchas for the next iteration:
- The unsafe-total check runs before the limit lookup, so it escalates even for a currency with no limit. T-015 adds `NO_DAILY_LIMIT` after it, in the same function.

## T-012: done

`@countersign/mandate` exports `TimestampSchema` (`src/timestamp.ts`, `z.iso.datetime({ offset: true })`). The case-file schema uses it for `now` and `executedAt`, and `todaysUsage`'s `readTime` checks it before `new Date`. The hand-written regexes and calendar check are gone. New CLI tests: a `2026-02-31` `now` or `executedAt` exits 2 naming the path.

Gotchas for the next iteration:
- The rule now accepts any number of fractional-second digits (the old regexes allowed at most three), as zod does.

## T-013: done

`captureFor(captureId, records)` → `CaptureSnapshot | null` in `packages/verifiers/src/lookups.ts` is now the one capture lookup, exported from `@countersign/verifiers` (lookups' other helpers stay internal). `capture.refundable` and `normalizeProposal` use it. `orderFor` now finds no order without the capture record ("No record of capture <id>"), so `ticket.from_payer` and `shipment.status` are unknown then, even when the intent names an order.

Gotchas for the next iteration:
- The `fromPayer` and `status` helpers in `ticket-from-payer.test.ts` and `shipment-status.test.ts` now put `captures: [capture]` into the records unless a test states `captures` itself. That kept every existing test body unchanged. Pass `captures: []` to test a missing capture record.

## T-014: done

The intent hash's target is `{ captureId }` alone; `orderId` stays on the intent but isn't hashed. `sha256Canonical` now returns `CanonicalHash` (`{ hash, canonical }`), `hashIntent` returns `{ hash, canonical, id }` and `hashMandate` returns `CanonicalHash`. `DecisionRecord` gains `intentCanonical: string | null`. CONTEXT.md's Intent hash entry updated.

Gotchas for the next iteration:
- `hashMandate(...)` is now an object: use `.hash` where a string is needed (`decide.ts` does).
- No fixture or CLI test pins a hash value; tests compare against `hashIntent` instead.

## T-015: done

The catalog gains `NO_DAILY_LIMIT` (23 codes, step-up only, not a rule reason). `evaluate`'s daily-limit step returns it ("Your mandate sets no KES daily limit") for an allow in a currency with no `limits` entry, after the unknown-usage and safe-integer checks and after `ABOVE_AUTO_LIMIT`. New test mandate `apps/gate/fixtures/mandates/usd-limits-only.json` and case `no-daily-limit.json` (USD allowed, KES held).

Gotchas for the next iteration:
- Any test mandate built with `limits = []` or missing a currency now steps up its allows in that currency.

## T-016: done

`evaluate`'s rule reasons now state their facts (`ruleReason` and `matchedFacts` in `packages/mandate/src/evaluate.ts`). `SHIPMENT_DELIVERED` is the `shipment.status` entry's own detail, then the rule ("Carrier shows TRK1042 delivered; rule refund-delivered-claim asks you first", or "... denies this" on a deny rule). `ALWAYS_NEEDS_APPROVAL` is "Rule refund-wrong-item asks you first for paypal.refund with claim wrong_item". `RULE_DENIES` is "Rule X denies paypal.refund with claim ..., shipment ..., rail ...". A rule with no `when` says "every paypal.refund".

Gotchas for the next iteration:
- The tracking number comes from the verifier's detail wording ("Carrier shows <tracking> <status>"), not from a structured field. If T-018 or phase 5 rewords `shipment.status`'s detail, the beat 3 CLI test pins the text and will catch it. The property test's oracle treats a missing limit as not a clean allow. Its generator now gives each currency a limit 85% of the time and never a zero total or count limit, to keep enough allows (over 2% of runs) and enough missing limits (over 10%).
