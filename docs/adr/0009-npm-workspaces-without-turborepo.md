# 0009. npm workspaces alone, without Turborepo

Status: accepted
Decided-by: answerer (inferred)
Question: Phase 1 constitution, Q9. Monorepo tooling: npm workspaces alone, or with Turborepo? The Feedback commands (typecheck, lint, test, build) must run from the repo root.
Decision:
- Use npm workspaces only (the npm bundled with Node 26), with `"workspaces": ["apps/*", "packages/*"]`, plus `bench` if it gets its own `package.json`. No Turborepo or Nx.
- Root scripts:
  - `typecheck`: `npm run typecheck --workspaces --if-present`. Each workspace runs `tsc --noEmit`; the Next apps run `next typegen && tsc --noEmit`.
  - `lint`: `biome check .`
  - `test`: `vitest run`, with one root config listing the workspaces in `test.projects`.
  - `build`: `npm run build --workspaces --if-present`. Only the Next apps have a build.
  - `bench`: `tsx bench/run.ts`, so `npm run bench -- --slice=A4,A8` works.
Basis:
- Brief §9, Repo, No opinion: "Workspace tooling (the original's `npm run bench` implies npm)".
- Brief §12: "`npm run bench -- --slice=A4,A8` runs by following the README's instructions."
- Brief §10, trade-off 6: hitting the gate dates comes ahead of code elegance.
- ADR 0007 removes package build steps, so there's no build graph to order. Turborepo's value is caching and ordering builds. It would add config and a result cache the test-driven loop doesn't need.
- `next typegen && tsc --noEmit` is the pattern Next.js documents for type-checking without a build: https://nextjs.org/docs/app/api-reference/cli/next
Consequences:
- Commit `package-lock.json`. Use `npm ci` in CI and on Render.
- Every workspace declares its own dependencies and never relies on hoisting.
- Declare `zod` 4 at the root so the hoisted copy is v4 (see ADR 0011).
