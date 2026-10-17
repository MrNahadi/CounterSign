# Phase 3 plan: decide a refund from records

Roadmap item 3, brief §5 item 1. Given an order's recorded PayPal and carrier facts, a refund intent gets allow, step-up or deny from a CLI, with reason codes and a verifier trace. Everything runs from fixtures. Nothing calls a live system, writes to a database or moves money. Execution, the audit log and live records come in phases 4 to 6.

## Approach

The decision path from brief §6, steps 2 to 4, built as pure functions with `now` passed in:

```text
case file ─▶ normalize proposal ─▶ intent (+ intent hash)
                                       │
            record snapshots ─▶ run verifiers ─▶ verifier trace + today's usage
                                       │
            signed mandate ─────▶ evaluate rules ─▶ decision (+ reason codes)
                                       │
                                       ▼
                     agent response, and the CLI's readable output
```

Shapes and placement follow ADR 0019:

- Verifiers read normalized snapshots that carry their source call and record ID.
- The types shared across packages live in `@countersign/mandate`.
- Hashing uses in-house RFC 8785 over integer-only JSON.
- Step-up and deny rules name a reason code.

## Modules touched

| Module | What it gains |
|---|---|
| `packages/mandate` | Money values; canonical JSON and SHA-256 hashing; known actions and verifier names; the intent schema and intent hash; the reason-code catalog (code, merchant-facing words, customer-safe reply hint); the mandate schema, mandate hash and the fixture mandate; the verifier trace entry shape (ADR 0019: the evaluator reads it); the rule evaluator |
| `packages/verifiers` | Record snapshot types; `capture.refundable`, `ticket.from_payer`, `dispute.none_open`, `shipment.status`, `evidence.photo_present`, `ledger.not_duplicate`; today's usage for limits; `unknown` for every named verifier not built yet |
| `apps/gate` | Normalizing a `create_refund` proposal into an intent; `decide()`, which runs normalize, verify and evaluate; the agent response (brief original §6 shapes); fixture decision cases; the `decide` CLI |
| root `package.json` | A `decide` script that runs the CLI |

`packages/ledger`, `packages/db`, `packages/rail-paypal` and `packages/carrier-mock` stay untouched in this phase.

## Order of work

1. Foundations in `@countersign/mandate`: money, canonical JSON, the intent and its hash (T-001), then the reason codes and the mandate schema (T-002).
2. Verifiers, starting with the trace shape and the two PayPal checks (T-003). The carrier, dispute and photo checks (T-004) and the audit-log checks (T-005) can run in either order.
3. The evaluator: the core steps (T-006), then escalations and the fail-closed property (T-007).
4. The gate's proposal normalization (T-008). It needs only T-001 and T-002, so the loop may take it earlier.
5. End to end: `decide()`, the agent response and the fixture case suite (T-009), then the CLI (T-010).

## New dependencies

No new npm packages. Workspace links, declared the way the console declares `@countersign/graphite` (`"0.0.0"`):

- `@countersign/verifiers` depends on `@countersign/mandate`.
- `@countersign/gate` depends on `@countersign/mandate` and `@countersign/verifiers`.

The human adds these and runs `npm install` before the loop starts, so the lockfile stays consistent for `npm ci`. zod 4.6.7 comes from the root, as tech-stack.md says. tsx is already a gate dependency.

## Fixture values

The fixture mandate uses the original brief §7's refund rules:

- $80 auto-refund for a lost or stalled parcel;
- step-up for a delivered "never arrived" claim;
- $50 auto-refund for a damaged item with a photo;
- step-up for dispute and invoice actions;
- daily limits of $300 or 5 refunds, and KSh 15,000.

It adds the wrong-item step-up rule that brief §4 item 5 asks for. These are test values. The demo mandate's real limits come from the merchant interviews (G7), and the bench freezes it in phase 14.

## Risks

- **Snapshot fields that live PayPal responses lack.** Snapshot fields are limited to what spikes S1 and S2 saw in real sandbox responses: the capture status, amount and refunds; the order's `payer.email_address` and trackers; the dispute list. Phase 6's mappers and contract tests close the gap.
- **The fail-closed rule slipping through the evaluator's branches.** T-007's seeded randomized test checks the invariant directly: an allow implies a matched rule whose every requirement passed.
