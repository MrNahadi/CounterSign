# Countersign: rules for coding agents

Countersign is a money firewall for AI agents with PayPal powers. Every refund, payout or dispute action an agent proposes is checked against PayPal and carrier records and a mandate the merchant signed, then allowed, held for a one-tap phone approval, or denied. It's a PayPal AI Hackathon entry, **submitted Wed 11 Nov 2026**.

## How work happens

- `PLAN.md` is the only task list, `progress.txt` is the running log, and `DECISIONS.md` records choices. `OWNER.md` lists what only the owner can do.
- The loop runs one fresh agent per task: `./loop.sh codex` or `./loop.sh claude`. Each run follows `PROMPT.md`.
- `specs/brief.md` is the source of truth for intent; `specs/brief.original.md` has the bench families and the demo script. Only the owner edits either.
- How to run things: `README.md`. Domain words: `CONTEXT.md`. Past decisions: `docs/adr/`.

## Checks

`npm run typecheck`, `npm run lint`, `npm test`, `npm run build`. In a loop run, check only the workspaces you touched, and run the full set at the end of a `PLAN.md` section. UI changes also get `npm run ui:shots` (run `npm run build` first; on a new machine, run `npx playwright install chromium` once).

## Never

- Edit `specs/brief.md`, `specs/brief.original.md` or the brief's §8 non-negotiables.
- Put an AI model in the decision path (mandate, verifiers, rule evaluation, limits, idempotency, approvals, audit log). `tests/no-ai-in-decision-path.test.ts` enforces it.
- Read, print or commit secrets or `.env` files. Variable names are in `README.md`.
- Spend money, sign up for anything, or contact anyone.
- Push, force-push, rebase, reset or delete branches. The loop pushes.
- Weaken, skip or delete a test to make it pass.
- Add AI attribution to a commit (`Co-Authored-By`, "Generated with"). Commits belong to the owner, Farid Nahadi <thenahadi@gmail.com>.

## Code rules

- Fail closed: no matched rule, an unknown action or an unknown fact means deny.
- zod at every external input. Money as integers in minor units.
- Every number shown to judges is real sandbox output, and simulated parts are labeled.

## Design system

Every UI uses Graphite (`Graphite Design/`), with no exceptions.

- Read `Graphite Design/DESIGN.md` before changing a screen, and reuse the primitives in `apps/console/app/ui.tsx`.
- Semantic tokens from `Graphite Design/graphite-tokens.css` only: no raw hex, and no palette step where a semantic token exists. `packages/graphite/test/design-check.test.ts` enforces it.
- Lucide icons. No emojis anywhere. Light by default, and dark must work.
- The logo is `apps/console/app/logo.tsx` (see `brand/README.md`).
- The console and storefront run a recent Next.js with breaking changes: read `apps/console/AGENTS.md` before writing Next.js code.
