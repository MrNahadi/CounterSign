# Progress: phase 13a, Graphite at a comfortable density (specs/features/13a-graphite-comfortable)

Gotchas only, one line each.

- Chromium is preinstalled: run the harness as `UI_SHOTS_CHROMIUM=/opt/pw-browsers/chromium-1243/chrome-linux64/chrome npm run ui:shots ...` (the binary; `/opt/pw-browsers/chromium` doesn't exist). Never run `npx playwright install`.
- `@playwright/test` 1.64.1 is already an exact root devDependency (f5a3569). Don't install or bump it.
- Run `npm run build` before `npm run ui:shots`; it starts both apps with `next start`.
- Tailwind v4 doesn't let a later class beat an earlier one: append layout classes only to a recipe, never padding, height, radius, gap or font size.
- Keep the literal `className="overflow-x-auto..."` element directly around every `<table` (console-setup test).

- T-001: added tests/ui-shots/fixtures.ts (+ test, tsconfig, root tsconfig exclude, typecheck script entry). Gotcha: `Fixtures.decision` and `Fixtures.thread` are records keyed by seq string / thread ID; `photo` is a Uint8Array; the exports in the decision page aren't upstream data, so none are fixtured. The seed `dispute_id`s are `PP-D-2026-0117` (proposed) and `PP-D-2026-0098` (failed); the gate fake in T-002 must know them if `dispute-routes.ts` reads them.
