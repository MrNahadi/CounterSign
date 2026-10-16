# 0006. Tailwind v4 limited to Graphite tokens, shared through a `graphite` workspace package; the AG Studio theme reads the same CSS variables

Status: accepted
Decided-by: answerer (researched)
Question: Phase 1 constitution, Q6. Styling with Graphite: Tailwind v4 with only Graphite tokens exposed, or CSS Modules? What is the cleanest way to share `graphite-tokens.css` across the Next.js apps? How should an AG Studio theme consume the CSS variables?
Decision:
- Both Next apps use Tailwind CSS 4.3.3. A workspace package `packages/graphite` (`@countersign/graphite`) holds three files:
  - `graphite-tokens.css`: a byte-identical copy of `Graphite Design/graphite-tokens.css`. A Vitest test fails if the two differ.
  - `tailwind.css`: imports the tokens, resets Tailwind's own theme namespaces, and registers each Graphite token under its own name.
  - `ag-theme.ts`: the AG Studio theme.
- The package's `exports` expose `./tokens.css`, `./tailwind.css` and `./ag-theme`.
- Each app's global CSS is `@import "tailwindcss"; @import "@countersign/graphite/tailwind.css";`.
- Graphite token names already follow Tailwind v4's namespaces (`--color-*`, `--text-*`, `--leading-*`, `--font-*`, `--font-weight-*`, `--tracking-*`, `--radius-*`, `--shadow-*`, `--ease-*`), so class names equal token names: `bg-container`, `text-secondary-foreground`, `shadow-border`, `rounded-2xl`, `text-body-sm`, `font-medium`.
- `tailwind.css` has this shape:
  ```css
  @import "./graphite-tokens.css"; /* unlayered: light on :root, dark on .dark / [data-theme=dark] */
  @custom-variant dark (&:where(.dark, .dark *, [data-theme=dark], [data-theme=dark] *));
  @theme {
    --color-*: initial; --font-*: initial; --text-*: initial; --font-weight-*: initial;
    --tracking-*: initial; --leading-*: initial; --radius-*: initial; --shadow-*: initial;
    --inset-shadow-*: initial; --drop-shadow-*: initial; --ease-*: initial;
  }
  @theme inline {
    --spacing: var(--space);
    --color-container: var(--color-container); /* one line per semantic token, same name */
    --text-body-sm: var(--text-body-sm); --text-body-sm--line-height: var(--leading-body-sm);
    --radius-2xl: var(--radius-2xl); --shadow-border: var(--shadow-border); --font-sans: var(--font-sans);
    /* ... */
  }
  ```
  With `inline`, each utility writes `var(--color-container)` straight into its rule, so values resolve at runtime and follow `.dark`. If Tailwind also emits its same-named theme variable, that declaration sits in `@layer theme` and loses to Graphite's unlayered declaration.
- The AG Studio theme:
  ```ts
  studioTheme.withParams({
    backgroundColor: 'var(--color-container)',
    foregroundColor: 'var(--color-primary-foreground)',
    accentColor: 'var(--color-brand-solid)',
    borderColor: 'var(--color-border-default)',
    fontFamily: 'var(--font-sans)',
    browserColorScheme: 'inherit',
  })
  ```
  Chart series colors come from `--ag-chart-palette-*` variables set to Radix step-9 variables (`var(--blue-9)`, `var(--green-9)`, ...). DESIGN.md allows step 9 for chart lines and dots because no semantic series token exists. Decision colors use the semantic positive, warning and danger tokens. The theme toggle sets `html.dark` and `data-ag-theme-mode` together.
- Load the fonts with the Google Fonts `<link>` from DESIGN.md, so the family names match `--font-sans`, `--font-mono` and `--font-serif`. Don't use `next/font`: it generates its own family names, which the tokens don't reference.
Basis:
- Brief §8: "Components use semantic tokens only, never raw hex or a palette step where a semantic token exists."
- Brief §9, Design system: "Apps import `graphite-tokens.css` rather than redefining values", with No opinion on "How the tokens file is shared across apps". The boilerplate already uses Tailwind ^4.
- Tailwind docs: the namespace table, `--color-*: initial` removes the default utilities, "`inline` ... the utility class will use the theme variable value", only used variables are emitted, and a theme can be shared from its own package: https://tailwindcss.com/docs/theme
- AG Grid color params accept "a CSS colour value, such as ... or variable expression 'var(--myColorVar)'": https://www.ag-grid.com/react-data-grid/theming-colors.md
- AG Studio uses the same theming API: `studioTheme`, `withParams`, `--ag-*` CSS variables, `data-ag-theme-mode`: https://www.ag-grid.com/studio/react/theming/
Consequences:
- Palette steps (`--gray-1`, ...) get no utilities, which enforces semantic-only styling.
- An unknown or default-palette class (`bg-blue-500`) silently produces no CSS. The Graphite scan test therefore also rejects default Tailwind palette class names and arbitrary color values (`[#...]`), along with raw hex and emojis. It skips `packages/graphite/graphite-tokens.css`.
- The first UI ticket includes a Playwright check that computed colors (for example the shell background) change between light and dark. That proves the mapping and the `.dark` switch work. Spike S9 confirms the AG Studio params, including `browserColorScheme`.
- Next apps list workspace packages in `transpilePackages`.
- CSS Modules are allowed only for what utilities can't express, such as keyframes, and still use `var(--token)`.
