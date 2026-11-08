# Hosting Countersign for free

These are the owner's steps for putting the demo online. It runs on four free services:

- **Render's free plan** runs the four apps.
- **Neon's free plan** holds the Postgres database.
- **Cloudflare** holds the DNS for your own domain, so judges get a short address.
- **GitHub Actions** runs the scheduled jobs: reconcile every 15 minutes and a daily smoke test.

Everything talks to the PayPal sandbox only. The file Render reads is `render.yaml` at the repo root, and it holds no secret. For why it's set up this way, see the 8 Nov hosting entries in `DECISIONS.md` and [ADR 0041](adr/0041-render-blueprint-four-services-a-private-resolve-internal-addresses-and-generated-keys.md).

Do the steps in order. Each one needs something from the one before it. Allow about an hour the first time.

## What you get

| Render service | Who reaches it | What it does |
|---|---|---|
| `countersign-gate` | the internet | Countersign itself: `/mcp`, approvals, the audit log, the demo reset and the PayPal webhook |
| `countersign-resolve-agent` | the internet, but it answers only callers that send the shared secret | the support agent. It holds no PayPal credential |
| `countersign-console` | the internet | the start page, inbox, approvals and audit console. Judges start here |
| `countersign-storefront` | the internet | the Kikapu shop |

**What "free" costs you in speed.** A free Render service goes to sleep after about 15 minutes with no visitors. The next visit wakes it, and that takes about a minute. Each service sleeps and wakes on its own, so a judge can wait once for the console, again for the gate when they sign in, and again for Resolve on their first run. The console waits 10 seconds for the gate or Resolve, so a page may say a service "isn't reachable" while it wakes. Trying again a minute later works. The start page tells judges this.

Before you show the demo to anyone, open the console, sign in and run one scenario. That wakes all four.

**Limits to know about.**

- Render gives a workspace 750 free hours a month across all its free services. The four services stay inside that only because they sleep. Don't add an uptime checker that pings them, or they'll use the month's hours in about 8 days and stop.
- Render's free plan has no Shell, no cron jobs and no private network. That's why the scheduled jobs run on GitHub Actions, the services call each other at public addresses, and you run database commands from your own computer.
- Keep every service at one instance. The reset's single-flight flag, the pairing codes and the session limits live in memory.
- Neon's free database pauses itself after a few idle minutes and wakes in under a second, so you won't notice it. Its free plan has a monthly compute allowance. Check Neon's Usage page a day after you go live.

## 1. Create the Neon database

1. Sign in at [neon.tech](https://neon.tech) and choose **New project**.
2. Name it `countersign`. Pick the newest Postgres version it offers, and the region **AWS US West 2 (Oregon)**, which is where the Render services run.
3. On the project dashboard, choose **Connect**.
4. Turn **Connection pooling off**. Countersign needs a direct connection: the audit log takes a lock that a pooled connection can't hold.
5. Copy the connection string. It looks like this:

   ```text
   postgresql://<user>:<password>@<endpoint>.us-west-2.aws.neon.tech/neondb?sslmode=require
   ```

   Check two things. The host has no `-pooler` in it, and the string ends with `sslmode=require` (add `?sslmode=require` if it's missing).
6. Keep it somewhere private, such as your password manager. This is the `DATABASE_URL` you'll paste in steps 2 and 5. Never put it in the repo.

You don't create any tables. The gate creates them every time it builds (`npm run db:migrate`).

## 2. Create the Render services

1. In the Render dashboard, choose **New**, then **Blueprint**. Connect this GitHub repo and pick the branch to deploy.
2. Render reads `render.yaml` and lists the four services, all on the Free plan. It then asks for each value marked `sync: false`. Fill them in as the table says. Leave the "later" ones blank for now: you'll know them only once the services exist.

| Service | Paste now | Leave blank for now |
|---|---|---|
| `countersign-gate` | `DATABASE_URL` (from step 1), `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, `PAYPAL_SEED_VAULT_TOKEN`, `PAYPAL_SEED_VAULT_TOKEN_B`, and `PAYPAL_WEBHOOK_ID` as the placeholder `pending` | `RESOLVE_AGENT_URL`, `RESOLVE_SHARED_SECRET` |
| `countersign-resolve-agent` | `DATABASE_URL` (the same string), `GEMINI_API_KEY` | `GATE_URL` |
| `countersign-console` | nothing | `STOREFRONT_URL`, `CONSOLE_PUBLIC_URL`, `GATE_URL`, `RESOLVE_AGENT_URL`, `RESOLVE_SHARED_SECRET` |
| `countersign-storefront` | `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET` | nothing |

- Use sandbox credentials for every PayPal value. The PayPal client refuses any other address.
- The two vault tokens are the seed buyers' tokens from `npm run seed`. The reset uses them to create replacement orders.
- Resolve has no PayPal values on purpose. When it needs a token, the gate makes one for that run.

3. Choose **Apply**. Render builds all four. The first build takes several minutes.

Render makes some values for you. On the gate it generates the three Countersign keys: `COUNTERSIGN_SUPPORT_AGENT_KEY`, `COUNTERSIGN_OPS_AGENT_KEY` and `COUNTERSIGN_APPROVER_KEY`. Resolve reads the support key from the gate, so the two always match. On Resolve it generates `RESOLVE_SHARED_SECRET`.

Until you finish step 3, Resolve and the console can't find the gate, so a failed or unhealthy first deploy of those two is expected.

## 3. Connect the services to each other

1. **Note each address.** Open each service in the dashboard. Its address is at the top, like `https://countersign-gate.onrender.com`. Render may add a few letters to the name, so copy it rather than typing it. Write down all four.
2. **Copy the shared secret.** Open `countersign-resolve-agent`, then **Environment**, and copy the value of `RESOLVE_SHARED_SECRET`.
3. **Fill in the blanks.** On each service, open **Environment**, choose **Edit**, set these values and save. Type addresses with `https://` and with no path or trailing slash.

| Service | Variable | Value |
|---|---|---|
| `countersign-gate` | `RESOLVE_AGENT_URL` | Resolve's address |
| `countersign-gate` | `RESOLVE_SHARED_SECRET` | the secret you copied |
| `countersign-resolve-agent` | `GATE_URL` | the gate's address |
| `countersign-console` | `GATE_URL` | the gate's address |
| `countersign-console` | `RESOLVE_AGENT_URL` | Resolve's address |
| `countersign-console` | `RESOLVE_SHARED_SECRET` | the secret you copied |
| `countersign-console` | `STOREFRONT_URL` | the storefront's address for now (step 4 changes it) |
| `countersign-console` | `CONSOLE_PUBLIC_URL` | the console's address for now (step 4 changes it) |

4. **Redeploy** the gate, Resolve and the console: on each, open **Manual Deploy** and choose **Deploy latest commit**.
5. **Check Resolve is locked.** Open `<Resolve address>/health` in a browser. It should show `{"ok":true}`. Then open `<Resolve address>/threads`. It should refuse you with 401, because your browser has no secret.

## 4. Put the console and shop on your domain

Judges will see two addresses, so those two get your domain. The gate and Resolve keep their `onrender.com` addresses; only the services and GitHub use them. The steps below use `console.example.com` and `shop.example.com`. Use your own domain in their place.

For each of the console and the storefront:

1. **In Render**, open the service, then **Settings**, then **Custom Domains**, and choose **Add Custom Domain**. Type the name, such as `console.example.com`, and save. Render shows the record it wants: a CNAME that points to the service's `onrender.com` host name. Leave this page open.
2. **In Cloudflare**, open your domain, then **DNS**, then **Records**, and choose **Add record**:

   | Field | Value |
   |---|---|
   | Type | `CNAME` |
   | Name | `console` (or `shop`) |
   | Target | the host name Render showed, such as `countersign-console.onrender.com`, with no `https://` |
   | Proxy status | **DNS only** (the grey cloud). Turn the orange cloud off |
   | TTL | Auto |

   Save it.
3. **Back in Render**, choose **Verify**. Within a few minutes Render checks the record and issues a certificate. Wait until the domain says **Certificate issued** and opening `https://console.example.com` shows the console. It can take up to an hour.

The proxy must be off until Render issues the certificate, because Render can't see your record through the proxy. We recommend leaving it off after that too. If you do turn the proxy on later, first set Cloudflare's **SSL/TLS** mode to **Full (strict)**, or the site loops between addresses.

Then point the console at the new addresses:

4. On `countersign-console`, set `CONSOLE_PUBLIC_URL` to `https://console.example.com` and `STOREFRONT_URL` to `https://shop.example.com`. The phone code points at `CONSOLE_PUBLIC_URL`, so it never depends on proxy headers.
5. Redeploy the console.

## 5. Set up the scheduled jobs on GitHub

`.github/workflows/reconcile.yml` runs every 15 minutes. It checks Countersign's records against PayPal and picks up new disputes. `.github/workflows/smoke.yml` runs every day at 06:17 UTC. It wakes the four services and checks each one answers. Both fail at their first step, naming what's missing, until the values below are set.

1. In the GitHub repo, open **Settings**, then **Secrets and variables**, then **Actions**.
2. On the **Secrets** tab, choose **New repository secret** for each of these:

   | Secret | Value |
   |---|---|
   | `DATABASE_URL` | the Neon connection string from step 1 |
   | `PAYPAL_CLIENT_ID` | the sandbox client ID |
   | `PAYPAL_CLIENT_SECRET` | the sandbox client secret |
   | `RESOLVE_SHARED_SECRET` | the secret you copied from Resolve in step 3 |

3. On the **Variables** tab, choose **New repository variable** for each of these:

   | Variable | Value |
   |---|---|
   | `GATE_URL` | the gate's `onrender.com` address |
   | `RESOLVE_AGENT_URL` | Resolve's `onrender.com` address |
   | `CONSOLE_URL` | `https://console.example.com` |
   | `STOREFRONT_URL` | `https://shop.example.com` |

4. Open the **Actions** tab, pick each workflow and choose **Run workflow** once. Both should finish green. If "Set up job" says it can't find an action, see the F3 item in `OWNER.md`.

Actions minutes are free on a public repo. On a private repo, the 15-minute schedule uses more than the free monthly minutes, so make the repo public first.

## 6. Finish the first deploy

1. **Copy the approver key.** On the gate's **Environment** page, copy `COUNTERSIGN_APPROVER_KEY` into the Devpost testing instructions. Never put it in the repo.
2. **Copy the ops key.** Copy `COUNTERSIGN_OPS_AGENT_KEY` into your `.env.local` for `npm run agent`.
3. **Register the webhook.** In the PayPal sandbox developer dashboard, add a webhook at `<gate address>/webhooks/paypal` for three event groups: refunds (`PAYMENT.CAPTURE.REFUNDED`), disputes (`CUSTOMER.DISPUTE.CREATED`) and payouts (`PAYMENT.PAYOUTS-ITEM.*`). Copy its ID into the gate's `PAYPAL_WEBHOOK_ID` in place of `pending`, save, and redeploy the gate. If the gate is asleep when PayPal calls, PayPal tries again later, and the 15-minute reconcile catches anything missed.
4. **Press Reset once.** Open `https://console.example.com`, sign in with the approver key and press Reset demo. The first reset creates the 30 seed orders (`KIK-1013` to `KIK-1042`), so it can take a minute or two on top of the wake-up. Wait for the line that says the reset is complete.
5. **Check the audit log.** Render's free plan has no Shell, so run this on your own computer, with `DATABASE_URL` in `.env.local` set to the Neon connection string:

   ```text
   npm run ledger -- verify
   ```

   It should report the chain intact, with entry 1 the `demo.reset` entry. Afterwards, put your local `DATABASE_URL` back if you use a different database for development.

6. **Run the smoke test** from your computer against the live addresses:

   ```text
   npm run smoke -- --gate <gate address> --resolve <Resolve address> --console https://console.example.com --storefront https://shop.example.com
   ```

   All four lines should say PASS. If one fails because a service was asleep, run it again a minute later.

## Deploying by hand

Every service has `autoDeployTrigger: off`, so merged work reaches Render only when you deploy it.

1. Open the console's inbox and start page and check that no run is working. A deploy restarts the services, and a restart marks interrupted runs failed.
2. Deploy the gate, then Resolve, then the console and the storefront, from each service's **Manual Deploy** menu. The gate applies any new database migration as it builds, and a failed migration stops its deploy.
3. Sign in on the start page and press Reset demo, so the next judge starts fresh.

If a reset answers that Resolve or Countersign is busy, wait a minute and try again.

## One dispute per judge

Judges can't open a dispute themselves. Open one on `KIK-1032` for each judge you expect, because each dispute serves one judge. No scenario touches `KIK-1032`, so a reset doesn't replace the order and its dispute stays valid. A dispute on an order a scenario refunded is left behind on the replaced order, so don't use those. Open more before sharing the demo with more people.

## Rotating a secret

Rotate the approver key if it leaks or the judging window ends.

1. On the gate, change `COUNTERSIGN_APPROVER_KEY` to a new value. Use a random value of at least 32 characters that differs from both principal keys. Under 32 characters, or equal to a principal key, the gate counts the approver key as unset.
2. Redeploy the gate.
3. Update the key in the Devpost testing instructions.

Browsers that were signed in must sign in again. The old key stops working as soon as the gate restarts.

To rotate Resolve's shared secret, set a new value of at least 32 characters on Resolve, paste the same value on the gate, the console and the GitHub secret, then redeploy all three services. Until all three match, Resolve refuses the others' calls.

To rotate the database password, reset it in Neon, then paste the new connection string on the gate, Resolve and the GitHub secret, and redeploy the gate and Resolve.

## Keeping it up

The hosted demo stays up until 22 December. Check for Next.js security releases weekly until then (ADR 0010). Once a week, also check Render's and Neon's usage pages, and the Actions tab for failed runs.
