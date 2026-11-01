# Countersign: rules for coding agents

Start with `HANDOVER.md`: where the build stands, how to set up, and what to do next. `specs/brief.md` is the source of truth for intent. Read it before planning work. Only the owner edits it.

## Commits

Every commit and PR belongs to the repo owner, Farid Nahadi <thenahadi@gmail.com>. Never add a `Co-Authored-By` trailer, a "Generated with" line, or any other AI attribution to commit messages or PR descriptions.

## Never

- Edit `specs/brief.md` or its §8 non-negotiables.
- Spend money, sign up for anything, or contact anyone.
- Read, print, log or commit secrets or `.env` files. Use `.env.example` and `README.md` for variable names.
- Force-push, rebase, reset or delete branches.
- Weaken, skip or delete a test to make it pass.
- Put an AI model in the decision path (mandate, verifiers, rule evaluation, limits, idempotency, approvals, audit log).

## Checks

Every change passes `npm run typecheck`, `npm run lint`, `npm test` and `npm run build`. UI changes also get `npm run ui:shots` (after a build) and a look at the screenshots in light and dark.

## Design system

Every UI in this repo uses the Graphite design system in `Graphite Design/`, with no exceptions.

- Read `Graphite Design/DESIGN.md` before building or changing any screen.
- Before building a component, read its spec in `Graphite Design/components/<Name>/README.md` (index: `Graphite Design/components/README.md`). Write UI copy by the content rules in `Graphite Design/brand-book.md`.
- Take values from `Graphite Design/graphite-tokens.css`, and reuse the primitives in `apps/console/app/ui.tsx`.
- Style with semantic tokens only. No raw hex, and no palette step where a semantic token exists.
- Icons are Lucide. No emojis anywhere in the UI.
- Light is the default theme, and dark must work too.
- Where Graphite doesn't cover a case, pick the option that adds the least visual weight.
- The Countersign logo is `apps/console/app/logo.tsx` (see `brand/README.md`).

## Next.js

The console and storefront run a recent Next.js with breaking changes. Read `apps/console/AGENTS.md` before writing Next.js code.
