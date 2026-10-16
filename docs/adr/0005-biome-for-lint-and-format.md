# 0005. Biome alone for lint and format

Status: accepted
Decided-by: answerer (researched)
Question: Phase 1 constitution, Q5. Lint and format: Biome 2.5 alone, or ESLint 10 + Prettier, for a Next.js + Node monorepo?
Decision:
- Pin `@biomejs/biome` 2.5.15 with one root `biome.json` that covers every workspace. Don't use ESLint or Prettier.
- Root scripts: `lint` is `biome check .`, `lint:fix` is `biome check --write .`, and CI runs `biome ci .`.
- In `biome.json`, set `vcs.useIgnoreFile: true` and `css.parser.tailwindDirectives: true`.
- When porting the AG Studio boilerplate, remove its ESLint config and devDependencies.
- The Graphite checks (no raw hex, no emojis, no default Tailwind palette classes) are a Vitest test, not a lint plugin.
Basis:
- Next.js 16 removed `next lint`, so nothing in Next.js requires ESLint. The same page warns that some plugins inside `eslint-config-next` don't list ESLint 10 as a peer, "so your package manager may show peer dependency warnings, or fail": https://nextjs.org/docs/app/api-reference/config/eslint
- Biome turns on the Next (`next` >= 14), React, Test (`vitest`), Playwright and Drizzle rule domains automatically when those dependencies are declared: https://biomejs.dev/linter/domains/
- Biome parses Tailwind v4 directives behind `css.parser.tailwindDirectives`: https://biomejs.dev/reference/configuration/
Consequences:
- One fast binary with no plugin peer-dependency conflicts. The loop runs `biome check --write` to fix formatting and imports in one step.
- Type-aware linting is limited to what Biome provides. `tsc` remains the type gate.
