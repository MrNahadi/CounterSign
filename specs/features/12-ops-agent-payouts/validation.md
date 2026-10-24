# Phase 12 validation: ops-agent supplier payouts

## Automated checks

All run from the repo root and are part of the Feedback commands.

1. `npm run typecheck`, `npm run lint`, `npm test` and `npm run build` pass.
2. **Mandate:** the ops fixture parses; a payee list with a repeated, upper-case or malformed email is refused; the kikapu-studio v3 hash and every existing intent hash are unchanged; a payout's hash changes with its reference; `PAYEE_NOT_ALLOWLISTED` and `PAYEE_LIST_UNKNOWN` have words and hints and the "every code is reached" test covers them.
3. **Verifier:** `payee.allowlisted` passes a listed email (any case and spacing), fails an unlisted one, and is unknown with no list or a non-payout target, each naming its record.
4. **Decisions:** `npm run decide -- apps/gate/fixtures/cases/ops-payouts.json` matches every expectation; over MCP with a test ops key, a listed payee steps up, an unlisted one is denied `PAYEE_NOT_ALLOWLISTED`, a KES payout and a payout with no reference are `INVALID_PROPOSAL`, and a refund is `NO_MATCHING_RULE`; with the support key, a payout is `NO_MATCHING_RULE`; a `payees` snapshot in the records can't change the result; equal principal keys both count as unset.
5. **Rail client:** against the fake PayPal, create payout sends the body and headers in requirements.md with amounts as strings; bad input is refused before sending; batch and item reads parse into minor units; a duplicate-batch fixture is recognised; nothing but the request-ID POST retries.
6. **Executor:** approving the ops step-up sends one payout with the intent hash, intent ID and reference, reads the batch, and records `payout`; approving again or re-proposing sends nothing; `DENIED` is `failed`, a 4xx `failed`, a duplicate-batch refusal and a 5xx `unknown`; executed payouts count in the ops agent's usage; order capture is still `ACTION_UNAVAILABLE`.
7. **Reconciliation:** `npm run reconcile` re-reads an `UNCLAIMED` payout, logs a reconciliation when it becomes `SUCCESS`, and logs nothing on a second run; a signed `PAYMENT.PAYOUTS-ITEM.SUCCEEDED` fixture logs one reconciliation from the re-read item, a redelivery none; refund and dispute webhooks still work.
8. **Cards, reader and console:** a payout card carries `params` with the payee name and reference; reader summaries and trail lines read as requirements.md says; console view models give the "What you're approving" rows and the status words; the design check passes on every changed file.
9. **No AI in the decision path:** the no-AI test still passes.

## Live checks (`LIVE=1`, not in the Feedback commands)

1. `LIVE=1 npm test -- packages/rail-paypal`: creates a $1.00 payout to `PAYPAL_LIVE_PAYEE_EMAIL` (or the demo supplier's address), replays it with the same request ID and gets the same batch, is refused on a reused `sender_batch_id`, and reads the batch and item back. Record the duplicate error's real name in progress.md.
2. `LIVE=1 npm test -- apps/gate/test/payouts-live.test.ts` runs a listening gate on PGlite with test principal and approver keys (it needs only the PayPal variables): the ops agent proposes a $1.00 payout to a listed payee, the step-up is approved, the payout executes once on the sandbox, and `reconcile` logs its item status.

## Manual checks for the human

1. Set `COUNTERSIGN_OPS_AGENT_KEY`, start the gate, run `npm run agent -- apps/gate/proposals/ops-payouts.json`, and check the three answers.
2. On the phone card, read the payout as the merchant: payee, amount, bill reference and note, and the illustrative label. Approve it, then find the batch in the sandbox merchant dashboard.
3. Run `npm run reconcile` after the payout settles (or the payee claims it), and check the decision page's trail shows the new status.
4. Once phase 13's public URL exists, add the `PAYMENT.PAYOUTS-ITEM.*` events to the sandbox webhook and check a status change reconciles without `npm run reconcile`.
5. Check the card and the decision page in light and dark, at desktop and phone width, and read the copy against the brand book.
