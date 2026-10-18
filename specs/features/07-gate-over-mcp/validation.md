# Phase 7 validation: the gate over MCP

## Automated checks

All run from the repo root and are part of the Feedback commands, except the live checks.

1. `npm run typecheck`, `npm run lint`, `npm test` and `npm run build` pass.
2. **Refund hashes unchanged:** phase 3's hand-written reference canonical string still hashes to the refund intent's hash, and every phase 3 fixture case and phase 6 test passes unchanged.
3. **Hashes for the new actions:** for each action, changing its target, amount or any hashed parameter (note, offer type, recipients, an evidence item) changes the hash; key order doesn't. A dispute action and a payout with no ticket hash with `ticketId: null`.
4. **Fixture cases:** new cases in `apps/gate/fixtures/cases/` give, under the demo mandate, step-up `ALWAYS_NEEDS_APPROVAL` for each dispute tool and `send_invoice`, deny `NO_MATCHING_RULE` for `pay_order` and `create_payout`, and deny `TARGET_UNKNOWN` for an unreadable dispute and invoice. The "every code is reached" test covers 25 codes.
5. **Rail calls:** get dispute, get invoice and transaction search parse their fixtures into minor units, refuse malformed IDs before any call, and turn 404 and 5xx into `PayPalError`s with no secret in any request, error or result.
6. **Ticket store:** a ticket writes and reads back; rewriting it unchanged is a no-op; rewriting it changed is refused and the stored ticket is untouched. Over PGlite.
7. **Gate reads tickets:** a refund proposal whose ticket ID isn't in the store gets `ticket.from_payer` unknown and is denied; with the stored payer ticket, beat 4 is allowed as in phase 6.
8. **`ACTION_UNAVAILABLE`:** with a fixture mandate that allows `paypal.order.capture`, a fixture case gives `pay_order` deny `ACTION_UNAVAILABLE`; through `propose()`, the fake sandbox records no capture call and the decision entry keeps the intent, trace and matched rule.
9. **Authentication:** over a real listening server on `127.0.0.1`, `/mcp` answers 401 with the same body for no header, a wrong scheme, a short key, an unknown key and no keys configured; the correct key gets a working MCP session. `GET` and `DELETE /mcp` answer 405.
10. **MCP end to end:** an SDK `Client` with the support agent's key lists every tool in requirements.md's table, with extensions described as such; `create_refund` on beat 4 is allowed and the fake sandbox shows one refund; calling it again is a replay with no second refund; beat 3's five proposals give 4 denials and 1 step-up as phase 6's file expects; a malformed `create_refund` returns `denied` `INVALID_PROPOSAL` with `isError: false` and adds a decision entry; an unknown tool is `UNKNOWN_ACTION` and recorded; `ledger verify` passes afterwards.
11. **Read-only tools:** each one returns the fake sandbox's record with money as `{ value, currency_code }`; `get_shipment_tracking` marks carrier data simulated; a failing read is `isError: true` with a fixed line; no read adds an audit-log entry.
12. **Stand-in agent CLI:** `runAgent` against a listening gate with a PGlite store matches every `expect` in `beat-4-stalled-parcel.json` and `guarded-actions.json` (exit 0); a 401 or unreachable gate exits 2 naming the problem; a missing key variable is named, never shown. One child-process run of the entry point.
13. The no-AI test covers the gate's MCP and propose modules and still passes.

## Live checks (`LIVE=1`, not in the Feedback commands)

1. `LIVE=1 npm test -- packages/rail-paypal`: get dispute and get invoice of made-up IDs answer 404 as `PayPalError`s; transaction search for the last day parses (an empty list is fine), or the test records the sandbox's 403 if the app lacks Transaction Search.
2. Once `COUNTERSIGN_SUPPORT_AGENT_KEY` is set and the seed has run: start the gate (`npm run dev --workspace @countersign/gate`) and run `npm run agent -- apps/gate/proposals/beat-4-stalled-parcel.json`, then `npm run agent -- apps/gate/proposals/guarded-actions.json`. Check every decision matches and `npm run ledger -- verify` passes.

## Manual checks for the human

1. Set `COUNTERSIGN_SUPPORT_AGENT_KEY` (32+ random characters) in the Dev environment and `.env.example`, then run live check 2.
2. Point any MCP client you use (for example an MCP inspector) at `http://127.0.0.1:8787/mcp` with the key as a bearer token. Check the tool list reads sensibly to a developer who knows PayPal's Agent Toolkit: PayPal's names where they exist, extensions marked.
3. Once a sandbox dispute exists (`.ralph/human.md`, phase 11), call `get_dispute` and `accept_dispute_claim` on it and check the step-up names the dispute's real amount.
4. Read the `TARGET_UNKNOWN` and `ACTION_UNAVAILABLE` words and hints against the brand book.
