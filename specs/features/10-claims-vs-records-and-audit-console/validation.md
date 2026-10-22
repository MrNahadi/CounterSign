# Phase 10 validation: claims vs records, and the audit console

## Automated checks

All run from the repo root and are part of the Feedback commands.

1. `npm run typecheck`, `npm run lint`, `npm test` and `npm run build` pass.
2. **Claims vs records:** from real decisions, beat 3's KIK-1038, KIK-1039 and KIK-1041 each pair "Sent from …" Contradicts (the payer differs), KIK-1040's claim Contradicts "in transit" (no rule matched), and KIK-1042's "Says the parcel never arrived" Contradicts "delivered"; beat 4's claim Matches `stalled_10d`; beat 5 Matches its photo and capture. Every row of the `shipment.status` verdict table has a test. An unknown check is "No record". A missing ticket, a ticket ID the store lacks, a decision with no intent and a mandate the gate doesn't hold each give the pairs requirements.md names. The message pair is always last and always Not used. Every verifier has words.
3. **Checks that decided:** a refund that matched the damaged-item rule shows its required checks; beat 3's KIK-1040 (`NO_MATCHING_RULE`, parcel in transit) shows `shipment.status`; the approval card's `checks` and `claims` use the same rule, and the phase 9 card tests still pass.
4. **Reader:** rows come newest first with each status (executed, failed, unknown, pending, not executable, open, approved, denied, expired); filters by decision and `q`, paging by `before` and the counts work; an unreadable decision entry is a `readable: false` row and the rest still list; the detail's trail holds the approval, request, result and webhook reconciliation of an approved beat 5 in order; a non-decision `seq` is not found; by-intent finds the newest decision.
5. **Evidence:** an intent export of approved beat 5 holds its decisions, approval, request, result, reconciliation and mandate entry, ascending; a capture export adds an unmatched reconciliation on the same capture; `checkEvidence` passes on both, and fails, naming the `seq`, when a payload character, a hash, a `seq` order or a non-canonical payload is changed in the file. `ledger check-export` exits 0, 1 and 2 as requirements.md says, with one child-process run.
6. **API:** over a real listening gate, no key, a wrong key and a principal key answer 401 on every audit route; bad parameters 400; unknown `seq`, intent and empty export 404; no database 503; the export has the attachment header and parses as `countersign-evidence-v1`; verify reports a row edited behind the trigger as broken at its `seq`.
7. **Read-only:** running every reader, API route and the CLI's `show` and `export` leaves the audit log's head and row count unchanged.
8. **CLI:** `runAudit` shows and exports with the exit codes in requirements.md and refuses to overwrite a file; one child-process run of the entry point.
9. **Console:** the view models turn recorded gate answers into the decision list (badges, status words, why), the decision page (pairs, trace, trail sentences, export links) and the audit log page (summaries, verdict lines); the routes forward the cookie, never expose the key, refuse bad input, pass the export through only with the right `format`, and answer 401 and 502 with their fixed sentences; the approvals card view renders `claims`; inbox rows link to `/decisions/intent/<id>`; the design check passes on every new file.
10. **No secrets:** across API answers, exports, CLI output and console route answers in these tests, no fake approver key, principal key or token appears.
11. **Decision path untouched:** the no-AI test still passes, and a test fails if `decide`, `@countersign/verifiers` or `@countersign/mandate` imports the claims-vs-records module.

## Live checks

None in the Feedback commands or under `LIVE=1`: this phase calls no external service. Its real-data checks are the manual ones below, once the seed has run and the keys are set (`.ralph/human.md`).

## Manual checks for the human

1. With the seed run and `COUNTERSIGN_APPROVER_KEY` and `COUNTERSIGN_SUPPORT_AGENT_KEY` set, start the gate, resolve-agent and the console. Run beats 3, 4 and 5 (`npm run resolve -- apps/resolve-agent/scenarios/…`, or the inbox), then open `/decisions`, sign in, and check a stranger can tell from the list alone which refund moved money, which waits, and why the others were refused.
2. Open beat 3's KIK-1042 decision and check the two columns read as "what the message claims" beside "what the records say", each record with a sandbox ID you can find in the PayPal sandbox dashboard (order, capture) or the seed (tracking number). Do the same on the phone approvals card for beat 5.
3. From beat 4's decision, export evidence for the payment, run `npm run ledger -- check-export <file>`, and compare the head it prints with `npm run ledger -- verify`.
4. On `/audit`, press "Check the chain" and check the verdict and head match `npm run ledger -- verify`.
5. In the inbox, follow a guarded call's "Claims vs records" link to its decision.
6. Check `/decisions`, a decision and `/audit` in light and dark, at desktop and phone width (the table scrolls inside its box), and read the copy against the brand book.
