# Phase 6 plan: a refund executes once, live

Roadmap item 6, brief §5 items 1 and 2. A refund proposal is decided on live sandbox records, read through phase 5's rail client and carrier mock and mapped into the verifiers' snapshots. An allowed refund executes on PayPal exactly once, even on replay, and `PAYMENT.CAPTURE.REFUNDED` (or a poll of the refund) reconciles it in the audit log. This closes gate G1: a refund intent gets allow, step-up or deny from the CLI, and the audit log verifies.

Step-ups are recorded and wait; approvals come in phase 9. The MCP surface comes in phase 7: this phase builds the gate function it will call, plus a CLI.

## Approach

```text
proposal file (order KIK-10NN, ticket, create_refund args)
        │  npm run propose
        ▼
gate: read live records ──▶ rail-paypal: get capture, get order (payer, trackers, refunds),
        │                                list disputes for the capture
        │                    carrier-mock: shipment for the capture's tracker
        │                    (a read that fails leaves its snapshot out → unknown)
        ▼
one audit-log transaction, under the ledger lock
        │  execution history from the log ─▶ ExecutionSnapshots
        │  replay?  same intent already requested ─▶ answer from the log (below)
        │  decide() ─▶ decision entry
        │  allow ─▶ execution.requested entry
        ▼
rail-paypal: refund capture, PayPal-Request-Id = intent hash, custom_id = intent ID
        ▼
execution.result entry (executed | failed | unknown)

POST /webhooks/paypal ─▶ verify signature (raw body) ─▶ PAYMENT.CAPTURE.REFUNDED
        ─▶ re-read the refund ─▶ reconciliation entry (deduplicated by event ID)
npm run reconcile ─▶ re-read each unreconciled refund ─▶ reconciliation entry (source poll)
```

Shapes follow ADR 0025 (the new PayPal calls) and ADR 0026 (execution entries and exactly-once).

## Modules touched

| Module | What it gains |
|---|---|
| `packages/rail-paypal` | Refunds on order records; refund capture; get refund; list disputes by capture with paging; webhook signature verification over the raw body; `PAYPAL_WEBHOOK_ID` parsing. Fixtures and contract tests for each |
| `packages/ledger` | The entry types `execution.requested`, `execution.result` and `reconciliation`, so appends accept them and `ledger verify` knows them |
| `apps/gate` | Live record reading and mapping into snapshots; the execution history read from the log; `proposeRefund()` (decide, record, execute, replay); the `propose` CLI and demo proposal files; the PayPal webhook route; the `reconcile` CLI |
| root | `propose` and `reconcile` scripts. README sections |

`packages/mandate`, `packages/verifiers` and `packages/carrier-mock` stay untouched: the verifiers already read `ExecutionSnapshot`s, and the carrier adapter is used as it is. The `decide` CLI and its fixture cases keep working unchanged.

## Order of work

1. In any order, since they share nothing: the refund calls (T-001), the dispute and webhook calls (T-002), the entry types and the execution history (T-003).
2. Live record reading (T-004), after T-001 and T-002.
3. Deciding under the lock (T-005), after T-003 and T-004. Then execution and replays (T-006).
4. The `propose` CLI and demo proposal files (T-007), after T-006.
5. The webhook route (T-008) and the `reconcile` CLI (T-009), after T-001, T-002 and T-003. They don't need T-005.
6. The live checks (T-010), any time after T-002. They run only under `LIVE=1`.

## New dependencies

No new npm packages. Express 5's built-in `express.raw` reads the webhook body. New workspace links, installed by the planner:

- `@countersign/gate` depends on `@countersign/rail-paypal` and `@countersign/carrier-mock`.

## Notes for the loop

- The loop can't reach PayPal or read `.env.*`. Every test uses recorded fixtures and an injected `fetch` or a fake client, with env passed explicitly (phase 4's gotcha: a cloud session may hold real values).
- The gate's tests need a stateful fake sandbox: orders with captures, trackers and refunds, refunds that replay by request ID, a disputes list, and a webhook verifier that answers SUCCESS or FAILURE. Build it in `apps/gate/test/`. Don't import the storefront's fake across workspaces.
- Fixtures follow PayPal's documented shapes and spike S1's values, with emails replaced by `@example.com` addresses. T-010 checks real responses against the same schemas.
- `PAYPAL_WEBHOOK_ID` isn't set anywhere yet. It exists once phase 13 registers a webhook on the hosted URL. Code that needs it reports it missing by name and refuses to verify; nothing falls back to accepting unverified events.
- The webhook handler is a plain function with its dependencies injected, mounted by `createApp`. Test it with Express's app and a fake, never a listening port the sandbox can't reach.

## Risks

- **Fixtures that drift from live responses,** especially the order's refunds list and the `PAYMENT.CAPTURE.REFUNDED` resource. The schemas only require fields we use, and the webhook handler re-reads the refund by ID rather than trusting the body. T-010 parses live refunds and disputes under `LIVE=1`.
- **No seeded orders in the sandbox yet.** The live refund needs the two vault tokens from `.ralph/human.md`. Until then, everything is proven against the fake sandbox and the live refund check waits.
- **No public URL.** The live webhook can't arrive until phase 13. `npm run reconcile` reconciles by polling, so the cloud session can still prove the reconciliation path against the sandbox once a refund exists.
- **A crash between the request and the result** leaves a request that blocks other refunds on its capture. That's fail closed by design (ADR 0026); `npm run reconcile` reports it, and a replay of the same proposal completes it.
- **Holding the lock while reading the log.** Live PayPal reads happen before the transaction, so the lock is held only for log reads and appends, never across a network call.
