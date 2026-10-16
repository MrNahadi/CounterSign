# 0004. TypeScript 5.9.3 in every workspace

Status: accepted
Decided-by: answerer (researched)
Question: Phase 1 constitution, Q4. TypeScript version: 5.9.3 or 7.0.2? Next.js 16.4 and the AG Studio boilerplate (^5) need to keep working.
Decision: Pin `typescript` 5.9.3 in every workspace. Don't use 7.x, and don't use 6.x either.
Basis:
- TypeScript 7.0 shipped without a stable programmatic API, which is expected in 7.1. Tools built on the API, typescript-eslint among them, can't use 7.0: https://infoq.com/news/2026/08/typescript-7-released/
- Next.js's default build-time type checker uses that API. With TypeScript 7, `next build` works only with `experimental.useTypeScriptCli: true`, which the docs say is "not recommended for production": https://nextjs.org/docs/app/api-reference/config/next-config-js/useTypeScriptCli
- The AG Studio boilerplate pins `typescript` ^5. TypeScript 6.0 turns on new deprecations and brings nothing this project needs. TypeScript 7 was released after the Ralph loop model's June 2026 training cutoff.
Consequences:
- Typecheck with `tsc --noEmit` in each workspace (see ADR 0009).
- Turn on `erasableSyntaxOnly` (available since 5.8) in the shared tsconfig. See ADR 0007.
- Revisit 7.x after 22 Dec 2026, once 7.1 ships its API and Next.js supports it by default.
