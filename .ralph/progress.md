# Progress: phase 13a, Graphite at a comfortable density (specs/features/13a-graphite-comfortable)

Gotchas only, one line each.

- Chromium is preinstalled: run the harness as `UI_SHOTS_CHROMIUM=/opt/pw-browsers/chromium-1243/chrome-linux64/chrome npm run ui:shots ...` (the binary; `/opt/pw-browsers/chromium` doesn't exist). Never run `npx playwright install`.
- `@playwright/test` 1.64.1 is already an exact root devDependency (f5a3569). Don't install or bump it.
- Run `npm run build` before `npm run ui:shots`; it starts both apps with `next start`.
- Tailwind v4 doesn't let a later class beat an earlier one: append layout classes only to a recipe, never padding, height, radius, gap or font size.
- Keep the literal `className="overflow-x-auto..."` element directly around every `<table` (console-setup test).
