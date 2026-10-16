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
