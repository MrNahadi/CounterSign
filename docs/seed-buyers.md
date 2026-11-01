# Set up the two sandbox seed buyers

The seed catalog uses two different PayPal Personal sandbox accounts so the demo can test a
message from someone other than an order's payer. Both payment tokens must be created using
the same sandbox REST app that the project uses to seed orders. No real money is involved.

1. In the [PayPal Developer Dashboard](https://developer.paypal.com/dashboard/), open your
   sandbox REST app. Under Sandbox App Settings, enable Accept payments and Vault in its
   Advanced options. Have two different Personal sandbox accounts ready.
2. From the repository root in PowerShell, create a temporary setup token:

   ```powershell
   npx tsx --env-file-if-exists=.env --env-file-if-exists=.env.local spikes/paypal/s1.ts vault-setup
   ```

3. Keep its `id` and open its `approve` URL in your browser. Sign in as sandbox buyer A and
   approve saving the payment method. The helper's return URL is an example.com placeholder;
   it isn't a page in Countersign.
4. Exchange the approved setup ID:

   ```powershell
   npx tsx --env-file-if-exists=.env --env-file-if-exists=.env.local spikes/paypal/s1.ts vault-token SETUP_TOKEN_ID
   ```

5. Put the **new payment-token `id`** from that response into `.env.local` as
   `PAYPAL_SEED_VAULT_TOKEN`. Don't use the temporary setup ID.
6. Create a fresh setup token and repeat the approval and exchange as sandbox buyer B.
   Sign out of buyer A first or use a separate browser profile. Store B's payment-token `id`
   as `PAYPAL_SEED_VAULT_TOKEN_B`.

```dotenv
PAYPAL_SEED_VAULT_TOKEN=BUYER_A_PAYMENT_TOKEN_ID
PAYPAL_SEED_VAULT_TOKEN_B=BUYER_B_PAYMENT_TOKEN_ID
```

Keep these values in your local environment file, never in chat, screenshots, logs or commits.
The old spike helper displays the payment-token response in your own terminal so you can copy
its ID; don't share that output. The local setup command reports only missing variable names.

Stop `npm run dev` with Ctrl+C before seeding with embedded PGlite. Then run:

```powershell
npm run local:setup
npm run seed:local -- --dry-run
npm run seed:local
npm run dev
```

The dry run describes the catalog; the seed creates real **sandbox** orders. It should end
with 30 seeded orders. Save its run ID if it is interrupted: rerun with `--run RUN_ID` to
resume instead of creating another run. Restarting dev reloads your new variables.

If PayPal returns `NOT_AUTHORIZED`, check that Vault is enabled for the same sandbox REST
app as the configured client ID and secret. The earlier project spike needed a few minutes
for a newly enabled feature to appear in new access tokens. Don't switch to live credentials.

Reference: [PayPal: save a wallet without a purchase](https://developer.paypal.com/api/payment-tokens/save-without-purchase/paypal).
