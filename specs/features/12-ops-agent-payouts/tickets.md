# Phase 12 tickets: ops-agent supplier payouts

## T-001: The payee list, payout reason codes and the bill reference in the mandate

Status: done
Blocked by:
Tier: standard
Slice: A mandate can carry a signed payee list, the ops mandate exists, and a payout intent hashes its bill reference.
Test seam: `@countersign/mandate`'s `parseMandate`, `hashMandate`, `hashIntent`, `evaluate` and `REASONS`
Acceptance:
- [x] `payees` parses as requirements.md says; a repeated, upper-case, untrimmed or malformed email and more than 100 entries are refused with an issue at the entry
- [x] `kikapu-studio-ops-v1.json` parses with the values in requirements.md; the kikapu-studio v3 hash is unchanged
- [x] `PAYEE_LIST_UNKNOWN` exists with the words and hint given; a rule requiring `payee.allowlisted` denies with it on unknown (and when it's missing from the trace), and still denies on fail (`VERIFIER_UNAVAILABLE` until T-004); `payee-list-missing.json` reaches it, and the "every code is reached" test covers 26 codes
- [x] A payout's hash covers `reference` when set; without it, and for every other action, every existing hash test passes unchanged
Notes:
- ADR 0040: `PAYEE_NOT_ALLOWLISTED` and its fail mapping moved to T-004, the ticket whose decision case first reaches it.
- `payee-list-missing.json`'s payout has no `reference` yet: `create_payout` refuses it until T-004.

## T-002: The `payee.allowlisted` verifier

Status: open
Blocked by: T-001
Tier: simple
Slice: The verifiers check a payout's email against the mandate's payee list snapshot.
Test seam: `@countersign/verifiers`' `runVerifiers` with a `payees` snapshot
Acceptance:
- [ ] Pass for a listed email in any case or spacing, naming the payee and the list's ID; fail for an unlisted one
- [ ] Unknown with no snapshot, and for an intent whose target isn't a payee
- [ ] The trace entry's record names `mandate payees` and the list's ID, or the call it looked for
- [ ] It runs only when required; a refund's trace is unchanged
Notes:

## T-003: The rail client's payout calls

Status: open
Blocked by:
Tier: standard
Slice: `@countersign/rail-paypal` creates a payout batch with a request ID, and reads a batch and an item back.
Test seam: the PayPal client's public methods against the fake PayPal server, plus one `LIVE=1` case
Acceptance:
- [ ] Create payout sends the path, `PayPal-Request-Id`, `sender_batch_header` and one item as requirements.md says, with the amount as PayPal's string, and answers the batch ID and status
- [ ] Bad input (not USD, zero amount, bad receiver, note over 4000, bad `sender_item_id`, no request ID) is refused before sending
- [ ] Get payout batch and get payout item parse into minor units with statuses as text
- [ ] A duplicate-batch refusal fixture is recognised by `isDuplicateBatch`; other 4xx fixtures aren't
- [ ] Under `LIVE=1`: a $1.00 payout, its replay with the same request ID giving the same batch, a refused reused `sender_batch_id`, and both reads
Notes:

## T-004: The ops principal and payout decisions

Status: open
Blocked by: T-002
Tier: standard
Slice: An agent with the ops key proposes a payout over MCP and gets a step-up for a listed supplier or a denial for anyone else; the support agent's payouts stay denied.
Test seam: `loadPrincipals`, `decide()` and the gate's MCP server over a real listening gate with test keys
Acceptance:
- [ ] `COUNTERSIGN_OPS_AGENT_KEY` authenticates `ops-agent` with the ops mandate; equal principal keys both count as unset; the approver key must differ from both; startup lines name variables only
- [ ] `create_payout` requires `reference` and USD, and its intent carries `{ note, reference }`; existing payout tests and `guarded-actions.json` gain a reference and still pass
- [ ] `decide()` sets the `payees` snapshot from the deciding mandate only, so records can't add a payee
- [ ] The four outcomes in requirements.md hold, and `apps/gate/fixtures/cases/ops-payouts.json` matches its expectations under `npm run decide`
- [ ] The tools-list fixture is re-recorded with the new description and schema
- [ ] `PAYEE_NOT_ALLOWLISTED` joins the catalog with requirements.md's words and hint; `payee.allowlisted` fail maps to it (the evaluator's fail case changes from `VERIFIER_UNAVAILABLE`); with `ops-payouts.json` the "every code is reached" test covers 27 codes; the payout in `payee-list-missing.json` gains a reference and still expects `PAYEE_LIST_UNKNOWN`
Notes:
- ADR 0040 moved `PAYEE_NOT_ALLOWLISTED` here from T-001, because this ticket's `ops-payouts.json` is the first decision case that reaches it.

## T-005: The agent CLI as the ops agent

Status: open
Blocked by: T-004
Tier: simple
Slice: `npm run agent -- apps/gate/proposals/ops-payouts.json` proposes as the ops agent with its own key.
Test seam: the agent CLI's run function against a listening gate on PGlite, with test keys
Acceptance:
- [ ] The file's `principal` picks the key variable; an unknown principal or a missing key exits 2 and names the variable, never the value
- [ ] `ops-payouts.json` exists with the three proposals in requirements.md, and every expectation matches
- [ ] Proposals with no ticket write no ticket; the support agent's files still run unchanged
Notes:

## T-006: The payout executor

Status: open
Blocked by: T-003, T-004
Tier: standard
Slice: An approved payout runs once on PayPal and its batch and item are logged.
Test seam: `execute()`, `propose()` and `answerStepUp` over PGlite with the fake sandbox
Acceptance:
- [ ] `EXECUTABLE_ACTIONS` gains `paypal.payout`; tests that used a payout as unexecutable switch to order capture, still `ACTION_UNAVAILABLE`
- [ ] Approving a payout step-up sends one payout with the intent hash, intent ID, reference, note and fixed subject, reads the batch, and records `payout: { batchId, batchStatus, item }`
- [ ] Approving again or re-proposing sends nothing
- [ ] `DENIED` is `failed`; a 4xx `failed`; a duplicate-batch refusal, an unknown batch status and a 5xx `unknown`; a failed batch read leaves `item` null
- [ ] Executed payouts count in the ops agent's usage; the approve answer carries `payout`; every older execution entry still reads
Notes:

## T-007: Payout reconciliation by poll

Status: open
Blocked by: T-006
Tier: standard
Slice: `npm run reconcile` re-reads payouts still open at PayPal and logs their new status.
Test seam: the reconcile CLI's run function with a fake rail and PGlite
Acceptance:
- [ ] The `reconciliation` schema gains the payout form; every older entry still reads
- [ ] An executed payout whose item is `UNCLAIMED` is re-read; a changed status is logged once, with the matched result; a second run logs nothing
- [ ] A payout with a final status isn't re-read; the output lines and exit codes are as requirements.md says
- [ ] Refund reconciliation still passes its tests unchanged
Notes:

## T-008: The payouts webhook

Status: open
Blocked by: T-007
Tier: standard
Slice: A signed `PAYMENT.PAYOUTS-ITEM.*` event makes the gate re-read the item and reconcile it once.
Test seam: `handlePayPalWebhook` with a fake verifier and fake rail, and the webhook route over HTTP
Acceptance:
- [ ] A verified item event logs one reconciliation from the re-read item, never the body; a redelivered event ID writes nothing
- [ ] An item of a batch Countersign didn't send is logged with a null ref; an unreadable item or log answers 503
- [ ] `PAYMENT.PAYOUTSBATCH.*` is acknowledged and ignored; refund and dispute webhooks still pass
- [ ] A signed fixture `apps/gate/webhooks/payout-item-succeeded.json` exists
Notes:

## T-009: Approval cards for payouts

Status: open
Blocked by: T-006
Tier: simple
Slice: A held payout's card shows exactly who gets paid, how much, for which bill, and with which note.
Test seam: the gate's card builder and the approval API over a real listening gate
Acceptance:
- [ ] A payout card carries `params: { kind: "payout", reference, note, payee_name }`, the name from the ops mandate found by hash
- [ ] `can_execute` is true for a payout; existing card tests still pass
- [ ] The ops key gets 401 on the approval API
Notes:

## T-010: Audit reader lines for payouts

Status: open
Blocked by: T-007
Tier: simple
Slice: The audit console and `audit` CLI describe payout results and reconciliations in words.
Test seam: the gate's audit-reader exports over PGlite
Acceptance:
- [ ] Payout results and reconciliations summarise as requirements.md says; an unreadable one says it can't be read
- [ ] Decision rows for payouts show the payee as target and "Payout sent" when executed; the trail includes request, result and reconciliations
- [ ] `payee.allowlisted` reads as requirements.md says in claims vs records; existing reader tests pass
Notes:

## T-011: The console for payouts

Status: open
Blocked by: T-009, T-010
Tier: standard
Slice: On the phone the merchant reads a held payout and approves it; the decision page shows the payout and its later status.
Test seam: `apps/console/src/` approvals, decisions and decision view models and their schemas
Acceptance:
- [ ] The card schema accepts the payout `params`; the view gives the "What you're approving" rows and copy in requirements.md
- [ ] The approve answer and recent summaries read `execution.payout`
- [ ] Decisions and decision-page lines word payout results, reconciliations and item statuses as given; older answers still parse
- [ ] The design check passes on every new or changed file
Notes:

## T-012: Demo files, live check and README

Status: open
Blocked by: T-005, T-008, T-011
Tier: standard
Slice: A supplier payout can be run end to end against the sandbox from the README, and the live check exists.
Test seam: `apps/gate/test/payouts-live.test.ts` (skips with a reason unless `LIVE=1` and the PayPal variables are set) and the README
Acceptance:
- [ ] The live test proposes with a test ops key, approves with a test approver key, checks one payout on the sandbox and reconciles it; it skips cleanly without its variables
- [ ] `npm test` runs the payout from `ops-payouts.json` through approval to a reconciled `SUCCESS` against the fake sandbox
- [ ] README gains "Pay a supplier" (the ops key, the payee list, the card, reconcile, what's illustrative) and marks phase 12 done; CONTEXT.md's payout terms match what was built
Notes:
