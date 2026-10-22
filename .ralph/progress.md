# Progress: phase 10, claims vs records and the audit console (specs/features/10-claims-vs-records-and-audit-console)

## T-001 (done)
- Added `apps/gate/src/claims.ts` (`claimsVsRecords`, `checksThatDecided`, `VERDICT_WORDS`, `CLAIM_WORDS`, fixed sentences) and `apps/gate/src/words.ts` (`ACTION_WORDS` moved here from approval-cards, which re-exports it; `VERIFIER_WORDS`; `sourceWords(call)`). Tests in `apps/gate/test/claims.test.ts`.
- Input shape: `claimsVsRecords({ intent, trace, matchedRules, mandate, proposal }, { ticket, orderNumber, mandates })`. Build the first argument from a decision payload as `{ ...payload.record, proposal: payload.proposal }`. The ticket must be the one read by `intent.ticketId` (a ticket with another ID counts as not in the store).
- `ClaimPair` is already snake_case-safe JSON: `{ check, claim: { text, quote, simulated } | null, record: { words, detail, value, sources: [{ words, call, id }] }, verdict }`, verdict one of `matches | contradicts | passes | fails | no_record | not_used`. `check` is a verifier name, `"message"` or `"proposal"`. The message pair's claim text is the subject (quote = first 280 chars of body), or the excerpt when there's no subject.
- T-006 gotcha: approval-cards still has its own `usedVerifiers` narrowing; swap it for `checksThatDecided` (it differs only when no rule matched) and add `claims`.

## T-002 (done)
- Added `apps/gate/src/audit-reader.ts`: `readDecisionRows(db, filters, now)`, `readDecisionDetail(db, seq, now, mandates)`, `readDecisionSeqByIntent(db, intentId)`, `readEntries(db, { before, limit })`, plus `DecisionFiltersSchema` / `EntryPageSchema` (typed values, strict; the API in T-005 must coerce query strings to numbers before parsing). Tests in `apps/gate/test/audit-reader.test.ts` (one log built in beforeAll: beats 3-5, expired/denied step-ups, failed/unknown/pending/not-executable allows, a webhook reconciliation, two junk entries).
- Output is already snake_case. Row `status` is `{ kind, execution }`; kinds: executed, failed, unknown, pending, not_executable, open, approved, denied, expired, and also `unknown` for a step-up whose answer entry can't be read (console should show "Not confirmed yet"). Detail returns null for not-found, `{ readable: false, problem, payload, ... }` for unreadable.
- Exported `IntentSchema`, `TraceEntrySchema`, `ReasonSchema` from approval-log and `amountOf`, `targetOf`, `ticketOf` from approval-cards for reuse.
- Verify isn't in the reader: T-005 can wrap `verifyLog` directly. Reason code for beat 3's sender mismatch is `TICKET_NOT_FROM_PAYER`; KIK-1039 matches `refund-lost-parcel` (its require fails).

## T-003 (done)
- Added `packages/ledger/src/evidence.ts`: `buildEvidence(db, { scope, seqs, exportedAt })` (fresh `verifyLog`, then `readRowsBySeq`; throws `EvidenceRowsMissingError` for a seq not in the log, zod error for empty seqs), `checkEvidence(value)` (`{ ok, file, problems }` or `{ ok: false, error }`), `EvidenceFileSchema`, `EVIDENCE_FORMAT`, `EVIDENCE_CHECK`. CLI gains `check-export <file>` (no database opened). Tests in `packages/ledger/test/evidence.test.ts`.
- File keys are snake_case: `chain` is `{ intact, entry_count, head: { seq, hash } | null, problem_count }`; entries `{ seq, entry_type, ref_id, at, payload, prev_hash, hash }`. A broken chain's head is the highest-seq stored row (verdicts don't carry one). Problem codes: `SEQ_ORDER`, `NOT_CANONICAL`, `HASH_MISMATCH`.
- `check-export` also exits 1 (with the line "The audit log was broken when this was exported: N problems.") when the file's `chain.intact` is false, failing closed. T-004/T-007 must pass `exportedAt` from an injected clock and select seqs themselves.

## T-004 (done)
- Added `apps/gate/src/evidence-export.ts`: `exportEvidence(db, { kind, id }, now)` returns `{ kind: "file", file }` or `{ kind: "not_found" }`. Selection reads decision/reconciliation payloads loosely (zod, display-only) and the intent rows by `ref_id`; `now` is injected and becomes `exported_at`. Tests in `apps/gate/test/evidence-export.test.ts`.
- Gotcha: `@countersign/db` doesn't export `inArray`, so selection uses `sql.join`. A decision whose payload can't be read for its intent/capture is left out of the selection. A mandate seq missing from the log would make `buildEvidence` throw `EvidenceRowsMissingError` (T-005 should map unexpected throws to 503).
- The pre-existing biome warning in `apps/resolve-agent/src/queue.ts` (void in union) is unrelated.

## T-005 (done)
- Added `apps/gate/src/audit-api.ts` (`mountAudit`, `AUDIT_PATH`, `AUDIT_MESSAGES`), mounted in `createApp` after the approval API. The approver check is now `approverOnly(approver)` exported from approvals-api and shared by both. Tests in `apps/gate/test/audit-api.test.ts`.
- Answers: `/audit/decisions` and `/audit/entries` return the reader's pages as they are; `/audit/decisions/:seq` the detail (200 with `readable: false` for an unreadable entry); `/audit/intents/:id` `{ decision_seq }`; `/audit/verify` `{ intact, entry_count, head: { seq, hash } | null, problems: [{ seq, code, detail }] }` (a broken chain's head is the last stored row); `/audit/export` the file pretty-printed with `Content-Disposition: attachment; filename="countersign-evidence-<kind>-<id>.json"`.
- Errors are `{ message }`: 401 uses `APPROVAL_MESSAGES.unauthorized` with `WWW-Authenticate: Bearer`; a malformed seq or intent ID is 400 (not 404, unlike the approval API); capture IDs must match `^[A-Za-z0-9-]{1,64}$`. Repeated query params arrive as arrays and fail as 400.
- In the beat 3 log, KIK-1042 is a step-up and KIK-1039 a deny (counts: 2 step-ups, 1 deny with beat 5).
