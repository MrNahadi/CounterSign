# 0024. The PayPal rail client is sandbox-only, caches its token, and returns zod-checked records in minor units; the storefront uses JS SDK v6 with the client ID

Status: accepted
Decided-by: autopilot planner, phase 5 feature spec, 17 Oct 2026 (researched; a technical question inside the answerer's remit. The planner session couldn't reach the answerer agent, so it followed the answerer's rules itself)
Question: Phase 5 needs PayPal calls from the seed script and the storefront: OAuth, create order, capture, add a tracker, read an order and a capture. What shape does `@countersign/rail-paypal` take, and how does the storefront start JS SDK v6 checkout?
Decision:
- **Sandbox only.** The client refuses to start unless the base URL is exactly `https://api-m.sandbox.paypal.com` (brief §8).
- **Token cache.** One OAuth client-credentials token per client, refreshed once less than five minutes of its `expires_in` remain. Concurrent calls share one token request. A 401 gets one fresh token and one retry. The token and the secret never appear in an error, a log or a return value.
- **Retries only when they're safe.** A GET, or a POST that carries a `PayPal-Request-Id`, is retried on 429 and 5xx up to twice, honouring `Retry-After`. Any other call is never retried.
- **Typed records.** Every response is parsed with zod 4 and mapped to the project's own shapes, with money as integer minor units through `parseMoney` and `formatMoney` from `@countersign/mandate`. Only USD is sent to PayPal. A response that doesn't parse is an error, never a partial record.
- **Errors** carry the HTTP status, PayPal's error `name`, its `message`, its `debug_id` and the issue codes from `details`, and nothing else.
- **Phase 5 builds:** OAuth, create order (paid by a vault token, or for buyer approval), capture order, get order, add tracker and get capture. Phase 6 adds refunds and webhook signature checks to the same client.
- **Storefront checkout** loads JS SDK v6 through `loadCoreSdkScript` from `@paypal/paypal-js/sdk-v6` (11.2.0), and calls `createInstance({ clientId, components: ["paypal-payments"], pageType: "checkout" })` with the public client ID, read on the server and passed to the page. The order is created and captured by the storefront's server routes, which price it from the catalog and never trust an amount from the browser.
Basis:
- PayPal, "Set up JavaScript SDK v6": "Authenticate the SDK, Option A: client ID (recommended)", https://developer.paypal.com/sdk/js/set-up
- `@paypal/paypal-js` README, V6 SDK support (`loadCoreSdkScript`, `createInstance({ clientId, ... })`), https://github.com/paypal/paypal-js/blob/main/packages/paypal-js/README.md, and its 11.2.0 type definitions (`CreateInstanceOptions` accepts `clientId` or `clientToken`).
- `@paypal/paypal-js` 11.2.0 was published on 28 Sep 2026, more than two weeks before planning (ADR 0021's rule).
- `docs/spikes.md` S1 and S5: replaying a request ID returns the original resource, so a retried POST with one can't act twice.
- Original brief §12 security controls ("PayPal tokens: minted from the client ID and secret and refreshed before `expires_in`"), brief §12 ("a test with an expired PayPal token passes").
Consequences:
- No browser-safe client token endpoint is needed, and nothing secret ever reaches the browser.
- The rail package is the only place that knows PayPal's JSON shapes. Phase 6 maps its records into the verifiers' snapshots.
- The PayPal button is rendered by PayPal's SDK and carries its branding, the one exception to Graphite styling already noted in brief §15.
