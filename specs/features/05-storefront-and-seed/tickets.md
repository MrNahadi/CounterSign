# Phase 5 tickets: Kikapu storefront and seed

## T-001: The PayPal client starts on sandbox only, caches its token, and reads one order

Status: done
Tier: standard
Blocked by:
Slice: Given the three PayPal variables and an injected `fetch`, `@countersign/rail-paypal` makes a sandbox-only client that fetches and caches an OAuth token and reads an order into a typed record, or a typed error that holds no secret.
Test seam: the client factory and its get-order call, exported from `@countersign/rail-paypal`, with a fake `fetch` serving recorded fixtures
Acceptance:
- [x] Env is validated with zod. A base URL other than `https://api-m.sandbox.paypal.com` (trailing slash allowed), or a missing variable, is refused with a message naming the problem and never a value
- [x] Many concurrent calls share one token request. A token with less than five minutes of `expires_in` left is replaced first. A 401 gets one new token and one retry; a second 401 is an error
- [x] Get order parses a recorded order (fixture in `packages/rail-paypal/test/fixtures/`, emails at `@example.com`) into ID, status, payer email and ID, and purchase units with reference ID, custom ID, invoice ID, amount in minor units, captures and trackers
- [x] A 404 and a 422 become errors carrying the call, HTTP status, PayPal `name`, `message`, `debug_id` and issue codes. A response missing a field we use is an error naming the field
- [x] GETs are retried on 429 and 5xx at most twice, honouring `Retry-After` (capped at 10 s; tests inject the clock or the wait)
- [x] No error, thrown value or return value in these tests contains the fake secret or token. `tests/no-ai-in-decision-path.test.ts` also covers `rail-paypal`
Notes:

## T-002: Create, capture, track and read captures through the client

Status: open
Tier: standard
Blocked by: T-001
Slice: The client can create an order (paid by a vault token, or for buyer approval), capture it, add a tracker and read a capture, each against recorded fixtures, with money in minor units both ways.
Test seam: the client's create-order, capture-order, add-tracker and get-capture calls
Acceptance:
- [ ] Create order sends `intent: CAPTURE`, one purchase unit with reference ID, custom ID, invoice ID, items and a matching amount breakdown, and either `payment_source.paypal.vault_id` or nothing for buyer approval. A non-USD amount is refused before any call
- [ ] Every POST sends the caller's `PayPal-Request-Id` and `Prefer: return=representation`, and is retried on 429 and 5xx at most twice. A POST without a request ID is a type error
- [ ] A vault order fixture (`COMPLETED`) parses with its capture and payer. An approval-pending fixture parses with its status. A capture fixture parses with its order ID from `supplementary_data.related_ids`
- [ ] Add tracker sends the capture ID, tracking number, `carrier: OTHER`, the carrier name and `notify_payer: false`, and accepts PayPal's response
- [ ] Amounts convert through `parseMoney` and `formatMoney` from `@countersign/mandate`: 4800 minor units is `"48.00"`, and `"240.00"` is 24000
Notes:

## T-003: The carrier_shipments and seed_orders tables

Status: open
Tier: simple
Blocked by:
Slice: A fresh PGlite gets both tables from a new committed migration, and they reject bad statuses and duplicate PayPal IDs.
Test seam: the schema exports of `@countersign/db` and its migrated test-database factory
Acceptance:
- [ ] `carrier_shipments` and `seed_orders` have the columns, keys, UNIQUE constraints and the status CHECK in requirements.md. The migration was made with `npm run db:generate`, and a second run reports no changes
- [ ] Tests on a fresh PGlite show a status outside the four fails, a repeated PayPal order ID or capture ID fails, and `audit_log` still rejects UPDATE
- [ ] Phase 4's db and ledger tests pass unchanged
Notes:

## T-004: The carrier mock reports lost, stalled, in transit and delivered

Status: open
Tier: standard
Blocked by: T-003
Slice: A shipment written to the carrier mock's store comes back from a lookup by tracking number with its status and scan events; unknown and malformed records never yield a status.
Test seam: the adapter interface, the mock carrier, and its in-memory and database stores, exported from `@countersign/carrier-mock`
Acceptance:
- [ ] The adapter interface is documented in doc comments for a real tracking API: a lookup returns found (tracking number, carrier name, status, events, last updated), not found, or unreadable with a detail
- [ ] Each of the four statuses round-trips through both stores. Writing a shipment validates it with zod and replaces an earlier one with the same tracking number
- [ ] An unknown tracking number is not found. One that isn't 1 to 64 letters, digits or hyphens is not found without reading the store. A stored row that fails validation is unreadable
- [ ] `tests/no-ai-in-decision-path.test.ts` also covers `carrier-mock`
Notes:

## T-005: The product catalog and the 30 demo orders

Status: open
Tier: simple
Blocked by:
Slice: The storefront's product catalog and the seed catalog exist as data, with the fixed demo orders and status mix from requirements.md, and each order's carrier shipment can be built for a given seeding time.
Test seam: the catalog exports in `apps/storefront/`, and the function that builds a demo order's shipment from a seeding time and run ID
Acceptance:
- [ ] 8 products with stable IDs, names, one-line descriptions and the listed USD prices in minor units
- [ ] 30 orders, `KIK-1013` to `KIK-1042`, each one product, with the fixed rows in requirements.md, 16 delivered, 6 in transit, 4 stalled and 4 lost, and at least 3 filler orders for buyer B
- [ ] A built shipment's tracking number is `KC-<run>-<order digits>`, its carrier is "Kisumu Couriers (simulated)", and its events are in time order, start with a pickup, and agree with the status (delivered ends in a delivery, lost in a loss report, stalled's last scan at least 10 days before seeding, in transit's less than 10). KIK-1035's last scan is 14 days before seeding and KIK-1042's delivery 5 days before
Notes:

## T-006: A seed run creates, tracks, checks and records every demo order

Status: open
Tier: standard
Blocked by: T-002, T-004, T-005
Slice: Against a fake PayPal and a PGlite database, one seed run creates all 30 orders with the right buyer, adds each tracker, reads each order back, and records the shipments and seed rows; a rerun of the same run changes nothing.
Test seam: the seed run function in `apps/storefront/`, given a PayPal client over a fake `fetch`, a database, the catalog, a run ID, the two vault tokens and a clock
Acceptance:
- [ ] A full run writes 30 `seed_orders` rows and 30 shipments, and each fake order has one `SHIPPED` tracker whose ID is the capture ID and tracking number. The report counts 16 delivered, 6 in transit, 4 stalled, 4 lost
- [ ] Request IDs are `countersign-seed-<run>-<order>-<step>`. Reference, custom and invoice IDs are as in requirements.md. At most 3 orders are in flight at once
- [ ] Running the same run again creates no order, tracker or row. A run where 2 orders fail seeds the other 28 and reports the 2 with their call, reason and debug ID; rerunning completes them
- [ ] An order that comes back without a payer email, or with a capture that isn't `COMPLETED` for the price, fails and gets no tracker. Shipment and seed row are written in one transaction after the read-back
- [ ] Buyers A and B coming back with the same payer email fail the run with "Buyers A and B are the same PayPal account"
Notes:

## T-007: npm run seed, with --dry-run, --run and list, and the README

Status: open
Tier: standard
Blocked by: T-006
Slice: `npm run seed` seeds the database the other CLIs use and prints the summary; `--dry-run` shows the plan with nothing set; `list` shows what's seeded; the README says how to seed and what's simulated.
Test seam: the seed CLI's exported run function `(args, env)`, plus one child-process run of the entry point with `node --import tsx`
Acceptance:
- [ ] A complete run prints "Seeded 30 of 30 orders in run <run>: 16 delivered, 6 in transit, 4 stalled, 4 lost." and exits 0. A partial one prints the failures and "Run npm run seed -- --run <run> to retry them.", and exits 1
- [ ] `--dry-run` prints one line per order and the totals, needs no variables, and makes no call. `list` prints the seeded rows, or "No seeded orders yet."
- [ ] Missing PayPal or vault variables exit 2 naming them. The database is chosen by phase 4's rule with `@countersign/db`'s helpers, and an unreachable `DATABASE_URL` holding a password exits 2 with neither in the output
- [ ] `--run` accepts 4 to 24 lowercase letters and digits; without it a run ID is made from the date and a random suffix. Bad arguments are reported through zod
- [ ] A root `seed` script loads env with `--env-file-if-exists=.env.local`. The README gains a "Seed the demo" section (both buyers, resuming a run, `list`, and that the carrier is simulated) and the two vault variables in its environment table
Notes:

## T-008: The storefront's create and capture routes

Status: open
Tier: standard
Blocked by: T-002, T-005
Slice: The storefront's server creates an order priced from the catalog and captures only its own orders, returning the real order and capture IDs.
Test seam: the checkout functions in `apps/storefront/` that the route handlers call, with an injected PayPal client over a fake `fetch`
Acceptance:
- [ ] Create order takes a product ID through zod, prices it from the catalog whatever else the body holds, uses custom ID `storefront:<product ID>` and a fresh request ID, and returns the order ID. An unknown product is a 400
- [ ] Capture validates the order ID (10 to 32 uppercase letters and digits), reads the order first, and refuses with a 400, capturing nothing, unless its custom ID names a catalog product and its amount is that price
- [ ] Capture uses request ID `countersign-storefront-capture-<order ID>`, and returns paid with order ID, capture ID and amount only for a `COMPLETED` capture of the right amount; otherwise not paid with PayPal's status
- [ ] PayPal failures return 502 with a plain message and the debug ID. Missing PayPal variables return 503 from both routes
- [ ] The Next route handlers only parse the request, call these functions and shape the response
Notes:

## T-009: The shop pages and the JS SDK v6 PayPal button

Status: open
Tier: standard
Blocked by: T-008
Slice: A shopper sees the products, opens one, pays with the v6 PayPal button, and sees "Paid" with the real order and capture IDs, in Graphite, in light and dark.
Test seam: the pages under `apps/storefront/app/`, checked by `npm run build`, the design check, and a test of the server-side props that reach the client
Acceptance:
- [ ] The shop lists every product with name, description and price (mono font), each linking to its product page. Cards and buttons follow the Graphite Card and Button specs, with semantic tokens only and Lucide icons only
- [ ] The product page loads the SDK in a client component through `loadCoreSdkScript({ environment: "sandbox" })`, creates the instance with the client ID only, shows the button when PayPal is eligible, and calls the T-008 routes
- [ ] After payment it shows "Paid" with the order ID, capture ID and amount, or "Payment not completed" with PayPal's status. With the PayPal variables missing it shows the not-set-up message instead of the button
- [ ] Every page shows the illustrative-shop line. Pages read the environment at request time, `npm run build` passes with no PayPal variables, and the only value passed to the client is the client ID
- [ ] `next.config.ts` loads the repo-root `.env.local` like the console's and lists the workspace packages its pages import in `transpilePackages`
Notes: Read `Graphite Design/DESIGN.md` and the Button, Card, Badge and Spinner specs first.

## T-010: Live checks: client credentials and one vault order

Status: open
Tier: standard
Blocked by: T-002
Slice: Under `LIVE=1`, the client's schemas parse real sandbox responses: an order awaiting approval with client credentials alone, and, when a vault token is set, one vault order created, tracked and read back.
Test seam: the client's exported calls against the real sandbox, in a live test file under `packages/rail-paypal/test/`
Acceptance:
- [ ] The file is skipped unless `LIVE=1` and the three `PAYPAL_*` variables are set, so `npm test` never runs it. The skip message names only the variables
- [ ] With client credentials: OAuth works, an order awaiting approval is created and read back, and both parse
- [ ] With `PAYPAL_SEED_VAULT_TOKEN` also set: one $1.00 vault order with reference `KIK-LIVE`, a fresh run-style request ID and tracking number, is captured, tracked and read back with a `SHIPPED` tracker. Without it, that case is skipped with a message naming the variable
- [ ] Nothing printed contains a secret, token or vault token
Notes: The vault case waits for the owner's vault tokens (`.ralph/human.md`). The build is complete when the test typechecks, skips cleanly, and the client-credentials case passes for the validator.
