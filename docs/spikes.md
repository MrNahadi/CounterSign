# Integration spikes

Findings from roadmap phase 2 (brief §13, spikes S1–S9). Each spike passes or names its fallback. Anything that sets direction also becomes an ADR.

| Spike | Status | Result |
|---|---|---|
| S1 PayPal order, capture, refund, seeding | Passes; seeding route open | Capture, partial refund and refund idempotency work. The vault (one approval for many orders) is refused for now |
| S2 Tracking | Not started | |
| S3 Disputes | Not started | |
| S4 Baseline agent | Not started | |
| S5 Gate skeleton | Not started | |
| S6 Daraja | Partly done; the rest moves to roadmap phase 18 | OAuth, B2C, Transaction Status (echoes the amount), C2B register and STK Push results work. No C2B confirmation or successful STK payment yet |
| S7 Hosting | Not started | |
| S8 Gemini API | Not started | |
| S9 AG Studio | Not started | |

## S1 PayPal order, capture, refund

Script: `spikes/paypal/s1.ts`, one command per REST call. It loads `.env.local` with `tsx --env-file` and never prints the token or secret.

Live run, 16 Oct 2026, on the sandbox app:

| Step | Result |
|---|---|
| OAuth (client credentials) | Works |
| Create order, $48.00 (`7BN283777R9375221`) | `PAYER_ACTION_REQUIRED`, with a `payer-action` approval link. The owner approved it as the sandbox personal buyer |
| Capture | HTTP 201. Capture `7YL89768KH2865638`, `COMPLETED`. The order and capture both carry `payer.email_address` and `payer_id` (the buyer is a `KE` sandbox account) |
| Refund $12.00 with `PayPal-Request-Id` X | HTTP 201, refund `9FA910708B137330K`, `COMPLETED` |
| The same refund again with the same X | HTTP 200 with the **same** refund ID. No second refund |
| Capture after the refund | `PARTIALLY_REFUNDED`. PayPal's fee on the $48.00 capture was $1.93 |
| Vault setup token (save the buyer's PayPal for later orders) | HTTP 403 `NOT_AUTHORIZED` |
| Payout, $1.00 to the sandbox buyer | HTTP 201, batch `XX8SGFEB9W6QQ`, `PENDING` |
| List disputes | HTTP 200, empty list |

Findings:

- **S1's pass condition holds.** Replaying a refund with the same `PayPal-Request-Id` returns the original refund (200 instead of 201). The gate's exactly-once execution can rely on it, with the intent hash as the request ID.
- **Wallet orders carry the payer's email**, so `ticket.from_payer` has a record to check against. Card orders may not, which is why the seed shouldn't use them.
- **The merchant account supports Payouts and the Disputes API**, so phase 12 and spike S3 aren't blocked by the account.
- **Fees are real.** The capture breakdown has `paypal_fee` and `net_amount`. Money-protected figures should say whether they're gross or net.
- **Seeding about 30 orders is still open.** Each wallet order needs a buyer approval. The vault would make it one approval in total, but the app isn't allowed to use it yet. The two routes are switching the vault on in the app's settings, or approving each order in a scripted browser that holds the sandbox buyer's session.

## S6 Daraja

Scripts: `spikes/daraja/s6.ts` (one command per API step) and `spikes/daraja/receiver.ts` (records callbacks in `spikes/out/daraja-callbacks.jsonl`, which git ignores). Both load `.env.local` with `tsx --env-file` and never print the token, the security credential or the callback secret.

Endpoints, from the Daraja 3.0 docs:

| Step | Endpoint |
|---|---|
| OAuth | `GET /oauth/v1/generate?grant_type=client_credentials`, Basic auth with the consumer key and secret |
| C2B register | `POST /mpesa/c2b/v1/registerurl` |
| C2B simulate | `POST /mpesa/c2b/v2/simulate` (sandbox only) |
| Transaction Status | `POST /mpesa/transactionstatus/v1/query`, result posted to `ResultURL` |
| B2C | `POST /mpesa/b2c/v3/paymentrequest`, needs our own `OriginatorConversationID`, result posted to `ResultURL` |

Findings so far (16 Oct 2026):

- OAuth works with the sandbox app. The token lasts 3,599 seconds, and generating a new one invalidates the old one, so each process should cache one token rather than fetch per call.
- The docs describe the C2B confirmation's `MSISDN` as masked (`25470****149`), not hashed. If the sandbox confirms this, `mpesa.recipient_is_payer` can't match on the full phone number (brief §15).
- Validation callbacks only fire when Safaricom enables external validation on the shortcode, which is off by default. Countersign relies on confirmations, not validation.
- Daraja rejects callback URLs that contain M-Pesa, Safaricom, exe, exec, cmd, SQL or query. `spikes/daraja/env.ts` checks every URL before sending it.

Live run, 16 Oct 2026, shortcode 600984 and initiator `testapi` (the samples in Daraja's own docs), with a cloudflared quick tunnel:

| Step | Result |
|---|---|
| OAuth | Works |
| Callbacks through the tunnel | Work. The B2C result arrived about 5 seconds after the request |
| C2B register, v1 and v2 | Fails every time: HTTP 500, `500.003.1001` "Service is currently unreachable" |
| C2B simulate | Accepted (`ResponseCode` 0). No confirmation reached us, because registration failed |
| B2C | Accepted, then the result came back as `ResultCode` 8006, "The security credential is locked" |
| Transaction Status | Not run yet. It needs a working initiator |

What this means:

- **Safaricom's firewall rate-limits bursts.** Several calls within a few seconds got an HTTP 403 from the Incapsula firewall, and the same call worked a few minutes later. The script fetched a new token for every call, which doubles the request count. The rail client must cache its token for the hour and pace its calls.
- **The shared sample credentials are the likely blocker.** Many developers use 600984 and `testapi`, so failed attempts lock the initiator, and other people's registrations may hold the shortcode's URLs. The next step is to find test credentials specific to our app in the portal's simulator, or wait for the lock to clear.
- **Async results carry Safaricom's own queue-timeout URL** in `ReferenceData`, not ours. Nothing depends on that.

Second run, 16 Oct 2026, with the test shortcode and security credential shown in the portal's B2C simulator for our app (600987):

| Step | Result |
|---|---|
| B2C, KSh 10 | Works. Accepted, and the result arrived 18 seconds later with `ResultCode` 0 and receipt `UJG030FFOP` |
| Transaction Status on that receipt (`PartyA` 600987) | Works, and echoes the real amount: `Amount` 10, `TransactionStatus` Completed, `ReceiptNo` `UJG030FFOP`, plus our `OriginatorConversationID` |
| C2B register on 600987 | Works (`ResponseCode` "00000000", "Success") |
| C2B register on 600984 | Still fails with `500.003.1001`, whatever the URL, even `example.com` |
| C2B simulate on 600987, KSh 1,500 | Accepted, but no confirmation reached the tunnel within 2 minutes |

Findings for the M-Pesa rail:

- **Use the app's own test shortcode, never the doc samples.** 600984 and `testapi` are shared by everyone and fail in ways that look like outages.
- **B2C results show the full recipient.** `ReceiverPartyPublicName` is `254708374149 - John Doe`, unmasked.
- **Transaction Status can verify a receipt from Safaricom's records.** It needs the shortcode that was party to the transaction as `PartyA`. Its result carries a new `TransactionID` (`UJG1000000`) for the query itself, so the verifier must read `ReceiptNo`, not `TransactionID`.
- **Formats to parse:**
  - Amounts arrive as JSON numbers, and balances can have cents (`47572230.29`). Convert to integer minor units on arrival.
  - Charges arrive as text, such as `Fee For B2C Payment|KES|33.60`.
  - Times are Kenyan local time with no zone, as `16.10.2026 19:57:48` in B2C results and `20261016195748` in status results. Parse both as UTC+3.
- **Pace the calls.** Bursts still trip the firewall.

Third run, 16 Oct 2026, with the portal open through Claude in Chrome:

| Step | Result |
|---|---|
| Portal C2B simulator | Pre-fills a different test shortcode on each load (600990, then 600981). It first said the app lacked the C2B product, then listed the app after a refresh |
| C2B register + simulate on 600990 and 600981 | Both accepted. No confirmation reached the tunnel within 2 minutes |
| Portal's own C2B simulate on 600981 | Goes through the portal's `/api/graphql`, still pending after 10 seconds. No confirmation reached us |
| STK Push (M-Pesa Express), KSh 1 | Works as a route. The result reached the tunnel 8 seconds later, but the sandbox reported `ResultCode` 1032 "Request Cancelled by user". A second try had no result within 90 seconds |

More findings:

- **STK Push needs no URL registration.** Each request names its own `CallBackURL`, and results come back as `Body.stkCallback`. On success the docs say it carries `MpesaReceiptNumber`, `Amount`, `TransactionDate` and `PhoneNumber`. That makes it the fallback source of customer-payment receipts if C2B confirmations never arrive.
- **A cancelled or failed payment carries no receipt.** The rail must treat result codes such as 1032 as "no payment" and fail closed.
- **The sandbox is erratic for customer payments.** C2B confirmations never came, and STK outcomes varied between attempts. B2C and Transaction Status were reliable.

Still to prove, now at the start of roadmap phase 18 (M-Pesa became secondary in brief v1.2): one customer payment with a receipt (C2B confirmation or successful STK result), what it masks, and Transaction Status on that receipt. Retry at a different time of day. If it never works, phase 18 verifies receipts with Transaction Status only and labels the customer-payment step as a recorded run.
