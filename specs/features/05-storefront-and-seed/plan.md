# Phase 5 plan: Kikapu storefront and seed

Roadmap item 5, brief §5 item 7. A shopper buys on the Kikapu storefront with PayPal JS SDK v6. A seed script creates about 30 real sandbox orders with captures and trackers, and the carrier mock reports lost, stalled, in-transit and delivered. Nothing here decides or refunds anything. Phase 6 reads these orders and shipments to decide on live records.

## Approach

```text
seed catalog (30 demo orders, 8 products)
        │
npm run seed ──▶ rail-paypal: vault order (buyer A or B) ─▶ capture COMPLETED, payer email
        │                     add tracker (capture ID + tracking number)
        │                     read the order back: capture, payer, tracker
        ├──▶ carrier_shipments: tracking number ─▶ status + scan events
        └──▶ seed_orders: KIK-10NN ─▶ PayPal order, capture, payer, tracking number

storefront (Next.js) ──▶ JS SDK v6 PayPal button (client ID only)
        │   server route: create order, priced from the catalog
        └── server route: capture ─▶ confirmation with the real order and capture IDs

carrier-mock: getShipment(tracking number) ─▶ found (status, events) | not found | unreadable
```

The shapes follow ADR 0023 (where seed state lives, and an explicit stored status) and ADR 0024 (the rail client and v6 checkout).

## Modules touched

| Module | What it gains |
|---|---|
| `packages/rail-paypal` | The sandbox guard, the OAuth token cache, safe retries, typed errors, and calls for create order, capture, get order, add tracker and get capture, with responses parsed by zod into minor units. Recorded-response fixtures and contract tests |
| `packages/db` | The `carrier_shipments` and `seed_orders` tables and their migration |
| `packages/carrier-mock` | The carrier adapter interface (documented for a real tracking API), a mock over `carrier_shipments`, and an in-memory store for tests |
| `apps/storefront` | The product catalog and the seed catalog. The seed run and its CLI (`npm run seed`). Checkout server routes. The shop pages with the v6 PayPal button |
| root | The `seed` script. The no-AI test covers `rail-paypal` and `carrier-mock`. README sections |

`packages/mandate`, `packages/verifiers`, `packages/ledger` and the gate stay untouched, apart from importing `parseMoney`, `formatMoney`, `ShipmentStatus` and the timestamp rule from `@countersign/mandate`.

## Order of work

1. In any order, since they share nothing: the rail client's base (T-001), the two tables (T-003) and the catalogs (T-005).
2. The rest of the rail calls (T-002), after T-001. The carrier mock (T-004), after T-003.
3. The seed run (T-006), once T-002, T-004 and T-005 are done. Then its CLI and README section (T-007).
4. The storefront's server routes (T-008), after T-002 and T-005. Then its pages and the v6 button (T-009).
5. The live checks (T-010), any time after T-002. They run only under `LIVE=1`.

## New dependencies

Installed by the planner on 17 Oct 2026, with exact versions at least two weeks old (ADR 0021's rule):

| Package | Version | Workspace |
|---|---|---|
| @paypal/paypal-js | 11.2.0 (28 Sep 2026) | `apps/storefront` dependencies |
| tsx | 4.23.15 (already pinned) | `apps/storefront` dependencies, for the seed script |

New workspace links, already installed:

- `@countersign/rail-paypal` depends on `@countersign/mandate`.
- `@countersign/carrier-mock` depends on `@countersign/db` and `@countersign/mandate`.
- `@countersign/storefront` depends on `@countersign/rail-paypal`, `@countersign/carrier-mock`, `@countersign/db` and `@countersign/mandate`.

zod 4.6.7 comes from the root. The storefront's `transpilePackages` must list every workspace package its pages import.

## Notes for the loop

- The loop can't reach PayPal or read `.env.*`. Every test uses recorded fixtures and an injected `fetch`, and passes env explicitly (phase 4 gotcha: a cloud session may have real variables set).
- Fixtures are written from PayPal's documented response shapes and the values in `docs/spikes.md` S1 and S2, with emails replaced by `@example.com` addresses. T-010's live test checks that real responses parse with the same schemas.
- The loop may run `npm run db:generate` for the second migration. It can't run `npm run seed` or `npm run dev`. Tests call the seed CLI's exported run function, and run one child process with `node --import tsx`, as phase 4's CLI tests do.
- Next route handlers stay thin. The checkout logic lives in plain functions with the PayPal client injected, so Vitest tests it without Next.
- Read `Graphite Design/DESIGN.md` and the Button, Card, Badge and Spinner specs before T-009.

## Risks

- **Fixtures that drift from live responses.** The schemas only require the fields we use, and T-010 parses live sandbox responses with them under `LIVE=1`. The validator can run the client-credentials part now; the vault part waits for the vault tokens (`.ralph/human.md`).
- **The second seed buyer doesn't exist yet.** The seed refuses to start without both vault tokens, so it can't quietly seed beat 3 with one payer and break `TICKET_NOT_FROM_PAYER`. Until the owner vaults a second buyer, seeding is proven against fixtures only.
- **Sandbox rate limits.** The seed keeps at most 3 orders in flight and the client retries 429s with backoff, so a 30-order run should take well under a minute. Phase 13's reset budget (≤ 60 s) depends on it; the live run records the time.
- **The browser checkout can't be tested in the loop.** It needs a sandbox buyer login. The routes are unit-tested, and the click-through is a manual check in `validation.md`.
