# Hosting Countersign on Render

These are the owner's steps for deploying the hosted demo. Everything runs against the PayPal sandbox. The design is in [ADR 0041](adr/0041-render-blueprint-four-services-a-private-resolve-internal-addresses-and-generated-keys.md) and [ADR 0044](adr/0044-round-a-reset-order-and-guarantees-gate-minted-baseline-tokens-phone-pairing-and-session-limits.md). The file Render reads is `render.yaml` at the repo root. It holds no secret.

## What the blueprint creates

| Name | Type | Reachable from | Purpose |
|---|---|---|---|
| `countersign-gate` | web | the internet | `/mcp`, the approval, audit and demo reset APIs, `/webhooks/paypal` |
| `countersign-resolve-agent` | private service | the other services only | the support agent. It holds no PayPal credential |
| `countersign-console` | web | the internet | the start page, inbox, approvals and audit console |
| `countersign-storefront` | web | the internet | the Kikapu shop |
| `countersign-reconcile` | cron, every 10 minutes | none | `npm run reconcile`, then `npm run disputes -- sync`. It fails if either fails |
| `countersign-db` | Postgres 18 | Render's private network | no outside access |

Every service is on a paid plan and set to one instance. Keep it at one instance: the reset's single-flight flag, the pairing codes and the session limits live in memory.

## Create the blueprint

1. In the Render dashboard, choose New, then Blueprint, and pick this repo and the branch to deploy.
2. Render reads `render.yaml` and asks for each value marked `sync: false`. Type them in now. Nothing else needs typing.

| Service | Values to type in |
|---|---|
| `countersign-gate` | `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, `PAYPAL_WEBHOOK_ID`, `PAYPAL_SEED_VAULT_TOKEN`, `PAYPAL_SEED_VAULT_TOKEN_B` |
| `countersign-resolve-agent` | `GEMINI_API_KEY` |
| `countersign-console` | `STOREFRONT_URL`, `CONSOLE_PUBLIC_URL` |
| `countersign-storefront` | `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET` |
| `countersign-reconcile` | `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET` |

- Use sandbox credentials for every PayPal value. The rail client refuses any other base URL.
- The two vault tokens are the seed buyers' tokens from `npm run seed`. They let the reset create replacement orders.
- `PAYPAL_WEBHOOK_ID` doesn't exist yet. Type a placeholder, then set the real one in the next section.
- `STOREFRONT_URL` and `CONSOLE_PUBLIC_URL` aren't known until the services exist. Leave them blank for now and set them after the first deploy.
- Resolve has no PayPal variables on purpose. A baseline run's token comes from the gate.

Render generates the three Countersign keys on the gate: `COUNTERSIGN_SUPPORT_AGENT_KEY`, `COUNTERSIGN_OPS_AGENT_KEY` and `COUNTERSIGN_APPROVER_KEY`. Resolve reads the support key from the gate, so the two always match.

## After the first deploy

1. **Copy the approver key.** Open the gate's environment page and copy `COUNTERSIGN_APPROVER_KEY` into the Devpost testing instructions. Never put it in the repo.
2. **Copy the ops key.** Copy `COUNTERSIGN_OPS_AGENT_KEY` into your `.env.local` for `npm run agent`.
3. **Register the webhook.** In the PayPal sandbox developer dashboard, add a webhook at `<gate URL>/webhooks/paypal` for three event groups: refunds (`PAYMENT.CAPTURE.REFUNDED`), disputes (`CUSTOMER.DISPUTE.CREATED`) and payouts (`PAYMENT.PAYOUTS-ITEM.*`). Copy its ID into the gate's `PAYPAL_WEBHOOK_ID` and save.
4. **Set the public addresses.** Set `STOREFRONT_URL` to the storefront's `https://…onrender.com` URL, and `CONSOLE_PUBLIC_URL` to the console's own `https://…onrender.com` URL. The phone code points at `CONSOLE_PUBLIC_URL`, so it never depends on proxy headers.
5. **Redeploy** the gate and the console so they read the new values.
6. **Press Reset once.** Open the console's start page, sign in with the approver key and press Reset demo. The first reset creates the 30 seed orders (`KIK-1013` to `KIK-1042`), so it can take up to a minute. Wait for the line that says the reset is complete.
7. **Verify the log.** Open the gate's Shell in the dashboard and run:

   ```text
   npm run ledger -- verify
   ```

   It should report the chain intact. Entry 1 is the `demo.reset` entry.

## Deploying by hand

Every service has `autoDeployTrigger: off`, so merged work reaches Render only when you deploy it.

1. Open the console's inbox and the start page and check that no run is working. A deploy restarts the services, and a restart marks interrupted runs failed.
2. Deploy the gate, then Resolve, then the console and the storefront, from each service's Manual Deploy menu.
3. Sign in on the start page and press Reset demo, so the next judge starts fresh.

If a reset answers that Resolve or Countersign is busy, wait a minute and try again.

## One dispute per judge

Judges can't open a dispute themselves. Open one on `KIK-1032` for each judge you expect, because each dispute serves one judge. No scenario touches `KIK-1032`, so a reset doesn't replace the order and its dispute stays valid. A dispute on an order a scenario refunded is left behind on the replaced order, so don't use those. Open more before sharing the demo with more people.

## Rotating the approver key

Rotate the key if it leaks or the judging window ends.

1. On the gate, change `COUNTERSIGN_APPROVER_KEY` to a new value. Use a random value of at least 32 characters that differs from both principal keys. Under 32 characters, or equal to a principal key, the gate counts the approver key as unset.
2. Redeploy the gate.
3. Update the key in the Devpost testing instructions.

Browsers that were signed in must sign in again. The old key stops working as soon as the gate restarts.

## Keeping it up

The hosted demo stays up until 22 December. Check for Next.js security releases weekly until then (ADR 0010).
