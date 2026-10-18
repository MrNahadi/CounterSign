# Roadmap

Each phase is one user-visible feature, built on its own `feature/NN-slug` branch. Numbers in brackets are the in-scope outcomes from brief §5. Phases marked **interactive** run with the human present, not in the loop.

Since brief v1.4 (17 Oct), the autopilot plans, builds, validates and merges each phase in order (`.ralph/AUTOPILOT.md`). The dates below are the original plan, not targets. The Devpost deadline is the one fixed date. Work only the owner can do goes in `.ralph/human.md`.

## Core: Fri 16 – Sun 25 Oct

- [x] **1. Scaffold** *(interactive, spec-ralph Phase 2).* The monorepo runs. Every app and package exists as a stub. A console page renders with Graphite tokens in light and dark. One Vitest test passes. All Feedback commands pass from the repo root, including the Graphite design check.
- [ ] **2. Integration spikes S1–S9** *(interactive).* Each spike in brief §13 passes or has a chosen fallback. Findings go in `docs/spikes.md`, and anything that sets direction becomes an ADR. Credentials live only in local env files and Render. Spike S6 ran first on 16 Oct and is partly done. Its remaining checks move to phase 18, because M-Pesa is now secondary (brief v1.2). The autopilot skips this phase: the open spikes are built inside the phases that need them, S3 in phase 11 and S7 in phase 13.

Additions from the ADRs:
- S4 runs through the shared Resolve harness: an MCP client against PayPal's own MCP server (ADR 0011), driven by our own Gemini function-calling loop (ADR 0014).
- S7 confirms that Render installs Node 26 (ADR 0008).
- S8 checks the Gemini call shape, the fail-closed response check, and the project's real AI Studio rate limits (ADRs 0013, 0015).
- S9 runs on Next 16.4.2 and React 19.3.1 (ADR 0010), checks that the AG Studio theme reads the Graphite CSS variables (ADR 0006), and runs the analyst on Gemini through a server-side route (ADR 0016).
- [x] **3. Decide a refund from records** [1]. Given an order's recorded PayPal and carrier facts, a refund intent gets allow, step-up or deny from a CLI, with reason codes and a verifier trace. Everything runs from fixtures: the mandate schema, the evaluator and the PayPal verifiers.
- [x] **4. Tamper-evident audit log** [5]. Every intent and decision is appended to a hash-chained log. `ledger verify` passes, and fails on any edited row. The entry format is ADR 0022. Later phases add their own entry types: executions and reconciliations in phase 6, approvals in phase 9. The console view and evidence export come in phase 10.
- [x] **5. Kikapu storefront and seed** [7]. A shopper buys on the storefront with JS SDK v6. A seed script creates about 30 real sandbox orders with captures and trackers, and the carrier mock reports lost, stalled, in-transit and delivered. It also builds the PayPal rail client's first calls (orders, captures, trackers). Seed state and shipments live in Postgres (ADR 0023); the client and checkout follow ADR 0024. The live seed needs two vaulted sandbox buyers (`.ralph/human.md`).
- [x] **6. A refund executes once, live** [1, 2]. Decisions use live sandbox records, read through phase 5's rail client and carrier mock and mapped into the verifiers' snapshots. The rail client gains refunds and webhook signature checks. An allowed refund executes on PayPal exactly once, even on replay, and `PAYMENT.CAPTURE.REFUNDED` reconciles it in the audit log. Executions are logged as a request before the rail call and a result after it, and replays re-send only the same request ID (ADR 0026); the new PayPal calls follow ADR 0025. Without a public URL until phase 13, reconciliation is proven by `npm run reconcile` (polling) and the webhook route against fixtures. The live refund needs the seed buyers (`.ralph/human.md`). **Gate G1 (Sun 25 Oct).**

## Product: Mon 26 Oct – Sun 1 Nov

- [x] **7. The gate over MCP** [1]. An agent connects to Countersign's MCP server with a principal key and uses PayPal's tool names. Every guarded PayPal action is decided (refund, dispute accept / evidence / offer, invoice send, order capture, payout), and read-only actions pass through. Each action hashes its own target and executing parameters (ADR 0027). The MCP surface, principal keys and pass-through reads follow ADR 0028, and the gate reads tickets from a ticket store the agent can't write (ADR 0029). Only refunds execute; an allow for any other action is denied `ACTION_UNAVAILABLE` until its phase adds the call. A stand-in agent CLI (`npm run agent`) drives the gate over MCP until Resolve exists.
- [ ] **8. Resolve, protected and baseline** [6]. Customers write in by email or the simulated chat. The Gemini agent investigates, replies, and proposes money actions only through the gate. A switch runs the same agent in baseline mode against PayPal's tools directly. Resolve writes each incoming message to phase 7's ticket store, and its protected mode uses the support agent's principal key. Both channels are simulated: messages are typed into the console's inbox or its customer chat page, and replies are stored, never sent. Resolve owns intake, threads, photos and agent runs, and the console reaches it only through server routes (ADR 0030). The two modes share one prompt, config and local `find_order` order-book tool; baseline spawns PayPal's server per run with a fresh sandbox token; runs have hard step limits and a daily run cap (ADR 0031). The live runs need the principal key and the seed buyers (`.ralph/human.md`).
- [ ] **9. Phone step-up approvals** [3]. A held intent becomes an itemized card on the merchant's phone, opened by QR code. One tap approves or denies exactly that intent. Approvals are single-use and expire as a deny. An approved refund executes as phase 6 does, and this phase adds the invoice-send call; approved dispute actions execute from phase 11 and payouts from phase 12, and until then their approval says the action can't run yet.
- [ ] **10. Claims vs records, and the audit console** [4, 5]. Every decision shows what the message claims beside what the records say, each fact with its source and sandbox ID. The console lists every intent with its trace and rail response, checks the chain, and exports evidence.
- [ ] **11. Dispute evidence** [13]. When a dispute webhook arrives, the agent drafts an evidence pack from the audit log and tracking. The merchant approves it, and it's submitted with `provide-evidence`. Cut line: if S3 failed, this becomes a recorded sandbox submission.
- [ ] **12. Ops-agent supplier payouts** [15]. An ops agent pays an allowlisted supplier through PayPal Payouts, always with step-up. The support agent's payout attempts are denied. This phase adds the ops agent's principal key (`COUNTERSIGN_OPS_AGENT_KEY`) and mandate, `payee.allowlisted`, and the payouts call.
- [ ] **13. The hosted judge path** [8, 18]. The demo runs on Render (paid plans), with resolve-agent as a private service. This phase decides whether baseline mode is offered on the hosted URL (spike S4's dependency audit, ADR 0031). A 60-second guide, a scenario launcher and a reset button that restores the seed state in ≤ 60 seconds work on the hosted URL. The reset truncates the audit log, seed tables, tickets, ticket attachments and agent runs, and starts a fresh seed run, or reuses one whose captures are untouched (ADR 0023). **Gate G2 (Sun 1 Nov): the full PayPal demo path works end to end on the hosted URL.**

## Depth: Mon 2 – Thu 5 Nov

- [ ] **14. Bench v1** [10]. Case sets of ≥ 60 attack and ≥ 50 genuine cases are frozen and tagged with a fixed genuine mix, plus a hold-out slice. One command runs baseline vs protected, writes `bench/results/<date>.json`, and reruns any slice. The M-Pesa slice joins in phase 18.
- [ ] **15. "Attack it yourself"** [9]. A visitor writes any message as any sender and watches the proposal, trace and decision. A counter shows money moved by visitors. Rate limit and daily spend cap are in force, in front of Resolve's `POST /messages` (ADR 0030 adds only a daily run cap).
- [ ] **16. The Risk desk** [11]. An AG Studio dashboard themed with Graphite, with custom widgets for money protected, decisions by reason code, chain status and refund-spike alerts. A Gemini-backed analyst agent, called through a console server route, builds widgets from questions.
- [ ] **17. The mandate compiler** [12]. The merchant writes rules in plain English, sees them compiled and read back, the diff, and the bench cases the change would flip, then signs version N+1.
- [ ] **18. The M-Pesa rail** [14] *(secondary, built last)*. It starts by finishing spike S6: one customer payment with a receipt, and what that receipt masks. Orders paid by M-Pesa are marked paid only on a verified, matching, unused receipt. Genuine overpayments up to KSh 2,000 refund through B2C, and reversals always step up. The M-Pesa bench cases join here. Cut line: if the Daraja sandbox is still unreliable, or time runs out before the freeze, this becomes a documented adapter plus a labeled recorded run. **Gate G3: feature freeze (Thu 5 Nov).**

## Polish and ship: Fri 6 – Wed 11 Nov

- [ ] **19. Ready for judging** [18]. Daily hosted smoke test (Playwright) and uptime monitor run through 22 Dec. A test with an expired PayPal token passes. CI runs typecheck, lint, test, the design check and a secret scan.
- [ ] **20. Submission** [16, 17] *(human-led).*
  - README with judge guide, integration map, AI table, bench summary, threat model and real vs simulated. It passes the cold-read check.
  - Video ≤ 2:55, passing the comprehension check.
  - Devpost text and gallery, and the AG Grid tick-box.
  - **Submit Wed 11 Nov.**

## Human track (parallel, outside the loop)

- [ ] Register the Safaricom Daraja app and the PayPal sandbox app, webhooks and buyer accounts (Fri 16 Oct).
- [ ] Gemini API key from Google AI Studio. If the paid tier is chosen, prepay and set a project spend cap. Render account on paid plans.
- [ ] 5 merchant and 2 developer conversations by Sun 1 Nov, logged in `docs/validation.md` with consent.
- [ ] Request the AG Studio trial licence on Sun 1 Nov, and ask the AG Grid team on Discord for cover until 22 Dec.
- [ ] Pre-create sandbox disputes before recording and before judging.
- [ ] README cold-read and video comprehension checks.
