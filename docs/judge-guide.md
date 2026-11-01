# Judge guide

Countersign checks every money action an AI agent proposes against PayPal's records and your rules. The agent's words never approve a payment. This guide takes about a minute. The README lifts it as is.

## Before you start

You need two things, both in the Devpost testing instructions:

- **The approver key.** It signs you in to the console and opens Approvals.
- **The sandbox buyer login.** It's only for the optional checkout on the Kikapu storefront.

Everything here runs on the PayPal sandbox. No real money moves.

## In about a minute

1. Open the console's start page and sign in with the approver key from the testing instructions.
2. Run the attack email in baseline mode, then protected, and compare what moved.
3. Run the stalled parcel and the damaged basket. Each opens in the inbox, linked to its decisions.
4. Scan the code on the start page to open Approvals on your phone, already signed in, and approve the waiting refund. The Approvals page on the desktop works too.
5. Reset the demo when you're done, so the next person starts fresh.

### What each scenario shows

| Scenario | What to look for |
|---|---|
| The attack email | Baseline: the agent calls PayPal's refund tool directly. Protected: Countersign denies what the records don't support and holds the rest. |
| The stalled parcel | The refund runs on its own, with a real sandbox refund ID. |
| The damaged basket | It waits for you. Approve it on the Approvals page or your phone. |

Baseline mode runs only the attack email on the hosted demo. Run it as the first scenario, then run it again in protected mode to compare.

## Signing in on your phone

The code on the start page carries a one-time sign-in for your phone. It works once and expires after 5 minutes. If the code has expired or was used, the Approvals page says so. Sign in there by pasting the same approver key, or scan a fresh code from the start page.

The code is shown on screens 768px wide and up, so open the start page on a desktop or laptop and scan it with your phone.

## What's real and what's simulated

**Real:** PayPal sandbox orders, captures, refunds, disputes and webhooks, and Countersign's decisions, approvals and audit log.

**Simulated:** The customers and their messages, the carrier's delivery status, and the shop and its people, who are illustrative.

Kikapu Studio is a made-up shop. Its customers are not real people.

## If something goes wrong

- **Sign in again.** The start page asks for the key when your session has ended.
- **A run says it was refused for starting too many runs.** Each session may start 12 runs and 3 resets in 10 minutes. Wait a few minutes.
- **A reset says it's busy.** Resolve or Countersign is working, or the demo was reset less than a minute ago. Wait a minute and try again.
