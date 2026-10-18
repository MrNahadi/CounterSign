# Phase 7 plan: the gate over MCP

Roadmap item 7, brief §5 item 1. An agent connects to Countersign's MCP server with a principal key and calls PayPal's tool names. Every guarded PayPal action gets allow, step-up or deny, with reason codes, recorded in the audit log. Read-only tools pass through to the sandbox. Refunds execute exactly as in phase 6. Nothing else executes yet: step-ups wait for phase 9, and an allow for an action the gate has no call for is denied `ACTION_UNAVAILABLE`.

## Approach

```text
agent (any MCP client)
   │  POST /mcp   Authorization: Bearer <principal key>
   ▼
gate: key ─▶ principal ─▶ mandate (support-agent → kikapu-studio v3)        401 if no match
   │  one low-level MCP Server per request (stateless, JSON mode)
   │
   ├─ tools/list  ─▶ guarded tools (PayPal names + extensions) and read-only tools,
   │                 input schemas generated from the gate's own zod schemas
   │
   ├─ tools/call guarded ─▶ propose()
   │     live reads by action ─▶ capture/order/disputes/carrier   (refund)
   │                             get dispute                      (dispute actions)
   │                             get invoice                      (send_invoice)
   │                             get order                        (pay_order)
   │                             ticket store, by justification.ticket_id
   │     one audit-log transaction: history ─▶ replay? ─▶ decide() ─▶ decision entry
   │     refund allowed ─▶ execution.requested ─▶ refund call ─▶ execution.result (phase 6)
   │     other action allowed ─▶ decide() makes it deny ACTION_UNAVAILABLE
   │     result: the agent response, as structuredContent and JSON text
   │
   └─ tools/call read-only ─▶ rail-paypal / carrier mock ─▶ records, money as { value, currency_code }

npm run agent -- <proposal file>   stand-in agent: writes the file's simulated tickets, then
                                   calls the gate over MCP with the principal key
```

Decisions behind it: ADR 0027 (targets and hashed parameters per action), ADR 0028 (the MCP surface, principal keys, pass-through reads, `ACTION_UNAVAILABLE`) and ADR 0029 (the ticket store).

## Modules touched

| Module | What it gains |
|---|---|
| `packages/mandate` | The intent target as one shape per action; hashed parameters for actions other than a refund (a refund's hashed JSON unchanged); an optional ticket outside refunds; reason codes `TARGET_UNKNOWN` and `ACTION_UNAVAILABLE` |
| `packages/verifiers` | Snapshots for a dispute, an invoice and an order's amount; the capture-based verifiers return unknown for a target that isn't a capture |
| `packages/rail-paypal` | Get dispute, get invoice, transaction search, with fixtures and contract tests |
| `packages/db` | The `tickets` table, its migration, and a write-once writer and a reader |
| `apps/gate` | Normalizing every guarded PayPal tool; `propose()` for every action (generalizing `proposeRefund`); principal keys; `POST /mcp` with guarded and read-only tools; the stand-in agent CLI and a demo file for the other guarded actions; the propose CLI writes its tickets to the store |
| root | An `agent` script. README section |

`packages/ledger` and `packages/carrier-mock` stay untouched. The `decide`, `propose` and `reconcile` CLIs keep working, and every phase 3 and phase 6 test keeps passing (refund hashes don't change).

## Order of work

1. In any order, since they share nothing: intent targets (T-001), the new rail calls (T-002), the ticket store (T-005), principal keys (T-007).
2. Normalizing the dispute tools (T-003), then the invoice, order-capture and payout tools with their fixture cases (T-004). Both need T-001.
3. `propose()` for every action (T-006), after T-002 to T-005.
4. The MCP endpoint (T-008), after T-006 and T-007. Then read-only tools (T-009) and the stand-in agent CLI (T-010), in either order.
5. Live checks (T-011), any time after T-002. README and glossary (T-012) last.

## New dependencies

None. `@modelcontextprotocol/sdk` 1.32.1 (server and client) and `express` 5.3.0 are already gate dependencies, and zod 4.6.7 comes from the root. No new workspace links: the gate already depends on every package it uses.

## Notes for the loop

- The loop can't reach PayPal or read `.env.*`. Every test uses recorded fixtures, the gate's fake sandbox (`apps/gate/test/fake-sandbox.ts`, extend it with disputes by ID, invoices and transactions), and env passed explicitly.
- MCP tests use the SDK's real `Client` with `StreamableHTTPClientTransport` against `createApp(...)` listening on `127.0.0.1` port 0, as `test/health.test.ts` does, so they exercise the real HTTP path, headers and auth. Close the server after each test.
- Test principal keys are made-up 32+ character strings passed in `env`; never read `process.env` in tests.
- Fixtures follow PayPal's documented shapes (Customer Disputes v1 show dispute, Invoicing v2 show invoice, Transaction Search v1), with emails replaced by `@example.com` addresses. T-011 checks real responses against the same schemas under `LIVE=1`.
- The demo mandate isn't changed. With it, dispute actions and invoice send step up `ALWAYS_NEEDS_APPROVAL`, and payouts and order captures are denied `NO_MATCHING_RULE`. `ACTION_UNAVAILABLE` is tested with a fixture mandate that allows `paypal.order.capture`.

## Risks

- **SDK validation hiding invalid proposals.** `registerTool` would refuse bad arguments before the gate sees them, so they'd never be logged. ADR 0028 uses the low-level `Server` instead; T-008 checks a malformed call gets a recorded `INVALID_PROPOSAL`.
- **Refund hashes drifting.** Any change to `hashIntent` could orphan phase 6's execution entries. T-001 pins the refund's canonical JSON with the existing hand-written reference string.
- **Transaction Search in the sandbox** needs the app's Transaction Search permission and lags about three hours. A 403 is an ordinary read problem; T-011 records what the sandbox answers.
- **No principal key in the cloud environment yet.** Everything runs against test keys; the live MCP check waits for `COUNTERSIGN_SUPPORT_AGENT_KEY` (`.ralph/human.md`).
- **No seeded orders or disputes in the sandbox yet.** The live run of `npm run agent` waits for the seed buyers, as phase 6's does; dispute tools are proven against fixtures until the human opens a sandbox dispute.
