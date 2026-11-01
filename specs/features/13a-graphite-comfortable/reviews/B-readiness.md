# Readiness review B: phase 13a, detailed implementation plan

Reviewer: Implementation Readiness Goldfish (Mode: REVIEW), with the Codebase Details checks applied.
Target: `specs/features/13a-graphite-comfortable/design.md`, from `## Detailed Implementation Plan` (line 198) to the end. The feature range above it was read for context.
Standard: `.ralph/egm/standards/implementation-readiness-standard.md` (zero-decision rule, phasing, target scope, actionable steps, test plan).
Read: the linked documents (requirements.md, validation.md, ADR 0045), brief §8 and §10, CONTEXT.md, and the code paths the plan names.

Codebase check. These all exist and match the plan: `apps/console/app/{ui.tsx, console-shell.tsx, console-nav.tsx, theme-control.tsx, sign-in.tsx}`, `apps/console/src/{approvals-view.ts, chat.ts}` with `CONTROL_CLASSES`, `CHAT_CONTROLS` and the local `BUTTON`/`PRIMARY`/`SECONDARY`, every page file in steps 5 to 10, the three storefront pages plus `paypal-checkout.tsx`, `packages/graphite/{tailwind.css, src/ag-theme.ts, test/design-check.test.ts}`, all nine zod schemas the fixtures use, `.ralph/progress.md`, and every layout token in `graphite-tokens.css`.
Marked new and absent, as the plan says: `controls.ts`, `sizes.ts`, `tests/ui-shots/*`, and the `ui:shots` script.
`SIGN_IN_COLUMN` is imported by nothing else.
I also checked that the Tailwind utilities named in 3b exist: the `--spacing: var(--space)` arithmetic, `w-(--token)`, `max-w-3xl`/`2xl`/`md` from the unreset `--container-*`, `text-code-sm`, `leading-code-sm`, `font-semimedium` and `tracking-heading`.

---

## Findings

### 1. Blocker: the screen matrix doesn't add up, and the done criterion can't be met
**Affected Scope:** design.md lines 140, 263-266 (step 2c); the "Verification Plan" line 517; G-4. validation.md check 6 and manual check 1 repeat it.
**Discrepancy & Rationale:** Step 2c lists 12 console screens (`inbox`, `inbox-thread`, `approvals`, `approvals-signed-out`, `disputes`, `decisions`, `decision`, `decision-unreadable`, `audit`, `audit-check`, `chat`, `risk-desk`) and 2 storefront screens, which is 14. The plan then says "That's 14 screens; with `approvals-signed-out` counted, 15". But `approvals-signed-out` is already one of the 12. 14 × 2 themes × 2 widths is 56 shots, not 60. validation.md requires the harness to end with the exact line `ui-shots: 60 shots, 0 failures` and a manual review of "all 60 screenshots". As written, that line can never be printed. Either a 15th screen is missing or the number is wrong. The implementer would have to invent the 15th screen (for example `/decisions?decision=denied`, `/disputes` with a sign-in, or `/approvals` with no open cards), which is a design choice. Name the 15th screen with its path, or change 15 and 60 to 14 and 56 in design.md, validation.md and the G-4 text.

### 2. Blocker: the harness can't load Playwright, and the plan's "preinstalled globally" is neither checkable nor resolvable
**Affected Scope:** design.md lines 140, 261 (2c), 200 (every step from 3 on runs `npm run ui:shots`), 2d.
**Discrepancy & Rationale:** `shoot.ts` is to load Playwright with `createRequire(import.meta.url)("playwright")`, "preinstalled globally; not a dependency". Node's `require` resolves from `node_modules` directories up the tree from the file, plus `NODE_PATH`. It doesn't look in a global npm prefix. Playwright isn't in the repo's `node_modules` and isn't in the root `package.json` `devDependencies`. `specs/tech-stack.md` line 44 lists `@playwright/test 1.64.1 | root`, but `package.json` doesn't have it, so tech-stack and the manifest already disagree. I also found no global Playwright install in this environment. Nothing in the plan says how the global copy is found (`NODE_PATH=$(npm root -g)`, an absolute path, or `npm i -D`). Nothing says whether the Chromium binary is already downloaded or which executable path to launch. Every ticket from step 3 on is gated on running this harness, so the choice must be made in the plan: add `playwright` as a pinned root devDependency (and update tech-stack.md and the lockfile) or set `NODE_PATH` in the `ui:shots` script. Also state where the browser binary comes from.

### 3. Major: `tests/ui-shots/checks.ts` and `shoot.ts` use DOM APIs, but the root tsconfig has no DOM types
**Affected Scope:** step 2b, step 2c; root `tsconfig.json` (includes `tests`) and `tsconfig.base.json` (`lib: ["ES2024"]`, `types: ["node"]`).
**Discrepancy & Rationale:** The plan says these files are "typechecked by the root `tsconfig.json`". `densityChecks` is written to run inside the page and has to touch `document`, `getComputedStyle`, `innerWidth`, `HTMLElement`, `Element.getBoundingClientRect`, and `document.fonts.ready` in `shoot.ts`. With `lib: ["ES2024"]` none of these types exist, so `npm run typecheck` fails. The plan types only the Playwright calls with a local interface. It doesn't say whether to add `"DOM"` to the root `lib` (which would leak DOM globals into the Node-only gate and ledger tests), use `/// <reference lib="dom" />` in `checks.ts` only, give `tests/` its own tsconfig, or hand-write minimal interfaces. Pick one and write it in.

### 4. Major: a function serialised by `page.evaluate` and run through `tsx` picks up esbuild's `__name` helper
**Affected Scope:** step 2b ("must be self-contained ... because it runs in the browser"), step 2c (`tsx tests/ui-shots/shoot.ts`).
**Discrepancy & Rationale:** `tsx` compiles with esbuild and `keepNames`. Any named inner function, arrow assigned to a const, or class inside `densityChecks` is wrapped in `__name(...)`. `page.evaluate(fn)` sends `fn.toString()`, so the page throws `ReferenceError: __name is not defined`. The plan's only guard is "no closures over module scope", which doesn't cover this. The implementer has to find and choose a workaround: define the checks as a string, add an init script that defines `__name`, avoid inner named functions, or load the compiled function by source text. State the one to use.

### 5. Major: which screens carry the approver cookie isn't stated, though the plan promises it
**Affected Scope:** step 2c ("The screens (name, app, path, signed in)" and "For signed-in screens it adds the cookie").
**Discrepancy & Rationale:** The list gives name, app and path, but the "signed in" column never appears. Only `approvals-signed-out` is marked. From the code, `decisions`, `decision*`, `audit*`, `disputes` and `approvals` need the cookie. `inbox`, `inbox-thread`, `chat` and `risk-desk` don't call the gate for their own data. But `ConsoleShell` reads the cookie to show the open-card count on the Approvals nav item, so a cookie on `inbox` changes the sidebar (a 24px count badge appears). Whether inbox shots show the badge, and whether it's checked, is left to the implementer. The fake gate's `/approvals` must also answer for the shell on every console screen with a cookie. Add an explicit signed-in flag per screen.

### 6. Major: class composition and override rules are unspecified, and the stated overrides are unsafe in Tailwind
**Affected Scope:** step 3b (`button()` size table, icon-only and leading-icon columns), 3c (`Card` `className`), 5a (`${button(...)} flex-1`), 9b (Message `Card ... gap-3`), 10a, 11c.
**Discrepancy & Rationale:** The size table gives `h-11 gap-2 px-5 text-body-sm` for xl and `size-11 rounded-xl px-0` for xl icon-only. It doesn't say whether the icon-only classes replace or are appended to the base classes. If they're appended, the string holds `px-5 px-0`, `rounded-lg rounded-xl` and `h-11 size-11`. Tailwind v4 doesn't resolve conflicts by the order in the class attribute. It uses stylesheet order, which for the same property is by the utility's value, and there's no `tailwind-merge` in the repo. So `px-0` can lose to `px-5`, and `gap-3` can lose to `CARD`'s `gap-5` (9b says "Card variant=fill with gap-3"). That would break the chat send button's square shape and the 12px message gaps, and the harness would then report it late. State that `icon: "only"` returns a different class string (no `px-*`, no `rounded-lg`), that leading-icon replaces rather than adds `px-*` (or confirm that `pl-*` after `px-*` is safe), and that `Card` takes only non-conflicting additions or has gap, padding and radius props. Today's code only appends non-conflicting `pl-*`.

### 7. Major: the risk-desk shot can't reach "0 failures" from app files, and its setup is unspecified
**Affected Scope:** step 2c (`risk-desk` `/spike/risk-desk`), step 12d, step 16 ("fix every FAIL in the files that cause it"), validation check 6.
**Discrepancy & Rationale:** `risk-desk/page.tsx` passes `process.env.AG_STUDIO_LICENSE_KEY` to the Studio provider. The harness sets no such key, and brief §9 notes that AG Studio without a licence shows a watermark. The density checks (`hit-target`, `small-text`, `emoji`, `table-header`) then run over AG Studio's own DOM, which neither `ag-theme.ts` nor any app file controls. Findings in the watermark or in AG's icon buttons can't be fixed under step 16's rule, so `0 failures` can't be guaranteed. The plan needs to say whether the check scope for `risk-desk` is limited to the header, which checks are skipped for it, and what the harness does without a licence key or `GEMINI_API_KEY`.

### 8. Major: the per-step harness gate contradicts the ordering and numbering of steps
**Affected Scope:** line 200 ("From step 3 on, a step that restyles a screen ... fixes every failure the harness reports for them"), step 2 tail ("isn't expected to pass until step 15"), step 4, step 16.
**Discrepancy & Rationale:**
- Step 15 is `tokens.json`. The density pass is step 16, so "until step 15" is wrong.
- Step 4 changes the shell for every console screen, but the `page`, `cards`, `table-*` and `toolbar` checks for those screens can't pass until their own steps (5 to 9) land. Which screens and which checks gate step 4 is not stated.
- Steps 3, 11 and 12 touch screens only partly.

The rule "fix every failure for its screens" is therefore unexecutable as a ticket gate in steps 3 and 4. Give each step the exact `--only` list and the checks it must clear (for example, step 4: `shell` and `theme` on all console screens), or say the gate starts at step 5.

### 9. Nit: "the four test edits" doesn't match the list
**Affected Scope:** G-5 (line 31) and "Tests that change" (lines 202-209).
**Discrepancy & Rationale:** G-5 says "except the four test edits". The section lists four bullets, but two of them (`console-setup.test.ts`, `design-check.test.ts`) say they don't change. The real edits are in two files: three lines in `approvals-view.test.ts` and one assertion block in `chat.test.ts`. Reword it to "the edits to two test files, listed in 'Tests that change'".

### 10. Nit: fixture values the builder must invent
**Affected Scope:** step 1a, step 2a.
**Discrepancy & Rationale:**
- `FIXTURE_IDS.productId` is listed, but the valid IDs are the storefront's (`market-basket` and others in `apps/storefront/src/products.ts`), not upstream data. Say which one.
- `photo` is "a 160 by 120 PNG as a fixed base64 constant" with no bytes given, and the upstream must answer `Content-Type: image/png`. The console's attachment route returns 502 for any other type (`apps/console/src/resolve-routes.ts:136-139`). State the header.
- The gate fake's `before` query handling ("answers the same page") and the older-page cursors need the cursor shapes. These are in the schemas, so this is only a pointer.

### 11. Nit: literal ellipses and loose typings in 3b and 3c
**Affected Scope:** step 3b `ALERT`, step 3c `Page`, `Card`.
**Discrepancy & Rationale:**
- `ALERT` writes `"... bg-danger-subtle ... text-on-danger-subtle-foreground"`, with literal `...` inside the string. Write all four strings out.
- `Page({ width })` is described as `content|narrow` in the anatomy (line 119), but `PAGE_WIDTH` also has `form`, and 5d uses `width="form"`. Type it as `keyof typeof PAGE_WIDTH`.
- `Card`'s `as` union (`div`, `section`, `article`, others?) and the type of `...rest` aren't given.

### 12. Nit: AG Studio param names are unverified, and the sizes-test mapping is implicit
**Affected Scope:** steps 12a to 12c.
**Discrepancy & Rationale:**
- `gridHeaderHeight` and `gridCellHorizontalPadding` are new names. `ag-studio` isn't installed in this checkout, so I couldn't confirm either. The fallback ("drop the line and note it in `.ralph/progress.md`") is a documented decision, but it silently leaves the grid header off 44px, which G-2 and requirements.md ask for.
- `sizes.test.ts` has to map each `GRAPHITE_SIZES` key to its token. The mapping exists only as a comment order in 12a. Give the test an explicit key-to-token table.

### 13. Nit: validation check 5 and the harness `uppercase` note disagree
**Affected Scope:** step 2b (`uppercase`: "eyebrows may use it"), validation.md check 5 ("no file under `apps/console/app` contains `uppercase`").
**Discrepancy & Rationale:** If any file under `apps/console/app` may contain `uppercase` for an eyebrow, check 5 fails. If none may, the harness check is dead and manual check 1's "each one must be an eyebrow or a group heading" has nothing to read. The plan's steps remove every current use (six lines: decisions, `[seq]`, audit, disputes, `approvals-board.tsx:69`, and the stacked label). Pick one rule.

### 14. Nit: `Graphite Design/` files the plan leaves out
**Affected Scope:** steps 13 to 15; G-6.
**Discrepancy & Rationale:**
- Step 13 says the "`Cover` README" is unchanged, but `components/Cover/` has only `preview.html` and no README.
- Each `components/*/preview.html` renders the old sizes through `bundle.css` (22 hits for fixed px, `13px`, `40px`, `dense` and `uppercase` across six files). No step edits them and validation check 7 doesn't search them. G-6 says "`Graphite Design/` agrees with `DESIGN.md`", so list the previews as out of scope or add them.

### 15. Nit: harness runtime behaviour is unspecified
**Affected Scope:** step 2c.
**Discrepancy & Rationale:**
- The fonts load from Google (the plan itself says so in Alternative D). With no network the page loads fall back to system fonts, and `goto ... networkidle` can stall. Give a `goto` timeout and say what happens when fonts don't load.
- The approvals board polls every 3 seconds (`APPROVALS_POLL_INTERVAL_MS`). `networkidle` waits for 500ms of quiet, so a poll can land mid-shot. Say whether to block `/api/approvals` after first paint.

### 16. Nit: parts of the density checks are vacuous, and one parent gap is unstated
**Affected Scope:** steps 2b (`cards`), 9b (`Run`), 11b, 11d.
**Discrepancy & Rationale:**
- The `cards` check measures gaps between card siblings in one parent. Storefront product cards are each the only child of their own `li`, so the check never compares them. `Run` in 9b has two cards (the reply and "What Resolve did") with no stated parent or gap, so the builder has to choose one that is at least 24px.
- `paypal-checkout.tsx` (11d) is never rendered by the harness, because without PayPal env the product page shows only the not-set-up line. No step verifies 11d.

### 17. Nit: fixtures and brief §8's "illustrative" rule
**Affected Scope:** step 1a.
**Discrepancy & Rationale:** Brief §8 says every sample person and shop is labeled illustrative. Only the payee ("Kisumu Dye Works (illustrative)") is called out in 1a. The customer emails, sender names and shop name in the shots are also sample people. They're review evidence, not demo material, but 1a should say which names the fixtures use and that they match the existing `.example` / illustrative convention.

### 18. Nit: `controls.test.ts` doesn't say how it finds "every recipe"
**Affected Scope:** step 3d.
**Discrepancy & Rationale:** `controls.ts` exports functions, string constants, objects of strings and number maps (`ICON`). "Every recipe height is at least 28px" and "no recipe contains `uppercase`" need a rule for which exports to walk and how to read `h-(--table-header-height)`, `size-N` and `min-h-N`. Name the exports to iterate and the height regex.

---

## Summary

The architecture, the file list and the phasing are sound, and the code the plan names exists and matches. Test compatibility is mostly fine: `approvals-view.test.ts` reads integer `h-N`, and the planned `h-11` and `h-9` pass. `chat.test.ts` reads `size-N`, and `size-11` passes. The `console-setup.test.ts` literals are preserved by the plan.

The plan isn't ready to hand to an implementer. The harness, which gates every ticket from step 3 on, can't be built as written: its screen count is wrong, Playwright isn't resolvable, DOM types are missing, and a serialisation trap is unmentioned. Two further decisions (which screens are signed in, and how recipes compose without conflicting classes) are left to the implementer.

Counts: 2 Blockers, 6 Majors, 10 Nits.

NO-GO
