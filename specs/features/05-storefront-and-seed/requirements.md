# Phase 5 requirements: Kikapu storefront and seed

Brief §5 item 7, §6 (beats 3 to 5 need these orders), §8 (sandbox only, no secrets, Graphite, illustrative labels), §11 (rail clients have fixture-based contract tests). Design baseline: original brief §11 (storefront and seed), §12 (token refresh, idempotency), §14 (checkout and tracking rows of the integration map). Decisions: ADR 0023 (seed state, carrier status, seed runs, two buyers) and ADR 0024 (the rail client, v6 checkout). Where this file and the brief disagree, the brief wins.

## Behaviour

### The PayPal rail client

- `@countersign/rail-paypal` is the only code that calls PayPal's REST API or knows its JSON shapes. It's configured from `PAYPAL_BASE_URL`, `PAYPAL_CLIENT_ID` and `PAYPAL_CLIENT_SECRET`, validated with zod. Missing variables are reported by name, never by value.
- **Sandbox only.** It refuses to be created unless `PAYPAL_BASE_URL` is exactly `https://api-m.sandbox.paypal.com` (a trailing slash is allowed). The refusal names the expected URL.
- **OAuth.** `POST /v1/oauth2/token` with client credentials. One token per client, reused until less than five minutes of its `expires_in` remain, then replaced. Calls made while a token is being fetched wait for that one request. A 401 on any call gets one new token and one retry of that call; a second 401 is an error.
- **Calls in this phase:**

| Call | Endpoint | Notes |
|---|---|---|
| Create order | `POST /v2/checkout/orders` | `intent: CAPTURE`, one purchase unit with reference ID, custom ID, invoice ID, items and an amount whose breakdown matches the items. Paid either by a vault token (`payment_source.paypal.vault_id`, captured in the same call) or left for buyer approval |
| Capture order | `POST /v2/checkout/orders/{id}/capture` | |
| Get order | `GET /v2/checkout/orders/{id}` | |
| Add tracker | `POST /v2/checkout/orders/{id}/track` | Capture ID, tracking number, `carrier: OTHER` with a carrier name, `notify_payer: false` |
| Get capture | `GET /v2/payments/captures/{id}` | Includes the capture's order ID from `supplementary_data.related_ids` |

- Every POST takes a caller-supplied `PayPal-Request-Id` and sends `Prefer: return=representation`.
- **Retries.** A GET, or a POST with a request ID, is retried on 429 and 5xx up to twice, waiting for `Retry-After` when given (capped at 10 s) and a short backoff otherwise. Nothing else is retried.
- **Records.** Every response is parsed with zod into the client's own shapes:
  - an order: ID, status, payer email and payer ID (each null when absent), and its purchase units, each with reference ID, custom ID, invoice ID, amount, captures and trackers;
  - a capture: ID, status, amount, and its order ID (null when absent);
  - a tracker: ID, tracking number and PayPal status.

  Money is integer minor units plus a currency, through `parseMoney` and `formatMoney` from `@countersign/mandate`. A request in a currency other than USD is refused before any call. A response that doesn't parse is an error naming the call and the field, never a partial record.
- **Errors** say which call failed and carry the HTTP status, PayPal's `name`, `message`, `debug_id` and the `issue` codes from `details`. No error, return value or log line ever holds the access token, the client secret, a vault token or an `Authorization` header.

### The two tables

- `carrier_shipments`, one row per tracking number (primary key): status (CHECK: `lost`, `stalled_10d`, `in_transit`, `delivered`), carrier name, scan events (each with a time, a description and a place, in time order), and the time the row was written. Times are ISO 8601 strings that pass the shared timestamp rule.
- `seed_orders`, one row per demo order number (primary key, `KIK-` and four digits): run ID; PayPal order ID and capture ID (each UNIQUE); amount in minor units and currency; payer email as PayPal returned it; buyer (`A` or `B`); tracking number; role; and when it was seeded.
- Both come from one new migration made with `npm run db:generate`. Neither has a trigger. `audit_log` and its trigger are unchanged.

### The carrier mock

- `@countersign/carrier-mock` exports the carrier adapter interface, documented in its doc comments so a real tracking API can implement it: given a tracking number, a lookup returns one of
  - found: the shipment's tracking number, carrier name, status, scan events and when it was last updated;
  - not found;
  - unreadable: a stored record that fails validation, with a one-line detail. It never yields a status.
- A tracking number that isn't 1 to 64 letters, digits or hyphens is not found, without reading the store.
- The mock reads shipments from a store. Two stores exist: one over `carrier_shipments`, and an in-memory one for tests. Writing a shipment validates it with zod and replaces any earlier record for that tracking number.
- The status is whatever is stored. The mock never works it out from the clock (ADR 0023).

### The catalogs

- **Products,** shared by the storefront and the seed, priced in USD:

| Product | Price |
|---|---|
| Market basket | $48.00 |
| Woven tote | $36.00 |
| Coaster set | $18.00 |
| Floor basket | $240.00 |
| Laundry hamper | $120.00 |
| Bread basket | $24.00 |
| Clutch bag | $56.00 |
| Wall plate | $64.00 |

  Each has a stable ID, a name, a one-line description and its price. Copy follows `Graphite Design/brand-book.md`.
- **Demo orders:** exactly 30, `KIK-1013` to `KIK-1042`, each one product, quantity 1. Each names its product, its buyer (A or B), its shipment status, its scan events as day offsets before seeding, and a role. These are fixed:

| Order | Product | Buyer | Status | Role |
|---|---|---|---|---|
| KIK-1032 | Laundry hamper | A | delivered | dispute (phase 11) |
| KIK-1033 | Clutch bag | A | delivered | wrong item |
| KIK-1034 | Wall plate | A | lost | lost, under the $80 cap |
| KIK-1035 | Coaster set | A | stalled_10d, last scan 14 days before seeding | beat 4 |
| KIK-1036 | Laundry hamper | A | lost | lost, over the cap |
| KIK-1037 | Floor basket | A | delivered | beat 5, damaged |
| KIK-1038 to KIK-1041 | any | B | delivered, delivered, in_transit, delivered | beat 3, named in the injected text |
| KIK-1042 | Market basket | A | delivered, 5 days before seeding | beat 3, the held order |

  The other 19 are role `filler`, chosen so the whole set is 16 delivered, 6 in transit, 4 stalled and 4 lost. At least 3 filler orders are buyer B.
- **Scan events agree with the status.** A delivered shipment's last event is its delivery. A lost one's last event reports it lost. A stalled one's last scan is at least 10 days before seeding, and an in-transit one's is less than 10. Events are in time order, and the first is a pickup. The carrier name is "Kisumu Couriers (simulated)".
- The carrier's dates are worked out back from the time of seeding, so they can fall before PayPal's capture time, which can't be backdated. The carrier is simulated, and the storefront and README say so (brief §15's real vs simulated table).

### Seeding

- `npm run seed` runs a seed run: for every demo order, in order number order, with at most 3 orders in flight:
  1. Skip it if `seed_orders` already has it for this run.
  2. Create the order, paid by buyer A's or B's vault token. Reference ID is the order number, custom ID the run ID, invoice ID the order number plus the run ID. The response must show status `COMPLETED`, one capture `COMPLETED` for the product's price, and a payer email. Otherwise the order fails, and nothing more is done for it.
  3. Add the tracker, unless the order already has a `SHIPPED` tracker for this capture and tracking number.
  4. Read the order back. It must show the capture `COMPLETED` and a `SHIPPED` tracker whose ID is the capture ID, a hyphen and the tracking number (spike S2).
  5. Write the shipment and the `seed_orders` row in one transaction.
- **Request IDs** are `countersign-seed-<run>-<order>-<step>`, so running the same run again replays PayPal's earlier answers instead of creating new orders. PayPal keeps Orders request IDs for about 6 hours, so a resume should follow promptly. A later resume creates fresh orders, and the replaced ones are simply unused.
- **Run IDs** are 4 to 24 lowercase letters and digits. Without `--run`, one is made from the date and a random suffix. Tracking numbers are `KC-<run>-<order digits>`.
- **Both buyers are required.** Without `PAYPAL_SEED_VAULT_TOKEN` (buyer A) and `PAYPAL_SEED_VAULT_TOKEN_B` (buyer B) the seed doesn't start. If any of A's orders and any of B's come back with the same payer email, the run reports "Buyers A and B are the same PayPal account" and exits 1, since beat 3's `TICKET_NOT_FROM_PAYER` would then be impossible.
- One order failing doesn't stop the others. Failed orders are listed at the end.
- **Output.** A complete run ends with "Seeded 30 of 30 orders in run <run>: 16 delivered, 6 in transit, 4 stalled, 4 lost." and exits 0. Otherwise it prints "Seeded N of 30 orders in run <run>. K failed:", one line per failure (`KIK-10NN <call> <reason>`, with PayPal's debug ID when there is one), then "Run npm run seed -- --run <run> to retry them.", and exits 1.
- `npm run seed -- --dry-run` prints the plan, one line per order (order, product, price, buyer, status, role), then the status totals. It makes no PayPal call, opens no database and needs no variables.
- `npm run seed -- list` prints the seeded orders: order number, PayPal order ID, capture ID, amount, payer email, tracking number and the carrier's status. An empty table prints "No seeded orders yet."
- **Which database:** the same rule as phase 4's CLIs: `DATABASE_URL` when set, otherwise `--pglite <dir>` or `.countersign/pglite`, reusing `@countersign/db`'s target helpers. Exit 2 when it can't be opened, with the URL scrubbed. Exit 2, naming the missing variables, when PayPal or vault variables are missing.
- The root `seed` script loads env with `--env-file-if-exists=.env.local`.

### The storefront

- **Pages:**
  - the shop: every product with its name, description and price, each linking to its page;
  - a product page: the product, its price, and the PayPal button;
  - after payment, on the same page: "Paid" with the PayPal order ID, the capture ID and the amount, all from the capture response. Anything short of a completed capture shows "Payment not completed" with PayPal's status.
- Every page says, in secondary text: "Kikapu Studio is an illustrative demo shop. Payments use the PayPal sandbox, so no real money moves."
- **Checkout** uses JS SDK v6 through `loadCoreSdkScript` from `@paypal/paypal-js/sdk-v6` (`environment: "sandbox"`) and `createInstance({ clientId, components: ["paypal-payments"], pageType: "checkout" })`. The button shows only when `findEligibleMethods` says PayPal is eligible. The page gets the public client ID from the server; nothing else from the environment reaches the browser.
- **Server routes:**
  - Create order: takes a product ID (zod) and creates the order for that product's catalog price. Custom ID `storefront:<product ID>`, reference ID `SHOP-` plus a random suffix, a new request ID per call. Returns the order ID. An unknown product is a 400.
  - Capture: takes an order ID (zod: 10 to 32 uppercase letters and digits). It reads the order first, and refuses with a 400, capturing nothing, unless its custom ID names a catalog product and its amount is that product's price. Then it captures with request ID `countersign-storefront-capture-<order ID>`, so a double click can't capture twice, and returns paid or not paid as above.
  - PayPal failures return 502 with a plain message and PayPal's debug ID. When the PayPal variables are missing, both routes return 503, and the product page shows "Checkout isn't set up here. Add the PayPal sandbox variables to take payments." in place of the button.
- Storefront orders get no tracker and no row in either table (ADR 0023).
- **Graphite.** Semantic tokens only, Lucide icons only, no emojis, light by default and correct in dark. Product cards follow the Card spec, the price and IDs use the mono font, and buttons follow the Button spec. The PayPal button is PayPal's own component, the one exception to Graphite styling (brief §15).

## Constraints

- Sandbox only, everywhere: the rail client's guard, `environment: "sandbox"` in the browser.
- No secret in the repo, in output, in errors, in fixtures, or in the browser bundle. The browser sees only the client ID. Fixtures use `@example.com` emails and no real tokens.
- Validate every external input with zod 4: env, CLI arguments, route bodies and params, PayPal responses, rows read back from the tables.
- Money is integer minor units everywhere except the PayPal wire format, which only the rail client writes and reads.
- `@countersign/rail-paypal` and `@countersign/carrier-mock` import no AI SDK. The repo's no-AI test covers them.
- `npm run build` passes with no PayPal variables set, and the build output holds no variable's value. Pages read the environment at request time.
- Tests need no network, secret or `.env.local`. They inject `fetch` and pass env explicitly. Tests that call the real sandbox run only under `LIVE=1`.
- Words in CLI output and on pages follow the brand book: plain, short, no exclamation marks.

## Technical needs

- JS SDK v6's types come from `@paypal/paypal-js/sdk-v6` (11.2.0). Load the script in a client component only.
- The storefront's `next.config.ts` loads the repo-root `.env.local` the way the console's does, and lists every workspace package its pages import in `transpilePackages`.
- The seed CLI follows phase 4's pattern: an exported run function `(args, env)` returning exit code, stdout and stderr, and a thin entry point.
- `CONTEXT.md` gains Tracker, Seed run and Seed catalog. `tech-stack.md` already lists `@paypal/paypal-js`.
