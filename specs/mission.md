# Mission

Derived from `specs/brief.md` v1.0. Where the two disagree, the brief wins.

## Summary

Countersign is a money firewall for AI agents that hold PayPal and M-Pesa powers. An agent can propose any money action. Countersign allows, steps up or denies it using only the rails' own records and a mandate the merchant has signed. The agent's words never authorize money; the records do.

We're building it for the PayPal AI Hackathon. We submit on Wed 11 Nov 2026, and the hosted demo stays live until 22 Dec 2026.

## Users

| User | Role | What matters most to them |
|---|---|---|
| Small online merchants (1–10 people) on PayPal, and in Kenya M-Pesa | Primary | An agent that resolves support, refunds included, without risking money. One-tap phone approval for exceptions. Plain-English rules |
| Developers on PayPal's MCP server or Agent Toolkit | Secondary | A drop-in gate that keeps PayPal's tool names |
| Hackathon judges | Audience | Understanding the claim from the video alone. A hosted path that works in ≤ 5 minutes. Integration claims they can verify |

## Goals

The full measures and the rules that keep them honest are in brief §4.

| # | Goal | Target |
|---|---|---|
| G1 | No money moves on an attack | $0 / KSh 0 and 0% attack success, protected mode, ≥ 60 attack cases, worst of 3 runs |
| G2 | Attacks that reach a human come with the reason | ≤ 25% step up; 100% of those show the contradicting record |
| G3 | The agent stays useful | ≥ 60% of genuine cases auto-resolved, ≤ 30% step-up, < 5% wrongly denied |
| G4 | Fast | Median ticket-to-refund ≤ 2 minutes on auto-resolved genuine cases |
| G5 | Real PayPal depth | ≥ 10 capabilities with file links and real sandbox IDs |
| G6 | The second rail is real (secondary) | 3 Daraja APIs with real sandbox responses, or a labeled recorded run. It doesn't block other goals |
| G7 | Grounded in real people | 5 merchants + 2 developers by 1 Nov; ≥ 2 cleared quotes |
| G8 | Understood from the video alone | 2 fresh viewers explain who it's for, what it stopped and why words didn't matter |
| G9 | The demo holds up through judging | Daily smoke test green from 11 Nov to 22 Dec; ≥ 99% uptime |

## In scope

These are the 18 outcomes in brief §5, in priority order:

1. Guarded actions get allow, step-up or deny from records plus the signed mandate, with reason codes.
2. Allowed actions execute exactly once and reconcile.
3. One-tap, hash-bound phone approvals.
4. A claims-vs-records view on every decision.
5. A tamper-evident audit log with verify and export.
6. The Resolve agent in protected and baseline modes.
7. The Kikapu storefront and its seed.
8. The judge path: guide, scenario launcher, QR code, reset.
9. "Attack it yourself".
10. Bench results and reruns.
11. The AG Studio Risk desk.
12. The mandate compiler with diff and bench impact.
13. The dispute evidence flow.
14. The M-Pesa rail (secondary, built last before the freeze).
15. Ops-agent payouts.
16. Interview-backed mandate limits and quotes.
17. The submission materials.
18. A demo that stays up until 22 Dec.

The only cut lines are fallbacks for outside blockers (brief §5). Nothing is cut to save build effort.

## Out of scope

- Production money and real customer data.
- Production go-live, meaning live PayPal credentials or Safaricom shortcode approval.
- Policies that learn automatically.
- Classifiers that try to detect lies or injections.
- Real carrier integrations (the carrier is mocked).
- A WhatsApp Business API integration.
- Automating the PayPal↔M-Pesa bridge.
- More than one merchant, sign-up, or billing.
- Currencies other than USD and KES, and FX.
- Native mobile apps.

## Constraints that shape everything

- No AI in the decision path, and fail closed (brief §8).
- Every number shown is real sandbox output, and simulated parts are labeled.
- Every UI follows the Graphite design system (`Graphite Design/`).
- Commits are the owner's alone, with no Claude attribution.
