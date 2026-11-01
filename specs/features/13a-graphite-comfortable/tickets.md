# Phase 13a tickets: Graphite at a comfortable density

Build from [design.md](design.md)'s Detailed Implementation Plan (it's binding on file names, exports, the recipe composition rule and each step's harness gate) and [requirements.md](requirements.md) (binding on values). Every ticket keeps the four Feedback commands passing. A ticket with a harness gate runs `npm run build` first, then its `npm run ui:shots` command with `UI_SHOTS_CHROMIUM` set as `.ralph/progress.md` says. `@playwright/test` 1.64.1 is already installed (commit f5a3569); no ticket installs it, and none runs `npx playwright install`.

## T-001: Harness fixtures the console can read

Status: done
Blocked by:
Tier: simple
Slice: Canned gate and Resolve answers for every screen the harness shoots, typed and parsed with the console's own schemas.
Test seam: `fixtures(now)` and `FIXTURE_IDS` from `tests/ui-shots/fixtures.ts`, through `tests/ui-shots/fixtures.test.ts`
Acceptance:
- [x] Every answer in design.md step 1a parses with the schema it names, for `fixtures(new Date())`
- [x] Every approval card expires in the future, and no thread is working
- [x] `FIXTURE_IDS` is `readableSeq` "41", `unreadableSeq` "7", a valid `tkt_` thread ID and `productId` "market-basket"
- [x] The photo decodes as a 160 by 120 PNG (signature, IHDR size); every sample email ends `@example.com`, and every shop, supplier or person name shown on its own carries "(illustrative)"
- [x] `npm test` runs the fixture test in the root `repo` project
Notes:
- Files: `tests/ui-shots/fixtures.ts`, `tests/ui-shots/fixtures.test.ts`, and `tests/ui-shots/tsconfig.json` plus the root `tsconfig.json` exclude (design.md step 2e, brought forward so this ticket typechecks). Add `tsc --noEmit -p tests/ui-shots/tsconfig.json` to the root `typecheck` script here.
- The view tests in `apps/console/test/` show valid shapes for every field.

## T-002: The harness runner: fake upstreams, both apps and 56 shots

Status: done
Blocked by: T-001
Tier: standard
Slice: `npm run ui:shots` starts the fake gate and Resolve, both built Next apps and Chromium, and writes a full-page PNG for every screen, theme and width with a report.
Test seam: `npm run ui:shots` (exit code, the printed summary, `test-results/ui-shots/report.json`)
Acceptance:
- [x] With both apps built, `npm run ui:shots` writes 56 PNGs named `<screen>-<theme>-<width>.png` for the 14 screens in design.md step 2c, and prints `ui-shots: 56 shots, <f> failures`
- [x] `--only`, `--checks`, `--theme` and `--width` narrow the run; an unknown screen or check name exits 2
- [x] Without a build it exits 2 with `ui-shots: run npm run build first`; with no usable Chromium it exits 2 with the message in design.md step 2c
- [x] The `theme` check runs: `html.dark` matches the theme, and each screen's body background differs between light and dark
- [x] The fake upstream logs `upstream: no fixture for <method> <path>` for any unserved path, and none is logged in a full run; signed-in screens show the approvals count badge
- [x] Both servers and the fakes stop on every exit path (no process left on ports 3100, 3101, 4511 or 4512)
Notes:
- Files: `tests/ui-shots/upstream.ts`, `tests/ui-shots/shoot.ts`, root `package.json` (`ui:shots` script only; `@playwright/test` is already there).
- design.md step 2f (`npx playwright install` in `scripts/cloud-setup.sh`) is dropped: this container has Chromium preinstalled, and runs never call `npx playwright install` (conductor, 1 Nov). Don't edit `scripts/cloud-setup.sh`.
- The density checks come in T-003. Here `densityChecks` may be a stub that returns no findings, but the `__name` init script, `scope` and `checks` plumbing go in now.
- Unblocked by `questions/answered/T-002-harness-not-on-allow-list.md`; the parked stash was applied and dropped.
- Checked on 1 Nov: the full run printed `ui-shots: 56 shots, 0 failures` with no `upstream:` line (`densityChecks` is still T-003's stub); `--only decisions,chat --theme dark --width phone` shot 2; the decisions shot shows the Approvals badge at 3; back-to-back runs bind 3100, 3101, 4511 and 4512 again, so nothing was left on them. `tests/ui-shots/upstream.test.ts` covers the 404 log, the 401 and the ports freeing; `shoot.test.ts` the flag exits. The no-build and no-Chromium exits were reviewed in code, not run: running them means deleting `.next` or an env prefix, which the loop's rules rule out.

## T-003: The density checks

Status: done
Blocked by: T-002
Tier: standard
Slice: Each shot is measured against DESIGN.md's density rules in the browser, and failures print as `FAIL <shot> <check>: <detail>`.
Test seam: `densityChecks(input)` from `tests/ui-shots/checks.ts`, run through `npm run ui:shots`
Acceptance:
- [x] Every check in design.md step 2b runs under its name (`table-header`, `table-rows`, `hit-target`, `small-text`, `cards`, `toolbar`, `shell`, `page`, `overflow`, `emoji`, `uppercase`), respecting `scope` and `--checks`
- [x] On today's unstyled screens a full run exits 1 and reports at least the known failures: `table-header` and `uppercase` on `decisions`, `hit-target` under 28px somewhere on the console, and `shell` (240px sidebar)
- [x] `risk-desk`'s element checks look only inside `[data-graphite="spike-header"]` (none until T-013 adds it), while `overflow` and `theme` run page-wide
- [x] `report.json` lists every finding per shot; the summary counts failures and not `note` lines
Notes:
- File: `tests/ui-shots/checks.ts` (and its call in `shoot.ts`, already wired in T-002, so `shoot.ts` is unchanged).
- Checked on 1 Nov: the full run printed `ui-shots: 56 shots, 766 failures` (table-header, table-rows, hit-target, shell, uppercase on the console; hit-target on `product`'s "Back to shop"); `risk-desk`, `chat` and `shop` have none. `--only decisions --theme light --width desktop --checks table-header,uppercase,shell` exited 1 with only those three checks. `cards`, `toolbar`, `page`, `small-text`, `emoji`, `overflow`, `scope` and `--checks` were each shown to fire on synthetic HTML in a throwaway Chromium Vitest file, deleted afterwards (no committed test needs a browser in `npm test`).

## T-004: Graphite class recipes and console primitives

Status: done
Blocked by:
Tier: standard
Slice: One module of Graphite class recipes and a set of React primitives that every console screen can build on.
Test seam: `apps/console/src/controls.ts`'s exports through `apps/console/test/controls.test.ts`; `ui.tsx`'s components by rendering through a page in later tickets
Acceptance:
- [x] `controls.test.ts` passes every assertion in design.md step 3d: sizes, icon boxes, heights at least 28px, no conflicting property group under one prefix, table height tokens, no uppercase or tertiary text, no imports
- [x] `packages/graphite/tailwind.css` registers `--breakpoint-wide: 900px`, and `design-check.test.ts` passes unchanged
- [x] `ui.tsx` exports `Page`, `PageHeader`, `Sections`, `Section`, `Card` and `CardHeading` with the types in design.md step 3c, and `Badge` and `Code` take the new sizes; it still has no server-only import
- [x] `npm run build` emits CSS for `wide:` and for `p-(--card-padding)`, `h-(--table-row-height)` and `w-(--sidebar-width)` (grep the built CSS)
Notes:
- Files: `packages/graphite/tailwind.css`, `apps/console/src/controls.ts`, `apps/console/app/ui.tsx`, `apps/console/test/controls.test.ts`. No harness gate.
- Built-CSS check: reading `.next` is refused in the loop, so the four utilities were checked by compiling `packages/graphite/tailwind.css` with `tailwindcss`'s `compile()` in a throwaway Vitest file (deleted): it emits the 900px `wide` query and `var(--card-padding)`, `var(--table-row-height)` and `var(--sidebar-width)`. `w-(--sidebar-width)` has no source use until T-005, so the real build only emits it after T-005.
- The conflict check splits inline padding by side (`px`/`pl`/`p` start, `px`/`pr`/`p` end), because leading-icon buttons use `pl-*` with `pr-*` by design.

## T-005: The shell, nav and theme control

Status: done
Blocked by: T-003, T-004
Tier: simple
Slice: Every console page sits in the comfortable shell: a 260px sidebar with 36px nav items, a 32px theme control and the inset container panel.
Test seam: `npm run ui:shots -- --checks shell,theme`
Acceptance:
- [x] `npm run ui:shots -- --checks shell,theme` prints `0 failures`
- [x] `console-setup.test.ts` passes unchanged (nav item literals, `<ThemeControl />`, `<ConsoleNav openApprovals={count} />`)
- [x] The theme control is built from `SEGMENTED` and `SEGMENT_ICON`, and the nav's count badge is 24px
Notes:
- Files: `apps/console/app/console-shell.tsx`, `console-nav.tsx`, `theme-control.tsx` (design.md step 4).

## T-006: Approvals and the shared sign-in

Status: done
Blocked by: T-005
Tier: simple
Slice: The phone approvals page and the sign-in every console page shares are rebuilt on the recipes, with 44px Approve, Deny and Sign in.
Test seam: `CONTROL_CLASSES` through `approvals-view.test.ts`; `npm run ui:shots -- --only approvals,approvals-signed-out`
Acceptance:
- [x] `approvals-view.test.ts` expects Approve and Deny at 44px, every control at least 28px, and allows `./controls`; it passes, and no other assertion in it changed
- [x] `npm run ui:shots -- --only approvals,approvals-signed-out` prints `0 failures`
- [x] `approvals-board.tsx` and `sign-in.tsx` define no `BUTTON`, `PRIMARY`, `SECONDARY` or `COLUMN`, and `SIGN_IN_COLUMN` is gone
Notes:
- Files: `apps/console/src/approvals-view.ts`, `apps/console/test/approvals-view.test.ts`, `apps/console/app/approvals/approvals-board.tsx`, `apps/console/app/sign-in.tsx`; check `approvals/page.tsx` (design.md step 5).

## T-007: The Decisions list

Status: done
Blocked by: T-005
Tier: simple
Slice: `/decisions` shows the chain card and a table card with a one-row toolbar, 44px headers and 56px rows.
Test seam: `npm run ui:shots -- --only decisions`
Acceptance:
- [x] `npm run ui:shots -- --only decisions` prints `0 failures`
- [x] `console-setup.test.ts` passes unchanged (the literal `overflow-x-auto` wrapper around the table)
- [x] `decisions/page.tsx` defines no `LINK`, `BUTTON`, `SECONDARY`, `HEAD`, `CELL` or `COLUMN`, and contains no `uppercase`
Notes:
- File: `apps/console/app/decisions/page.tsx` (design.md step 6). This is the first table card: later table tickets follow its shape.

## T-008: The Audit log and Disputes

Status: done
Blocked by: T-007
Tier: simple
Slice: `/audit` and `/disputes` follow the Decisions table card, with Draft again as a small secondary button.
Test seam: `npm run ui:shots -- --only audit,audit-check,disputes`
Acceptance:
- [x] `npm run ui:shots -- --only audit,audit-check,disputes` prints `0 failures`
- [x] `console-setup.test.ts` passes unchanged (table wrappers, `title={hash.full}`, the disputes sign-in and empty-state lines, `draft-again.tsx` still a client file with no server imports)
- [x] None of the three files defines local button, table or column constants, or contains `uppercase`
Notes:
- Files: `apps/console/app/audit/page.tsx`, `apps/console/app/disputes/page.tsx`, `apps/console/app/disputes/draft-again.tsx` (design.md step 7). Blocked by T-007 only for its table-card pattern.

## T-009: The decision page

Status: done
Blocked by: T-007
Tier: simple
Slice: `/decisions/[seq]` reads as sections 80px apart, with claims and trace in table cards that still stack at phone width.
Test seam: `npm run ui:shots -- --only decision,decision-unreadable`
Acceptance:
- [x] `npm run ui:shots -- --only decision,decision-unreadable` prints `0 failures`
- [x] `console-setup.test.ts` passes unchanged (`max-md:flex max-md:flex-col`, the table wrapper, the intent page's redirect, `copy-reply.tsx` without `@countersign/mandate`)
- [x] The three files define no local recipe constants and contain no `uppercase`
Notes:
- Files: `apps/console/app/decisions/[seq]/page.tsx`, `[seq]/copy-reply.tsx`, `decisions/intent/[id]/page.tsx` (design.md step 8).

## T-010: The inbox

Status: open
Blocked by: T-005
Tier: standard
Slice: `/inbox` has the comfortable header, a 360px thread list beside the thread, and a 28px-padded "Simulate a message" dialog.
Test seam: `npm run ui:shots -- --only inbox,inbox-thread`
Acceptance:
- [ ] `npm run ui:shots -- --only inbox,inbox-thread` prints `0 failures`
- [ ] `composer.test.ts`, `inbox-view.test.ts` and `console-setup.test.ts` pass unchanged
- [ ] `inbox-header.tsx` defines no `BUTTON`, `PRIMARY`, `SECONDARY` or `FIELD`; the dialog uses `TEXTAREA` and large footer buttons
Notes:
- Files: `apps/console/app/inbox/page.tsx`, `inbox-parts.tsx`, `inbox-header.tsx` (design.md step 9). Standard because the split pane loses its inner scroll and the dialog's bottom sheet must still work below 640px; the harness doesn't open the dialog, so open it once in a phone-width shot by hand and note the result here.

## T-011: The customer chat

Status: open
Blocked by: T-004, T-003
Tier: simple
Slice: `/chat` uses the 44px touch controls from the recipes on a full-bleed page.
Test seam: `CHAT_CONTROLS` through `chat.test.ts`; `npm run ui:shots -- --only chat`
Acceptance:
- [ ] `chat.test.ts` expects every control at least 28px and send at 44px (`size-11`); it passes, and no other assertion in it changed
- [ ] `npm run ui:shots -- --only chat` prints `0 failures`
- [ ] The simulation notice uses `secondary-foreground`, not tertiary
Notes:
- Files: `apps/console/src/chat.ts`, `apps/console/test/chat.test.ts`, `apps/console/app/chat/customer-chat.tsx` (design.md step 10).

## T-012: The storefront

Status: open
Blocked by: T-003
Tier: simple
Slice: The shop and product pages take the comfortable page padding, 24px product cards and the section-gap checkout.
Test seam: `npm run ui:shots -- --only shop,product`
Acceptance:
- [ ] `npm run ui:shots -- --only shop,product` prints `0 failures`
- [ ] The storefront's tests (`apps/storefront/test/`) pass unchanged
- [ ] `paypal-checkout.tsx`'s status card has 24px padding, `--radius-3xl` and a 24px badge (read by validation manual check 5, since no shot renders it)
Notes:
- Files: `apps/storefront/app/layout.tsx`, `page.tsx`, `products/[productId]/page.tsx`, `products/[productId]/paypal-checkout.tsx` (design.md step 11).

## T-013: The AG Studio theme and the spike page

Status: open
Blocked by: T-004, T-003
Tier: simple
Slice: AG Studio's grid and widgets take the comfortable sizes from token-checked numbers, and the spike page's header follows the type rules.
Test seam: `GRAPHITE_SIZES` through `packages/graphite/test/sizes.test.ts`; `npm run ui:shots -- --only risk-desk`
Acceptance:
- [ ] `sizes.test.ts` checks every key against the token table in design.md step 12c and passes
- [ ] `ag-theme.ts` reads its sizes from `GRAPHITE_SIZES`, and `npm run typecheck` passes; any param dropped under step 12b's rule is named in `.ralph/progress.md`
- [ ] `npm run ui:shots -- --only risk-desk` prints `0 failures`, with the header marked `data-graphite="spike-header"`
Notes:
- Files: `packages/graphite/src/sizes.ts`, `packages/graphite/src/ag-theme.ts`, `packages/graphite/test/sizes.test.ts`, `apps/console/app/spike/risk-desk/page.tsx`, `money-protected-widget.tsx` (design.md step 12).

## T-014: The brand book and the components index

Status: done
Blocked by:
Tier: simple
Slice: `brand-book.md` and `components/README.md` describe the comfortable system and DESIGN.md's authority.
Test seam: text searches in validation.md check 7
Acceptance:
- [x] Every item under requirements.md's `brand-book.md` and `components/README.md` headings is applied
- [x] Neither file contains `dense`, `13px interface`, `15px on`, `space-16` as the top step, `20 to 40px` or "table headers" next to uppercase
Notes:
- Files: `Graphite Design/brand-book.md`, `Graphite Design/components/README.md` (design.md step 13). Don't edit `DESIGN.md` or `graphite-tokens.css`.

## T-015: The component READMEs

Status: open
Blocked by:
Tier: simple
Slice: Each component's README gives the sizes DESIGN.md now specifies.
Test seam: text searches in validation.md check 7
Acceptance:
- [ ] Every item under requirements.md's "Component READMEs" is applied, in the 19 READMEs design.md step 13 lists
- [ ] No component README contains `dense`, `40px rows`, `uppercase caption header`, `13px medium` for buttons or labels, or the old heights `xs 20` and `xl 40`
Notes:
- Files: `Graphite Design/components/{Accordion,Avatar,Badge,Breadcrumb,Button,Card,Checkbox,CodeCard,Command,Dialog,Input,InputOTP,Kbd,Menu,Switch,Table,Tabs,Toast,Tooltip}/README.md`. Many files, but each edit is a line or two.

## T-016: `bundle.css` and the component previews

Status: open
Blocked by:
Tier: simple
Slice: The reference stylesheet and its previews render the comfortable sizes.
Test seam: text searches in validation.md check 7, and the design check's raw-hex rule applied to the diff
Acceptance:
- [ ] Every item under requirements.md's `components/bundle.css` and `components/*/preview.html` headings is applied, using `var(--menu-item-height)`, `var(--table-row-height)`, `var(--table-header-height)` and `var(--card-padding)` where named
- [ ] `.gr-kbd-sm`, `.gr-table td .gr-sub` and `.gr-command-footer` exist; `.gr-avatar-24` is renamed `.gr-avatar-28` in the CSS and in every preview
- [ ] The diff adds no raw hex colour, and no table header rule sets `text-transform: uppercase`
Notes:
- Files: `Graphite Design/components/bundle.css` and the `preview.html` files the search in design.md step 14 finds.

## T-017: `tokens.json`

Status: open
Blocked by:
Tier: simple
Slice: `tokens.json` matches `graphite-tokens.css` again and carries the layout tokens.
Test seam: `JSON.parse` of the file and the comparison in validation.md check 8
Acceptance:
- [ ] The file parses as JSON, keeps its one-space indent, and has a top-level `layout` group with the nine layout tokens
- [ ] Every type style, `space`, `space-*` and `control-*` value equals `graphite-tokens.css`'s light block
- [ ] No colour, radius, shadow, weight, tracking, duration or easing entry changes, and no usage string says "dense" or puts table headers in uppercase
Notes:
- File: `Graphite Design/tokens.json` (design.md step 15).

## T-018: The density pass

Status: open
Blocked by: T-006, T-008, T-009, T-010, T-011, T-012, T-013
Tier: simple
Slice: Every screen in both themes at both widths passes every density check.
Test seam: `npm run ui:shots`
Acceptance:
- [ ] `npm run ui:shots` prints `ui-shots: 56 shots, 0 failures`
- [ ] `grep -rnE "const (BUTTON|PRIMARY|SECONDARY|HEAD|CELL|COLUMN|FIELD) =" apps/console/app` finds nothing, and no file under `apps/console/app` contains `uppercase` or `tracking-caption-upper`
- [ ] The final summary line is in `.ralph/progress.md`
Notes:
- Fix failures in the file that causes them, with the recipes (design.md step 16). Any file from T-005 to T-013 may change.
