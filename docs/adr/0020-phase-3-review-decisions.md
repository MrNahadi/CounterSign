# 0020. Phase 3 review decisions: follow-up refunds, missing limits, split shipments, the intent hash target, hashed bytes, timestamps, safe totals and payer emails

Status: accepted
Decided-by: owner, 17 Oct 2026, approving Claude's recommendations after the phase 3 code review (recorded by Claude)
Question: The phase 3 build loop and the end-of-feature review raised questions the spec didn't settle, and one bug. How should Countersign handle:
- a second partial refund on one capture;
- a currency with no daily limit;
- split shipments whose trackers disagree;
- what the intent hash covers;
- keeping hashed bytes;
- timestamps;
- totals past the safe-integer range;
- where payer emails show in full?
Decision:
- **A second partial refund on a capture is denied** (`DUPLICATE_REFUND`), as brief original §8 defines `ledger.not_duplicate`: "No earlier executed action targets the same capture". PayPal itself allows several partial refunds up to the captured amount, so this is deliberately stricter. Revisit it only if the bench's genuine cases hit it (G3: under 5% wrongly denied).
- **No daily limit for a currency means step-up.** An intent that would otherwise be allowed, in a currency for which the mandate has no `limits` entry, escalates to step-up with the new code `NO_DAILY_LIMIT`. The words are "Your rules set no daily limit for this currency." It's a step-up code only, never a rule reason, and it never turns a deny into a step-up.
- **Split-shipment trackers that disagree stay `unknown`.** Then no `shipment.status` rule matches, and the refund falls to deny `NO_MATCHING_RULE` with `SHIPMENT_STATUS_UNKNOWN`. Only live `SHIPPED` trackers for the intent's capture count.
- **The intent hash target is the capture ID alone.** This amends ADR 0019. A PayPal refund executes as `POST /v2/payments/captures/{capture_id}/refund`, so the capture is what executes. The order ID is still derived from the capture record and kept on the intent for display and lookups, but it isn't hashed. That ends the case where the same refund hashed differently depending on whether the capture record was present.
- **Every hash keeps the exact bytes it hashed.** `hashIntent` and `hashMandate` return the canonical JSON along with the SHA-256, and the decision record stores the intent's canonical JSON. This follows ADR 0003 ("store exactly what was hashed"), and phase 4's audit log will need it.
- **One timestamp rule:** zod 4's `z.iso.datetime({ offset: true })`, shared by case files, execution history and usage. In zod 4.6.7 it requires seconds and an offset (`Z` or `±hh:mm`). It rejects impossible dates such as `2026-02-31` and `2026-02-29`, and accepts `2028-02-29`. This was tested locally on 17 Oct 2026.
- **Totals stay safe integers.** If adding a principal's executions for the day leaves the safe-integer range, today's usage is unknown. An allow then escalates to step-up (`DAILY_LIMIT_UNKNOWN`). The decision path never throws on input that passed its schema, and the CLI's exit codes stay 0 for any decision and 2 for a bad case file.
- **Payer emails:**
  - They show in full where only the merchant can see them: the console, the phone card, the CLI and the audit log.
  - They're masked wherever the public or judges can see them: "Attack it yourself", the README, gallery images and the video. The mask keeps the domain and the local part's first character, as in `g•••@example.com`. Phase 15 applies it.
Basis:
- The owner's approval on 17 Oct 2026: "I approve all the recommendations you have made from the decisions you need from me."
- Phase 3 review findings: the spec review reproduced a crash on a schema-valid case file, where the daily total overflowed and `formatMoney` threw. The standards review found the timestamp rule written twice with the two copies disagreeing, and the hash helpers not keeping their bytes.
- PayPal refunds are made on a capture and allow several partial refunds up to the captured total. Spike S1 showed that the same `PayPal-Request-Id` returns the same refund: https://developer.paypal.com/beta/payments/refund and `docs/spikes.md`.
- Zod 4 ISO datetime options (`offset`, seconds required by default; the checks are regex-based): https://zod.dev/api#iso-datetimes
- OWASP Logging Cheat Sheet, which lists email addresses as personal data needing special handling: "sanitization can be undertaken post log collection, and prior to log display", and "The privileges to read log data should be restricted": https://cheatsheetseries.owasp.org/cheatsheets/Logging_Cheat_Sheet.html
- `Number.MAX_SAFE_INTEGER` is 2^53 − 1. Integer sums past it lose precision, and `Number.isSafeInteger` detects that.
Consequences:
- Phase 3 gains tickets T-011 to T-018 for these decisions and the review's remaining findings. The requirements are updated to match.
- The reason catalog grows to 23 codes. The fixture suite must still reach every code, `NO_DAILY_LIMIT` included.
- The reference canonical string in T-001's hash test changes, because the order ID leaves the hashed target.
- Phase 15 masks payer emails on public pages. Phase 10's console shows them in full.
