# Phase 12 plan: ops-agent supplier payouts

Roadmap item 12, brief §5 item 15. An ops agent, with its own principal key and its own signed mandate, pays a supplier on the mandate's payee list through PayPal Payouts. Every payout steps up, so the merchant approves exactly that payout on the phone before anything is sent. A payee who isn't on the list is denied. The support agent's payouts stay denied, because its mandate has no payout rule. The payout then reconciles as its item's status changes (unclaimed, succeeded, returned), by `npm run reconcile` until phase 13's public URL and by the payouts webhook after.

## Approach

```text
npm run agent -- apps/gate/proposals/ops-payouts.json   (principal ops-agent, COUNTERSIGN_OPS_AGENT_KEY)
        │ MCP create_payout { receiver, amount (USD), reference, note? }
        ▼
gate: principal key → ops-agent → mandate kikapu-studio-ops v1 (payees: [...])
   normalize: payee target (email), params { note, reference }   (reference hashed when set)
   decide(): records.payees = the deciding mandate's list (call "mandate payees", id "kikapu-studio-ops v1")
   payee.allowlisted  pass → rule payout-listed-supplier → STEP_UP ALWAYS_NEEDS_APPROVAL
                      fail → DENY PAYEE_NOT_ALLOWLISTED
   support-agent's create_payout → DENY NO_MATCHING_RULE (unchanged)
        ▼
phone card: payee name and email, amount, bill reference, note  ──approve──▶
   executor: POST /v1/payments/payouts   PayPal-Request-Id = intent hash, sender_batch_id = intent ID,
             one item, sender_item_id = reference          ── sent once, never re-sent by the gate
             GET /v1/payments/payouts/{batch}  → item id and status
   execution.result { payout: { batchId, batchStatus, item: { id, status } | null } }
        ▼
npm run reconcile  ── GET /v1/payments/payouts-item/{id} ──▶ reconciliation { payout: {...} }
webhook PAYMENT.PAYOUTS-ITEM.* (from phase 13's URL) ── re-read the item ──▶ reconciliation, once per event
```

Decisions behind it: ADR 0039 (the ops principal and mandate, the payee list in the mandate, `payee.allowlisted` over a mandate snapshot, the required bill reference, USD only, the executor's request and batch IDs, reconciliation by poll and webhook, no AI ops agent). Earlier ADRs still hold: 0019 (pure verifiers over snapshots, unbuilt verifiers unknown), 0025 (webhook signature over the raw body; re-read, never trust the body), 0026 (request before the call, result after, never hold the lock across a network call), 0027 (the payee target and hashed note), 0028 (principal keys; extensions named as such), 0032 (approvals execute the stored intent), 0033 (one executor per action), 0034 (the audit API and evidence export).

## Modules touched

| Module | What it gains |
|---|---|
| `packages/mandate` | The optional `payees` list in the mandate schema; `PAYEE_NOT_ALLOWLISTED` and `PAYEE_LIST_UNKNOWN`; `reference` as a payout parameter hashed when set; the ops mandate fixture `kikapu-studio-ops-v1.json` |
| `packages/verifiers` | The `payees` snapshot and the `payee.allowlisted` verifier |
| `packages/rail-paypal` | Create payout, get payout batch, get payout item, with fixtures and fake-server support |
| `apps/gate` | The ops principal and its mandate; `create_payout` with `reference`, USD only; the payee snapshot in `decide()`; the payout executor; payout results and reconciliations; `npm run reconcile` and the webhook for payouts; card `params` for a payout; audit-reader lines; the agent CLI as either principal; demo proposals and a decision case |
| `apps/console` | The approval card's "What you're approving" for a payout; the approve answer's payout words; decisions and decision-page status and trail lines for payouts |
| root | README section "Pay a supplier"; phase 12 status |

`apps/resolve-agent` and `packages/ledger` stay untouched: the ops agent is the stand-in CLI, and no new entry type is added.

## Order of work

1. In any order: the mandate's payee list, reason codes and reference (T-001); the payouts rail calls (T-003).
2. The verifier (T-002) after T-001.
3. The gate's ops principal and payout decisions (T-004) after T-002.
4. The agent CLI as the ops agent (T-005) after T-004.
5. The payout executor (T-006) after T-003 and T-004.
6. Reconciliation by poll (T-007) after T-006; the payouts webhook (T-008) after T-007.
7. Approval cards for payouts (T-009) after T-006; audit-reader lines (T-010) after T-007.
8. Console (T-011) after T-009 and T-010.
9. Demo files, live checks and README (T-012) last.

## New dependencies

None. Every call uses the rail client's existing fetch, zod and money helpers.

## Notes for the loop

- The loop can't reach PayPal or read `.env.*`. Tests use PGlite, the fake sandbox (`apps/gate/test/fake-sandbox.ts`), the fake PayPal server (`packages/rail-paypal/test/fake-paypal.ts`), and env passed explicitly with test keys.
- Payout fixtures: build them from the Payouts v1 shapes in ADR 0039's sources and keep them in `packages/rail-paypal/test/fixtures/` (`create-payout-pending.json`, `get-payout-batch.json`, `get-payout-item-unclaimed.json`, `get-payout-item-succeeded.json`, `error-400-duplicate-batch.json`). Batch and item IDs look like `5UXD2E8A7EBQJ`.
- The payee list comes only from the mandate that decides. A test must show that a `payees` snapshot in the proposal's records is ignored.
- Every existing intent hash is pinned by tests and must stay unchanged; the reference is hashed only when set.
- Tests that use a payout as "an action with no executor" (`answer-step-up.test.ts`, `propose-invoice.test.ts`) switch to order capture (`pay_order`), which stays `ACTION_UNAVAILABLE`.
- Existing payout proposals (`apps/gate/test/proposal.test.ts`, `apps/gate/proposals/guarded-actions.json`, `apps/gate/fixtures/cases/invoice-order-payout.json`) gain a `reference`, so they still reach the mandate and are denied `NO_MATCHING_RULE`.
- The tools-list fixture (`apps/gate/test/fixtures/tools-list.json`) is re-recorded when `create_payout`'s schema changes; Resolve's tool count doesn't change.
- Time is injected everywhere. Never sleep.
- UI tickets: read `Graphite Design/DESIGN.md`, the Card, Badge, Table and Code READMEs and `brand-book.md` first. Build view models in `apps/console/src/` and test them there.

## Risks

- **Paying the same bill twice.** The same payee, amount, note and reference is one intent and is sent at most once. A changed amount or note on the same reference is a new intent, and the merchant sees the reference on the card. A paid-bill verifier can follow with the bench.
- **The duplicate-batch error's name.** PayPal's docs describe the refusal but not its name. The rail client marks it by name or issue (`DUPLICATE` or `SENDER_BATCH_ID`), the executor records it `unknown`, never `failed`, and the `LIVE=1` check records the real response.
- **Sandbox payout behaviour.** Payouts must be enabled on the sandbox app, and payouts to an address with no sandbox account end `UNCLAIMED`. The live check accepts `UNCLAIMED` or `SUCCESS`, and `PAYPAL_LIVE_PAYEE_EMAIL` (optional) names a sandbox personal account for a `SUCCESS` run.
- **Two mandates.** Approval cards and the audit reader already look a step-up's mandate up by hash from the loaded list; a test must show a payout card finds the ops mandate.
