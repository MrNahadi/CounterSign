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
