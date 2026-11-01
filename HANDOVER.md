# Handover: continuing Countersign with a new coding agent

Written 1 Nov 2026, when the build moved from Claude Code in the cloud to a local machine and a different coding agent. Read this first, then `AGENTS.md`, then `specs/brief.md`.

## 1. What this project is

Countersign is a money firewall for AI agents with PayPal (and, later, M-Pesa) powers. An agent proposes a money action (refund, payout, dispute response). Before anything moves, Countersign checks it against the payment system's own records and a mandate the merchant signed, then decides **allow**, **step-up** (one-tap approval on the owner's phone, bound to that exact intent) or **deny**, with reason codes. Every decision is written to a hash-chained audit log. The agent's words never authorize money; the records do.

It's an entry to the PayPal AI Hackathon (Devpost). **We submit Wed 11 Nov 2026**; the hard deadline is Thu 12 Nov, 12:00 PT. The hosted demo must stay up until 22 Dec.

## 2. Sources of truth, in order

1. `specs/brief.md`: intent, scope, non-negotiables (§8), ranked trade-offs (§10), definition of done (§12). **Only the owner edits it.**
2. `AGENTS.md`: the rules every change follows (design system, commits, never-list).
3. `docs/adr/`: decisions 0001 to 0047. Check here before reopening a settled question.
4. `specs/roadmap.md`: the phase list, with what's ticked.
5. `specs/tech-stack.md`, `CONTEXT.md` (domain glossary), `README.md` (how to run everything).
6. `.ralph/human.md`: work only the owner can do (`## Open`) and decisions made on their behalf (`## Decided for you`). Read the headings and the lines for your phase; it's long.
7. `Graphite Design/DESIGN.md` and `Graphite Design/graphite-tokens.css`: the design system every UI uses.

## 3. Where things stand

**On `main`, all merged and pushed:** phases 1 and 3 to 13, plus 13a. Phase 2 was skipped on purpose (its spikes were built inside the phases that needed them). Typecheck, lint, 2,532 tests and the build all pass on `main`.

| Phase | What it delivered |
|---|---|
| 3–12 | Decide a refund from records, tamper-evident audit log, Kikapu storefront and seed, refund executes once, the gate over MCP, Resolve (protected and baseline), phone step-up approvals, claims-vs-records console and audit view, dispute evidence, ops-agent payouts |
| 13 | Hosted judge path: `render.yaml` blueprint, demo reset in the gate, start page with scenario launcher, phone pairing code, sign-in on every console route to Resolve, session limits, `RESOLVE_BASELINE` policy, 30s PayPal timeouts, judge guide (`docs/judge-guide.md`) and hosting doc (`docs/hosting.md`) |
| 13a | The owner's Graphite refresh at comfortable density (14px UI text, 56px rows, inset container shell) across every UI, plus a screenshot harness (`npm run ui:shots`) with density checks |
| (no phase) | The owner's logo: `brand/`, `apps/console/app/logo.tsx`, favicon `apps/console/public/icon.svg` |

**Nothing is in progress.** No open branch carries unmerged work. The old feature branches are merged; leave them alone (don't delete them).

**Next up: phase 14, Bench v1.** Then 15 to 19. Phase 20 (submission) is the owner's.

| Phase | Scope (from `specs/roadmap.md`) | Review depth |
|---|---|---|
| 14. Bench v1 | ≥ 60 attack and ≥ 50 genuine cases across families A1–A12, frozen and tagged `bench-v1` before any tuning run, with a fixed genuine mix and a hold-out slice. One command runs baseline vs protected and writes `bench/results/<date>.json`; any slice can rerun. Brief §4 "How the targets stay honest" is binding | Readiness check only |
| 15. "Attack it yourself" | A visitor writes any message as any sender and watches proposal, trace and decision; a counter shows money moved by visitors; rate limit and daily spend cap | Full review |
| 16. The Risk desk | AG Studio dashboard themed from Graphite tokens, custom widgets, a Gemini analyst agent behind a console server route. Targets the AG Grid sponsor prize | Full review |
| 17. The mandate compiler | Plain-English rules → Gemini structured output → typed Mandate, read back, diffed, with the bench cases the change would flip, then signed as version N+1 | Full review |
| 18. The M-Pesa rail | Secondary, built last. Finish spike S6, then mark-paid on a verified receipt, B2C refunds up to KSh 2,000, reversals always step up. Cut line in brief §5 if Daraja's sandbox is unreliable | Readiness check only |
| 19. Ready for judging | Daily hosted smoke test (Playwright), uptime monitor through 22 Dec, expired-token test, CI with typecheck, lint, test, design check and a secret scan. Also revisit Cloudflare hosting and the keyframes.org.uk domain (the owner deferred both to here) | Readiness check only |

## 4. Set up the local machine

1. **Node 26.7 or later, below 27** (`package.json` `engines`; `.node-version` says `26`), and **npm 11**.
2. Update the clone: `git checkout main`, then `git pull --ff-only origin main`.
3. Install exactly what's locked: `npm ci`.
4. Run `npm run local:setup` to create missing local access keys without overwriting existing
   configuration. Fill missing sandbox variables locally using `.env.example` for their names;
   preserve any existing `.env.local`. Never commit it. Unit tests, typecheck, lint and build
   need **no** credentials. The local launcher loads both root env files; other CLIs use
   `.env.local` or exported variables unless their command says otherwise.
5. The audit log needs `DATABASE_URL` (Postgres) only for real runs; without it the CLIs fall back to a local PGlite folder, `.countersign/pglite`.
6. Check everything is green before you change anything:

```bash
npm run typecheck
npm run lint
npm test
npm run build
```

Expect: typecheck and lint clean, about 2,533 tests passing and 21 skipped (live tests, which run
only with `LIVE=1` and real credentials), and a successful build of the console and storefront.
On Windows, use `npm test -- --testTimeout=15000 --maxWorkers=4` to allow for cold embedded
database startup and bound parallel memory use. Test assertions and live-test gates are unchanged.

7. The screenshot harness needs Chromium. Locally, run `npx playwright install chromium` once (the pinned `@playwright/test` is 1.64.1). Then `npm run ui:shots` builds nothing itself: run `npm run build` first. It starts fake upstreams and both Next apps, shoots every screen in light and dark at 1440px and 390px, runs the density checks and writes `test-results/ui-shots/*.png` plus `report.json`. `npm run ui:shots -- --only decisions` shoots one screen. If you'd rather use an installed Chrome, set `UI_SHOTS_CHROMIUM` to its path. (In the cloud it pointed at `/opt/pw-browsers/...`; that path is set in `.ralph/settings.json` and won't exist on your machine, which only matters if you run the Claude loop.)

For local development run `npm run local:setup`, then `npm run dev` from the repo root. The
launcher loads `.env` as a fallback and `.env.local` as overrides without displaying values.
It runs Gate (8787) and Resolve (8788) with one shared database handle, plus console (3000)
and storefront (3001), all on `127.0.0.1`. No separate Postgres installation is required.
Ctrl+C stops every app. See README's "Run the apps" and ADR 0047.

Local setup creates missing access keys in ignored `.env.local`; the owner signs in using
`COUNTERSIGN_APPROVER_KEY` from that file or the existing environment. Never display it.
Next dev and production builds use Webpack on Windows because Turbopack's CSS worker fails
on this machine; Linux and Render keep their existing default. Frontend changes reload;
restart the launcher for backend or environment changes.

With PGlite, stop dev before any database CLI. To seed, configure the two different sandbox
buyers' payment-token IDs as described in `docs/seed-buyers.md`, run `npm run seed:local`,
then restart dev. `seed:local` loads both root env files. No seed, payment or AI call runs
automatically during setup.

## 5. How work was done, and how to keep doing it

The previous agent used a spec-driven loop. The Claude-specific scripts in `.ralph/` (`ralph.sh`, `push-loop.sh`, `role.sh`) call the `claude` CLI and won't run with another agent, but the **method** is tool-neutral and worth keeping, because it's what kept quality high and the brief honest:

1. **Plan the phase.** Create `specs/features/NN-slug/` with `design.md` (from `.ralph/egm/design-template.md`, with a `## Detailed Implementation Plan` heading), `requirements.md` and `validation.md`. Read the brief sections the roadmap line cites in brackets, e.g. `[10]` is brief §5 item 10. Look at `specs/features/13-hosted-judge-path/` for a complete example.
2. **Review the design with fresh eyes** before coding. The persona prompts are in `.ralph/egm/agents/` and the standards in `.ralph/egm/standards/`. Phases 15–17 get a full review (Zoom Out, Comprehension, Design Critic, then Implementation Readiness); 14, 18 and 19 get the readiness check only. Log each finding and how you resolved it in `specs/features/NN-slug/reviews/resolution.md`.
3. **Write tickets** in `tickets.md` using `.claude/skills/spec-ralph/references/ticket-format.md`: one module and its tests per ticket, each naming the files it touches and its acceptance checks, with `Status: open | in-progress | done | blocked-question` and `Blocked by:`.
4. **Build one ticket at a time.** `.ralph/PROMPT.md` is the per-ticket procedure: pick the next ready ticket, load only the context it needs, build it with tests, run the four checks, review your own diff, tick the acceptance boxes, set `Status: done`, commit `feat(T-NNN): ...`, and push. Gotchas go in `.ralph/progress.md`, one line each.
5. **Validate** with `.ralph/AUTOPILOT.md` section 4: the four checks, every automated check in `validation.md`, a diff review against `requirements.md` and `AGENTS.md`, small fixes as `fix(NN): ...`, owner-only checks added to `.ralph/human.md`, then tick the roadmap item and commit `docs(NN): validated`. For UI, run `npm run ui:shots` and look at the PNGs in both themes.
6. **Ship:** merge the feature branch into `main` (fast-forward, or `--no-ff` if `main` moved, never a rebase), rerun the four checks on `main`, push.

Branches are `feature/NN-slug`. When a decision is critical (it touches brief §8, moves money, handles secrets or auth, fixes an external contract, or changes what a judge sees) and the brief doesn't settle it: pick the option that fails closed, write an ADR in `docs/adr/` with `Decided-by: autopilot (delegated)`, and add one line to `.ralph/human.md` under `## Decided for you` so the owner can overturn it. Questions you can't settle go in `questions/open/` (see existing files in `questions/answered/` for the shape).

## 6. Rules that don't bend

These are in `AGENTS.md` too.

- **Commits belong to the owner:** author `Farid Nahadi <thenahadi@gmail.com>`. No `Co-Authored-By`, no "Generated with", no AI attribution in commits or PR text.
- **Never** edit `specs/brief.md` (or §8), spend money, sign up for anything, contact anyone, print or commit secrets, force-push, rebase, reset or delete branches, or weaken, skip or delete a test to make it pass.
- **Brief §8 non-negotiables**, in short (read §8 itself before touching the gate):
  - No AI model in the decision path: verifiers, rule evaluation, limits, idempotency, approvals and the audit log are plain code (`tests/no-ai-in-decision-path.test.ts` enforces it).
  - The agent never holds PayPal or Daraja credentials; only Countersign does.
  - Fail closed: only a matched rule whose requirements all pass can allow; no match, unknown actions and `unknown` facts deny.
  - What you approve is what executes: approvals are single-use and bound to the hash of the exact intent.
  - Every number shown in the demo, README or Devpost text is real sandbox output; simulated parts are labeled; the baseline isn't tuned to fail; bench sets and the mandate are frozen before tuning.
  - Sandbox only, no secrets in the repo, every sample person and shop labeled illustrative, no third-party logos in the UI or video.
  - The public demo is rate-limited per session with a daily AI spend cap; the hosted demo stays up until 22 Dec.
  - Every UI follows Graphite.
- **Code conventions the validator checks:** zod at every external input, integer money (minor units), fail-closed paths.
- **Graphite on every UI:** semantic tokens only, no raw hex, no palette step where a semantic token exists, Lucide icons, no emojis anywhere, light by default with dark working too. `packages/graphite/test/design-check.test.ts` fails the build on violations. Reuse `apps/console/app/ui.tsx` primitives.
- **Add no dependency without an exact pin**, and prefer one that's at least two weeks old.

## 7. Waiting on the owner

`.ralph/human.md` → `## Open` holds the owner queue. Until its prerequisites are done, use
fixtures for automated checks and leave the live checks pending. The ones that matter most now:

- **Render:** create the services from `render.yaml` on paid plans, set the environment, then run phase 13's manual checks 1 to 9 (`specs/features/13-hosted-judge-path/validation.md`).
- **Remaining credentials and account checks:** confirm the Gemini tier, obtain the AG Studio licence (`AG_STUDIO_LICENSE_KEY`), and open a sandbox dispute ahead of time. The two seed vault tokens and the principal, ops and approver keys are configured locally; hosted services still need their own environment setup.
- **`.env.example`:** the local setup change adds reset, baseline, service addresses, database,
  access keys and the second buyer token to the template. The owner fills real values locally.
- **Start page copy:** on a phone, step 4 says "Scan the code below" but the code isn't shown at that width. The owner should pick the wording.
- **Merchant interviews (goal G7):** 5 merchants and 2 developers, logged in `docs/validation.md` (it doesn't exist yet). The demo mandate's limits are meant to come from them.

## 8. Things that will trip you up

- `.env.local` and `.env.*` are deliberately unreadable to agents. Work from variable names in `README.md`.
- The Next apps transpile workspace packages; a new workspace package needs `npm install` (to link it and update `package-lock.json`) and a `transpilePackages` entry. Commit the lockfile, or Render's `npm ci` fails.
- `npm run typecheck` also runs `next typegen` for the Next apps; a route added without it fails typecheck.
- Live tests are opt-in (`LIVE=1`). Don't make a default test depend on the network or a secret.
- Bench honesty (brief §4): freeze and tag the cases and mandate as `bench-v1` **before** the first tuning run; label expected outcomes when authoring a case; the hold-out slice is written without sight of the mandate or gate and run once, at the end.
- `docs/brief.md` and `docs/countersign.md` are older copies; `specs/brief.md` is the live brief.
- `.ralph/HANDOVER.md` is the previous Claude conductor's notes on cost and process. Useful history, but this file supersedes it.

## 9. Your first session

1. Do section 4 and confirm the four checks are green.
2. Read `specs/brief.md` §4 (goals and honesty rules), §5 item 10, §8 and §10, then the roadmap line for phase 14.
3. Branch `feature/14-bench-v1` from `main` and start section 5, step 1, for phase 14.

## 10. Local setup handoff (1 Nov 2026)

Dependencies and Playwright Chromium are installed on this machine. The local launcher has
been checked against real Gate/Resolve health endpoints and browser sign-in, Start, Inbox,
Approvals, Audit log, Decisions, storefront and product pages. These checks made no payment
or AI calls. A supplied database's ownership is covered by an additional Resolve test.
The old queue lint warning is fixed without changing its callback behavior. A ledger CLI
test now splits both Windows and Unix line endings while keeping its exact assertions.
Browser screenshots and check logs are under ignored `test-results/local-setup/`.
Final verification: full workspace typecheck, lint and both production builds pass. The full
offline suite with the Windows options above reports 2,533 passed and 21 skipped. Ctrl+C
released all four ports. The dev server was stopped after verification so the owner can run
it in their own terminal and stop it before any database CLI. No need to reinstall dependencies or
repeat the repository-wide orientation in the next chat.

The existing root `.env` supplies PayPal/Gemini configuration through the launcher; agents
must not inspect its values. Both sandbox buyers have now approved saving their payment
methods. Their reusable tokens are saved in ignored `.env.local` as
`PAYPAL_SEED_VAULT_TOKEN` and `PAYPAL_SEED_VAULT_TOKEN_B`; read-only PayPal checks verified
each belongs to the expected buyer and that the buyers differ. No secret values were displayed.

With dev stopped, `npm run seed:local -- --run local20261101` seeded 30 of 30 real sandbox
orders: 16 delivered, 6 in transit, 4 stalled and 4 lost. The first run took approximately
60 seconds; replaying that run reused its orders. A database check confirmed 30 distinct
order IDs and 30 distinct capture IDs. Live PayPal reads verified completed captures and
attached trackers for KIK-1038 and KIK-1042, with different payers. This does not establish
the separate live reset performance target. Live refund scenarios, opt-in live tests and
the merchant-dashboard visual check remain pending in `.ralph/human.md`.

The PayPal sandbox app already has Vault and the needed payment features enabled. No
webhook is configured yet; configure it when a public HTTPS callback is available. No
hosted deployment has been verified here. Restart with `npm run dev` to load the saved
tokens and seeded database. The console is at `http://127.0.0.1:3000` and the storefront
at `http://127.0.0.1:3001`. No AI or refund calls were made during this seed setup.

Phase 14 has not started. The owner wants to continue it in a new chat. Preserve their model
preference: GPT-6.1 Sol at high for ordinary roles, and xhigh only for answerer questions.
The legacy `.ralph/*.sh` scripts still invoke Claude; don't start them as a Codex loop.
Keep planning lean, apply the readiness-only review for phase 14, and load focused context
per ticket. The hold-out writer must be a fresh session with no gate or mandate context.
