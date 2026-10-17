# For the owner

The autopilot builds everything it can and lists here what only you can do, or what it decided on your behalf. Nothing here blocks the build unless it says so. Tick or delete lines as you deal with them.

## Open

- **Render (phase 13 onward):** paid plans for the four web services and Postgres, then a `RENDER_API_KEY` in the Dev cloud environment, so the autopilot can deploy through Render's API. Until then, deployment is built and tested as config only.
- **AG Studio licence (phase 16):** request the trial key, ask the AG Grid team on the PayPal Discord for cover to 22 Dec, then add `AG_STUDIO_LICENSE_KEY` to the Dev environment.
- **Gemini tier (phase 14):** decide free or paid for the bench and the hosted demo (brief §15). The free tier can't carry a bench run.
- **Interviews (G7):** 5 merchants and 2 developers, logged in `docs/validation.md` with consent.
- **Sandbox disputes (phase 11):** open them as the sandbox buyer before recording and judging, if the autopilot's Playwright flow can't.
- **LICENSE:** confirm Apache-2.0, and make the repo public with the licence in the About sidebar.
- **Video, comprehension check, README cold read and the Devpost submission (phase 20).**
- **Phase 4, `.env.example`:** add a `DATABASE_URL=` line (Render Postgres connection string). A deny rule stops agents reading `.env.*`, so they can't edit it.
- **Phase 5, two seed buyers:** vault two different sandbox personal accounts the way spike S1 did (`spikes/paypal/s1.ts vault-setup`, approve as the buyer, then `vault-token`), and add `PAYPAL_SEED_VAULT_TOKEN` (buyer A, who sends beat 3's email) and `PAYPAL_SEED_VAULT_TOKEN_B` (buyer B, who pays KIK-1038 to KIK-1041) to the Dev environment and `.env.example`. Until then the seed is proven against fixtures only, and phase 6's live demo has no seeded orders. Then run `npm run seed` and the vault case of `LIVE=1 npm test -- packages/rail-paypal`. Check it ends "Seeded 30 of 30 orders" and note how long it took (phase 13's reset budget is 60 s). In the sandbox merchant dashboard, check that one order shows a capture and a "Kisumu Couriers (simulated)" tracker, and that KIK-1038 and KIK-1042 have different payers. Rerun with the printed `--run` and check that nothing new is seeded and there are no duplicate orders.
- **Phase 5, storefront checkout:** buy one product on the storefront as a sandbox buyer (`npm run dev --workspace @countersign/storefront`, or the hosted URL from phase 13) and check the order and capture IDs against the sandbox dashboard, in light and dark and at phone width. The validator couldn't load the pages in a browser (HTTP requests to the local server were denied), so this is also the first check that the storefront renders.
- **Phase 4, live Postgres check:** once the Render Postgres 18 database exists (phase 13), set `DATABASE_URL` in the Dev environment and run `LIVE=1 npm test -- packages/ledger` (20 concurrent appends in a throwaway schema), then `npm run db:migrate` and `npm run ledger -- verify` on the hosted database (brief §12).

## Decided for you

- **Phase 4, audit-log format (ADR 0022):** one `audit_log` table, payloads stored as their hashed canonical text, an envelope hash, an append-only trigger (TRUNCATE allowed for the demo reset), raw proposals kept as JSON text, and `mandate.version` entries written once per version. A hash chain can't detect a cut-off tail, so `ledger verify` prints the head.
- **Phase 4, chain link rule:** a row's `prev_hash` passes if it matches the previous row's stored hash or, when that stored hash was edited, the hash recomputed from the previous row, so an edited row is reported once at its own `seq`. Overturn to link to the stored hash only.
- **Phase 4, append rejections:** besides the spec's codes, appends reject `BAD_REF` (a ref with a lone surrogate, a fail-closed backstop since IDs can't hold one) and `BAD_INPUT` (an entry of the wrong shape).
- **Phase 4, proposal text fallback:** a proposal `JSON.stringify` can't serialize is recorded as `String(proposal)`, or `""` if that throws too, so recording never fails on content; `recordDecision` throws on a mandate that differs from the decided one.
- **Phase 4, CLI wording:** counts are pluralised ("1 entry", "1 problem", "Applied 1 migration."), and `tail` prints "Last N entries of M." or "The audit log has no entries.".
- **Phase 4, database precedence:** `DATABASE_URL` wins over `--pglite <dir>` when both are given, and `--pglite` is then ignored silently. Overturn to refuse both together.
- **Phase 4, decide env loading:** `decide-main.ts` loads `.env.local` itself (only with `--record`, never overriding set variables), because a phase 3 test pins the `decide` script without `--env-file-if-exists`. Change the test and script together to match the other scripts.
- **Phase 5, seed state and carrier data (ADR 0023):** seeded orders and carrier shipments live in two Postgres tables (`seed_orders`, `carrier_shipments`); the shipment status is stored, never worked out from the clock; each seed run has a resumable run ID; and two seed buyers are required, so beat 3's `TICKET_NOT_FROM_PAYER` can fire. The carrier's scan dates are backdated from seeding and can precede PayPal's capture time; the carrier is labeled simulated.
- **Phase 5, storefront scope:** storefront sales are real and captured but get no tracker or carrier record, and the shop sells one product per order. The planner couldn't reach the answerer agent from its session, so it applied the answerer's rules itself; ADR 0024 (rail client, v6 checkout with the client ID) is marked researched.

## Done
