# Phase 5 validation: Kikapu storefront and seed

## Automated checks

All run from the repo root and are part of the Feedback commands, except checks 11 and 12, which are live.

1. `npm run typecheck`, `npm run lint`, `npm test` and `npm run build` pass. `npm run build` passes with no PayPal variables set.
2. **Sandbox guard:** the rail client refuses a production base URL, any other URL, and missing variables, naming what's wrong and never a value.
3. **Token cache:** against a fake `fetch`, many calls share one token request. A token with less than five minutes left is replaced before the next call. A 401 gets one new token and one retry, and a second 401 is an error. This is the "expired PayPal token" test brief §12 asks for, at the client level.
4. **Contract tests:** recorded fixtures for OAuth, a vault order (`COMPLETED`, with payer and capture), an order awaiting approval, a capture, an order with a tracker, an add-tracker response, a capture read, and 401, 404, 422 and 429 errors all parse into the client's records or errors. Money comes back in minor units. A response missing a field we use is an error, not a partial record.
5. **Retries:** a GET and a POST with a request ID are retried on 429 (honouring `Retry-After`) and 5xx, at most twice. Nothing else is retried.
6. **No secrets:** after the token, retry and error tests, no captured output, error message or thrown value contains the fake client secret, access token or vault token.
7. **Tables:** the migrations apply to a fresh in-memory PGlite. `carrier_shipments` rejects a status outside the four. `seed_orders` rejects a repeated PayPal order ID or capture ID. A second `npm run db:generate` reports no changes, and `audit_log`'s trigger still rejects UPDATE.
8. **Carrier mock:** each of the four statuses round-trips through both stores. An unknown tracking number is not found. A malformed tracking number is not found without a store read. A row that fails validation is unreadable and yields no status.
9. **Catalogs:** 8 products at the listed prices. 30 demo orders, `KIK-1013` to `KIK-1042`, with the fixed rows in requirements.md, 16 delivered, 6 in transit, 4 stalled and 4 lost, at least 3 filler orders for buyer B, and scan events that agree with each status.
10. **Seed run, against a fake PayPal and PGlite:**
    - a full run writes 30 `seed_orders` rows and 30 shipments, and each fake order has one tracker whose ID is the capture ID and tracking number;
    - request IDs follow `countersign-seed-<run>-<order>-<step>`;
    - running the same run again makes no new orders, trackers or rows;
    - a run where 2 orders fail seeds the other 28, lists the 2, exits 1, and a rerun completes them;
    - an order with no payer email, or a capture that isn't `COMPLETED`, fails and gets no tracker;
    - buyers A and B with the same payer email make the run exit 1 with "Buyers A and B are the same PayPal account";
    - `--dry-run` needs no variables and calls nothing; `list` prints the rows; missing variables exit 2 naming them; an unreachable `DATABASE_URL` exits 2 with the URL scrubbed.
11. **Live, client credentials only (`LIVE=1`, needs `PAYPAL_*`):** OAuth works, an order awaiting approval is created and read back, and both responses parse with the client's schemas. Run with `LIVE=1 npm test -- packages/rail-paypal`. The validator can run this now.
12. **Live, vault (`LIVE=1`, also needs `PAYPAL_SEED_VAULT_TOKEN`):** one vault order is created, captured, tracked and read back, and parses. Skipped with a message naming the variable when it isn't set.
13. **Storefront routes:** with an injected fake client, create order prices from the catalog and ignores any amount in the body; an unknown product is a 400; capture refuses an order that isn't a storefront order or whose amount differs from the catalog, without capturing; a paid capture returns the order ID, capture ID and amount; a double capture uses the same request ID; missing variables give 503 on both routes.
14. **Design check:** the Graphite design check passes on the storefront's files (no raw hex, no emojis, no palette classes).
15. The no-AI test covers `@countersign/rail-paypal` and `@countersign/carrier-mock` and passes.

## Manual checks for the human

1. **Vault two sandbox buyers** (spike S1's route) and set `PAYPAL_SEED_VAULT_TOKEN` and `PAYPAL_SEED_VAULT_TOKEN_B` in the Dev environment. Then run `npx tsx --env-file-if-exists=.env.local apps/storefront/seed/seed-main.ts` (or `npm run seed`), and check it ends with "Seeded 30 of 30 orders", and note how long it took (phase 13's reset budget is 60 s).
2. Run `npm run seed -- list`. Open two of the orders in the sandbox merchant dashboard: one shows a capture and a tracker from "Kisumu Couriers (simulated)", and `KIK-1038`'s payer differs from `KIK-1042`'s.
3. Run `npm run seed` again with the run ID it printed. Check that it seeds nothing new and the sandbox dashboard shows no duplicate orders.
4. Run the storefront (`npm run dev --workspace @countersign/storefront`), buy the Coaster set as a sandbox buyer, and check that the confirmation's order and capture IDs match the sandbox dashboard. Repeat in dark mode and on a phone-width window.
5. Read the storefront and the seed output as a stranger: is it clear the shop is illustrative and the carrier is simulated?
6. Gate G1 needs phase 6 as well. This phase covers the seed data its decisions will read.
