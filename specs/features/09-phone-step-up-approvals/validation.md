# Phase 9 validation: phone step-up approvals

## Automated checks

All run from the repo root and are part of the Feedback commands, except the live checks.

1. `npm run typecheck`, `npm run lint`, `npm test` and `npm run build` pass.
2. **Entries:** `approval` appends and `ledger verify` passes over a log holding approvals; an approval payload of the wrong shape is refused before anything is written. Execution entries written in phases 6 to 8 still read, and new approved and invoice entries read beside them.
3. **States:** from real beat 5 decisions, a step-up reads open; past `expires_at` it reads expired; after a deny of the same intent it and every earlier step-up of that intent read answered; a re-proposal makes a newer step-up and the open list shows one card for the intent.
4. **Answers:** approving beat 5's step-up with its hash writes `approval` then `execution.requested` (with `approvalSeq`), makes exactly one refund in the fake sandbox with the intent hash as request ID, and appends its result. Each rejection code has a test that writes a `rejected` entry and makes no rail call: a hash for $241.00 (`HASH_MISMATCH`), a second approve (`ALREADY_ANSWERED`), an approve one second after expiry (`EXPIRED`), an approve after the agent's replay was requested (`ALREADY_REQUESTED`), an `accept_dispute_claim` step-up (`ACTION_UNAVAILABLE`), and a second refund on a capture that has since been refunded (`DUPLICATE_REFUND`). A deny makes no rail call. Two approvals sent at once make one refund.
5. **Invoice send:** a step-up on `send_invoice` approved once sends one invoice with the hashed note and recipients and no request ID; 200, 202, 4xx and a network failure give `SENT`, `SCHEDULED`, `failed` and `unknown`; it's never re-sent. An allowed invoice send under a test mandate executes through `propose` once.
6. **API:** over a real listening gate, no key, a wrong key, a principal key and an approver key equal to a principal key each answer 401 and write nothing; the approver key is refused on `/mcp`; cards hold every field in requirements.md with reason words and codes; a bad body answers 400; an unknown ID 404; an unreadable entry 503.
7. **End to end over MCP:** a scripted agent's beat 5 `create_refund` gets `pending_approval`; approving it through the API executes one refund, the webhook fixture reconciles it, and `ledger verify` passes. Approving with a changed amount's hash is rejected and nothing moves.
8. **CLI:** `runApprovals` lists, shows, approves and denies with the exit codes in requirements.md; one child-process run of the entry point.
9. **Console:** the approval view models turn recorded gate answers into cards with words and codes and every outcome sentence; the routes set, clear and forward the cookie, never expose the key, refuse bad input, and answer 401 and 502 with their fixed sentences; the QR matrix for a known URL matches `uqr`'s and renders with token classes only; the design check passes on every new file; the approve and deny buttons' classes give 40px targets.
10. **Inbox:** a held call's row shows approved with its refund ID, denied, expired and waiting from recorded entries.
11. **No secrets:** across entries, API answers, CLI output and console route answers in these tests, no fake approver key, principal key or token appears.
12. The no-AI test still passes.

## Live checks (`LIVE=1`, not in the Feedback commands)

1. `LIVE=1 npm test -- packages/rail-paypal` with the PayPal variables set: create a draft invoice to an illustrative `example.com` recipient, then send it with `sendInvoice`; check the answer is `SENT` or `SCHEDULED` and a second send is refused with a 4xx.
2. `LIVE=1 npm test -- apps/gate/test/approvals-live.test.ts` with the PayPal variables: a step-up on that kind of draft invoice, approved through `answerStepUp` against the real sandbox, sends it once.
3. Once the seed has run and `COUNTERSIGN_APPROVER_KEY` and `COUNTERSIGN_SUPPORT_AGENT_KEY` are set: start the gate, run `npm run agent -- apps/gate/proposals/beat-5-damaged.json` (pending approval), then `npm run approvals -- list`, then `npm run approvals -- approve <id> --hash <hash>`. Check one sandbox refund of $240.00 on KIK-1037's capture, then `npm run ledger -- verify`.

## Manual checks for the human

1. Start the gate, resolve-agent and the console. Simulate beat 5 in the inbox, open `/approvals`, sign in with the approver key, and check the card reads as itemized to a stranger: what's asked, for whom, why it waits, what the records say.
2. Scan the QR code with a phone on the same network (or the hosted URL from phase 13), approve the card there with one tap, and check the inbox shows the refund ID. Check the 40px buttons, light and dark, and "Add to Home Screen".
3. Let a card expire and check it says expired and can't be approved.
4. Read every outcome sentence and the sign-in copy against the brand book.
