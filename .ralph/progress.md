# Progress: phase 10, claims vs records and the audit console (specs/features/10-claims-vs-records-and-audit-console)

## T-001 (done)
- Added `apps/gate/src/claims.ts` (`claimsVsRecords`, `checksThatDecided`, `VERDICT_WORDS`, `CLAIM_WORDS`, fixed sentences) and `apps/gate/src/words.ts` (`ACTION_WORDS` moved here from approval-cards, which re-exports it; `VERIFIER_WORDS`; `sourceWords(call)`). Tests in `apps/gate/test/claims.test.ts`.
- Input shape: `claimsVsRecords({ intent, trace, matchedRules, mandate, proposal }, { ticket, orderNumber, mandates })`. Build the first argument from a decision payload as `{ ...payload.record, proposal: payload.proposal }`. The ticket must be the one read by `intent.ticketId` (a ticket with another ID counts as not in the store).
- `ClaimPair` is already snake_case-safe JSON: `{ check, claim: { text, quote, simulated } | null, record: { words, detail, value, sources: [{ words, call, id }] }, verdict }`, verdict one of `matches | contradicts | passes | fails | no_record | not_used`. `check` is a verifier name, `"message"` or `"proposal"`. The message pair's claim text is the subject (quote = first 280 chars of body), or the excerpt when there's no subject.
- T-006 gotcha: approval-cards still has its own `usedVerifiers` narrowing; swap it for `checksThatDecided` (it differs only when no rule matched) and add `claims`.
