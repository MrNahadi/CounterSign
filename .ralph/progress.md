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
