# Plan

The build's only task list. The loop takes the first `- [ ]` task, top to bottom. Mark a finished task `- [x]`, and a task that failed twice `- [!]` with one line why. Keep tasks small: one module and its tests.

Submit Wed 11 Nov 2026. Scope agreed with the owner on 8 Nov: M-Pesa (old phase 18) is cut, and old phase 19 is trimmed to a smoke test. See `DECISIONS.md`.

Where requirements come from: `specs/brief.md` (§4 goals and honesty rules, §5 scope, §8 non-negotiables), and `specs/brief.original.md` §16 for the bench families A1–A12 and metrics.

## A. Hosted demo

- [x] **A1. Smoke test.** `npm run smoke -- <base URLs>` checks the gate and Resolve `/health`, the console start page and the storefront home, and exits 1 on any failure with one line per check. Files: `tests/smoke/smoke.ts`, a `smoke` script in `package.json`. Done when: a unit test covers pass and fail with a fake fetch, and it passes against `npm run dev`. (The live run against `npm run dev` is still to do, so it's in OWNER.md: the agent couldn't start servers.)

## B. Bench v1

- [x] **B1. Case format and runner.** Cases live in `bench/cases/attack/*.json` and `bench/cases/genuine/*.json`. Each uses Resolve's message-file format (see `apps/resolve-agent/scenarios/`) plus `id`, `family` and `expected` (`no_money`, `allow`, `step_up` or `deny`), written when the case is written. `bench/run.ts` runs cases through Resolve in `baseline` or `protected` mode, reusing Resolve's CLI code rather than shelling out. It writes `bench/results/<date>-<mode>.json` with the git SHA, case-set tag and per-case result. Script: `npm run bench -- --mode protected|baseline [--only <glob>] [--runs N]`. Done when: tests run two cases against a fake Resolve.
- [x] **B2. Scoring.** `bench/score.ts` turns results files into goals G1–G4 (brief §4): money moved without authorization, attack success rate (worst of N runs), step-up share with records shown, genuine auto-resolved, needs step-up, and wrongly denied shares, and median ticket-to-refund time. It writes the summary into the results file and a Markdown table to `bench/README.md`. Done when: tests with hand-made results check every metric.
- [x] **B3. 30 attack cases, families A1–A5.** Six per family, each with `expected` set before any run. Simulated senders and illustrative people only.
- [x] **B4. 30 attack cases, families A6, A7, A11 and A12.** Same rules. This brings the total to 60. A8–A10 are M-Pesa families, so they're cut with M-Pesa: report them as not run.
- [x] **B5. 50 genuine cases** in brief §4's fixed mix: 40% lost or stalled, 20% damaged under the cap, 10% over the cap, 10% wrong item, 10% disputes. The 10% M-Pesa slice is cut: report it as not run, don't redistribute it. Include the cases the mandate escalates by design.
- [x] **B6. Hold-out slice.** 20 attack and 15 genuine cases in `bench/cases/holdout/`, written from the family descriptions in `specs/brief.original.md` §16 only. Don't open the mandate, the gate or the other cases while writing them. Commit unread.
- [x] **B7. Freeze.** Tag `bench-v1` with `git tag -a bench-v1 -m "bench v1"` (the owner pushes the tag; see OWNER.md), and record the case-set tag and SHA in `bench/README.md`. Any later edit to cases or the mandate makes a `bench-v2`. Running the bench needs sandbox credentials, so the owner runs it (OWNER.md).

## C. Attack it yourself

- [x] **C1. The page.** Console route `/attack`: sender, channel and message fields. A console server route posts to Resolve's `POST /messages`, and the page shows the proposal, verifier trace and decision with the existing claims-vs-records components. Graphite primitives from `apps/console/app/ui.tsx` only.
- [x] **C2. Limits and counter.** Visitor runs are rate-limited per session and capped per day, reusing phase 13's session limits and ADR 0030's daily run cap. A counter shows money moved by visitors, read from the audit log, and it should stay at $0.00. Add `/attack` to the screenshot harness.

## D. Risk desk (AG Grid sponsor prize)

- [x] **D1. From spike to page.** Promote `apps/console/app/spike/risk-desk` to `/risk`, with the AG Studio theme from `packages/graphite/src/ag-theme.ts`. Three widgets read real audit-log data: money protected, decisions by reason code, chain status. Without `AG_STUDIO_LICENSE_KEY`, fall back to AG Grid Community grids (brief §5 cut line). Add `/risk` to the screenshot harness and the console nav.
- [x] **D2. Spike alert and analyst.** A refund-spike alert widget, and the analyst: a console server route that sends the question to Gemini (reuse `gemini-adapter.ts`) and returns a widget spec from a fixed allowlist. It can't move money.

## E. Mandate compiler (only if time remains)

- [ ] **E1. Compile and read back.** A console server route turns plain-English rules into the Mandate schema with Gemini structured output, validated with zod, and reads them back in plain English. Never at decision time.
- [ ] **E2. Diff, flips and sign.** Show the diff against the current mandate, replay the frozen bench decisions offline (no AI, through the decide path) to list the cases the change flips, then sign version N+1 with its hash in the audit log.

## Z. Before submission

- [ ] **Z1. Full check and README.** Run all four checks and `npm run ui:shots`. Update README "Project status" and the judge-facing sections for what was built. Leave video and Devpost to the owner.
