# Phase 13a: Graphite at a comfortable density

*   **Author:** autopilot planner (the Elephant, the planning role in [`.ralph/egm/PROCESS.md`](../../../.ralph/egm/PROCESS.md)), for the owner (muigufarid@gmail.com)
*   **Status:** Draft, readiness review resolved ([reviews/resolution.md](reviews/resolution.md))
*   **Date:** 2026-10-31, revised 2026-11-01

--------------------------------------------------------------------------------

## Overview

The owner asked on 31 Oct 2026: "I like the graphite design more, could we use it moving forward. You can do an overhaul of the front end design for what has already been done, basically revamp it to use the graphite design system." They then committed an updated [`Graphite Design/DESIGN.md`](../../../Graphite%20Design/DESIGN.md) and `graphite-tokens.css` (commits `ddd1d1f`, `ab98292`, `5be1c5f`). The update moves Graphite to a comfortable density: 14px UI text, 16px body, 32px default buttons, 36px inputs, 56px table rows, 24px card padding and grid gaps, 80px section gaps, an inset container panel with roomy padding, a 260px sidebar, and new layout tokens.

This phase restyles every UI built so far to that `DESIGN.md`: the console (every route, the shell, the nav, the theme control, the shared primitives, the approvals page and the customer chat), the storefront, and the AG Studio theme. It also brings the rest of `Graphite Design/` in line with `DESIGN.md`. Nothing about behaviour, routes or what the copy means changes.

The decision is the owner's and is recorded in [ADR 0045](../../../docs/adr/0045-graphite-at-comfortable-density-on-every-ui.md) (`Decided-by: owner`). Exact values per screen are in [requirements.md](requirements.md) and checks in [validation.md](validation.md). Where they differ, requirements.md wins on values and this document is binding on file names, exports and the order of work. Terms are in [CONTEXT.md](../../../CONTEXT.md).

## The Problem

The tokens already changed, so every `text-body-sm` and `text-caption-lg` on screen is one pixel larger today. Nothing else followed: buttons and inputs are still 24 to 40px (`h-6` to `h-10`), tables have 40px rows under 11px uppercase tertiary headers, cards have 16px padding, page columns are padded 20px by 24px, and the sidebar is 240px. Mixing new type sizes with old spacing is the worst of both: text grew but its room didn't. Every page also repeats its own copy of the button, table and column classes (`BUTTON`, `SECONDARY`, `HEAD`, `CELL`, `COLUMN` appear in five page files), so a change to the system means editing each page by hand.

The rest of `Graphite Design/` still describes the old system: `brand-book.md` says "dense" and "13px", the component READMEs and `components/bundle.css` use the old sizes, and `tokens.json` has the old type scale and none of the layout tokens.

The proposal: one shared set of Graphite class recipes and React primitives in the console, built from `DESIGN.md`'s component specs; every console page and the storefront rebuilt on the new values; the AG Studio theme sized from the tokens; the `Graphite Design/` companions corrected; and a screenshot harness that renders every route in light and dark at desktop and phone width and checks the density rules automatically.

## Goals

*   **G-1 Every screen follows `DESIGN.md`'s layout model and spacing.** The console's shell is a 260px sidebar on `shell` with an 8px-inset `container` panel (`--radius-2xl`, `--shadow-border`); pages are padded 48px top, 56px sides and 96px bottom (32, 16 and 64px below 900px) with content at most 1120px wide; cards take 24px padding and 24px gaps; sections sit 80px apart (56px below 900px). Measured: validation checks 4 and 6 (the harness's `shell`, `cards` and `page` checks) and manual check 1.
*   **G-2 Every component matches its `DESIGN.md` spec.** Buttons are 28 to 44px with the spec's padding; inputs 36px (32px in toolbars); table headers 44px, 13px medium, sentence case, `secondary-foreground`; table rows at least 56px with 14px text; badges 24px; the segmented control 32px; dialogs padded 28px. Measured: validation checks 2, 3 and 6.
*   **G-3 No screen shows a density sign.** No toolbar wraps to a second row at desktop width, no table text is under 14px, no cards sit closer than 24px, no text is under 12px, and no page scrolls sideways at 390px. Measured: validation check 6 and manual check 1.
*   **G-4 Light and dark both work on every screen.** Measured: validation check 6 (`theme`) and manual check 1 on all 56 screenshots.
*   **G-5 Nothing but the look changes.** Routes, behaviour, copy and every existing test pass unchanged, except the edits to two test files listed in "Tests that change". Measured: validation check 1.
*   **G-6 `Graphite Design/` agrees with `DESIGN.md`.** `brand-book.md`, the component READMEs, `components/bundle.css` and `tokens.json` carry the new values. Measured: validation checks 7 and 8.
*   **G-7 One place to change the system.** Every console page takes its buttons, inputs, tables, cards, badges and page layout from `apps/console/src/controls.ts` and `apps/console/app/ui.tsx`; no page file defines its own `BUTTON`, `SECONDARY`, `HEAD`, `CELL` or `COLUMN`. Measured: validation check 5.

## Non-Goals

*   **New UI.** No new screen, component, route or interaction. The sidebar icon rail (ADR 0018) stays unbuilt; it belongs to phase 16's layout work.
*   **Copy changes.** Words stay as they are. The one exception is case: column labels that were uppercased by CSS are already sentence case in the source, so dropping `uppercase` changes nothing in the text.
*   **Editing `DESIGN.md` or `graphite-tokens.css`.** They're the owner's. The package copy stays byte-identical.
*   **The Risk desk.** Phase 16 builds it. This phase only resizes the AG Studio theme and tidies the spike page's header.
*   **PayPal's checkout buttons.** They're PayPal's own component (brief §15) and keep PayPal's styling.
*   **Phase 13's new pages.** They're on another branch. Whichever of 13 and 13a merges second moves phase 13's pages onto the shared primitives (ADR 0045).
*   **A visual regression baseline.** The screenshots are evidence for this phase's review, not golden images that later tests compare against.

## Open Questions

None open. Decisions taken while drafting, all inside `DESIGN.md`'s "least visual weight" rule and none critical under PROCESS.md (the owner made the one decision that changes what users see):

*   **Extra-large button text.** `DESIGN.md` gives 15px, which has no type token. XL buttons use `body-sm` (14px), the nearest token, because CLAUDE.md requires token values.
*   **Table sub-lines.** `DESIGN.md` puts a cell's second line in `tertiary-foreground`. Brief §11 says tertiary text is never used for anything a user must read, and these sub-lines carry the claim, the dispute reason and the payee. They use `secondary-foreground` at 13px. The brief wins.
*   **Toolbars on a phone.** `DESIGN.md` says one row of toolbar controls and has no phone rule. At 390px the Decisions toolbar (a segmented filter and a search field) can't fit one row, so it wraps there. The one-row check applies from 768px up.
*   **The customer chat composer.** The chat is a touch layout. Its send and attach buttons are 44px (the touch size), and its message and email fields are 44px too, so the composer row lines up. Elsewhere inputs are 36px.
*   **Page title size.** Page titles stay at Heading 6 (20px, 600). Section and card titles move up to 16px semibold. Hierarchy comes from weight and space, as `DESIGN.md` asks, not from a bigger title.
*   **Table dividers.** Tables keep 1px `divide-y` dividers, which `DESIGN.md`'s Table spec names. Card and container edges stay rings (`shadow-border`).

## Critical User Journeys (CUJs)

### CUJ 1: The merchant reads decisions on a desktop

*   **Given**: the merchant is signed in with the approver key, on a 1440px-wide browser, in light theme, and the gate has recorded decisions.
*   **When**: they open `/decisions`, filter by "Denied", search, and open one decision.
*   **Then**: the sidebar is 260px with 36px nav items and the page sits in the inset container; the chain card, a one-row toolbar and the table read with 44px headers and 56px rows; the decision page's sections (claims vs records, how it decided, why, what happened, audit entry) are 80px apart. Every link, filter and export works as before.

### CUJ 2: The merchant approves on a phone, in dark mode

*   **Given**: a held $240 refund, the merchant's phone at 390px wide with the OS in dark mode.
*   **When**: they open `/approvals`, sign in, read the card and tap Approve.
*   **Then**: the page is dark from first paint; the key field is 36px and Sign in is 44px; the card has 24px padding, the claim block a 16px nested card, and Approve and Deny are 44px; nothing scrolls sideways. The approval executes exactly as before.

### CUJ 3: A shopper buys on the storefront

*   **Given**: the storefront at 390px and 1440px, light or dark.
*   **When**: they browse the product grid and open a product.
*   **Then**: product cards are 24px-padded, 24px apart, with a 16px semibold name and a 13px description; the product page's checkout section sits a section gap below the price. Checkout behaves as before.

### CUJ 4: A builder changes a button size once

*   **Given**: the shared recipes in `apps/console/src/controls.ts`.
*   **When**: a later phase changes the medium button recipe.
*   **Then**: every console page's medium buttons change with it, and no page file needs an edit.

## Technical Plan (Architecture)

### Where the values come from

```text
Graphite Design/graphite-tokens.css  (owner's; byte-identical copy in packages/graphite)
        │  CSS variables: --text-*, --control-*, --card-padding, --table-row-height, ...
        ▼
packages/graphite/tailwind.css       registers tokens as Tailwind utilities (ADR 0006),
        │                            plus the 900px `wide` breakpoint (new)
        ▼
apps/console/src/controls.ts (new)   Graphite class recipes: button(), INPUT, TH, TD,
        │                            CARD, TOOLBAR, SEGMENT, ... pure strings, no imports
        ├──► apps/console/src/approvals-view.ts   CONTROL_CLASSES built from recipes
        ├──► apps/console/src/chat.ts             CHAT_CONTROLS built from recipes
        ▼
apps/console/app/ui.tsx              React primitives: Page, PageHeader, Section, Card,
        │                            Badge, Code, Spinner, Working, Notice
        ▼
every console page and client component
```

The storefront is four small files with no shared console code; it takes the same values inline. `packages/graphite/src/ag-theme.ts` takes its pixel numbers from a new `packages/graphite/src/sizes.ts`, which a test checks against the token file.

### Why recipes live in `src/controls.ts`, not in `ui.tsx`

Two view modules already export class strings that their tests measure: `CONTROL_CLASSES` in `apps/console/src/approvals-view.ts` (Approve and Deny heights) and `CHAT_CONTROLS` in `apps/console/src/chat.ts`. `approvals-view.ts` must stay free of `app/` and server-only imports (its test lists the imports it may have). A recipe module in `src/` with no imports can be used by those view modules, by `ui.tsx` and by client components alike. Tailwind scans all of `apps/console`, so classes written in `src/` are generated.

### Layout values in Tailwind

Graphite's layout tokens are used through Tailwind v4's CSS-variable shorthand, which needs no registration and writes `var(--token)` into the rule: `w-(--sidebar-width)`, `h-(--nav-item-height)`, `max-w-(--content-max)`, `gap-(--grid-gap)`, `gap-(--section-gap)`, `p-(--card-padding)`, `h-(--table-row-height)`, `h-(--table-header-height)`. Fixed steps that equal a spacing step (`h-14` is 56px, `p-6` is 24px) are also fine, because `--spacing` is `--space` (4px). Recipes prefer the named token where one exists, so a token change moves the UI. The 900px threshold that `DESIGN.md` uses for container padding and section gaps becomes a Tailwind breakpoint, `--breakpoint-wide: 900px`, registered in `packages/graphite/tailwind.css` (`wide:` variant). Media queries can't read CSS variables, so it's the one literal.

### Page anatomy

```text
<ConsoleShell>                          aside w-(--sidebar-width) on shell │ main: m-2, rounded-2xl,
                                        bg-container, shadow-border, md:ml-0
  <Page width="content|narrow|form">       padding 32/16/64 → wide: 48/56/96; inner max-w
    <PageHeader title description actions/>   title + description 8px apart; 28px below
    <div gap-14 wide:gap-(--section-gap)>      page sections
      <Section title description>       heading block 8px apart; 28px to content
        <Card>…</Card>                  p-(--card-padding), rounded-3xl, ring; 24px between cards
        <div data-graphite="table">     table card: optional one-row toolbar, then
          <div overflow-x-auto><table>  44px header row, ≥56px body rows
```

List pages (Decisions, Audit log, Disputes) have one content section: a stack of cards 24px apart under the header. The decision page, the approvals page and the inbox thread have several sections. The customer chat (`/chat`) and the storefront are full-bleed `page` screens with no shell.

### The screenshot harness

```text
npm run build                         (both Next apps)
npm run ui:shots
  tests/ui-shots/shoot.ts
    ├─ starts tests/ui-shots/upstream.ts   fake gate on :4511, fake Resolve on :4512,
    │                                      serving tests/ui-shots/fixtures.ts
    ├─ next start apps/console    :3100    GATE_URL / RESOLVE_AGENT_URL → the fakes
    ├─ next start apps/storefront :3101    no PayPal env (shows its not-set-up line)
    └─ Chromium (@playwright/test, root devDependency): 14 screens × light/dark × 1440px/390px = 56 shots
         → test-results/ui-shots/*.png, report.json; density checks (checks.ts);
           exit 1 on any failure
```

The fixtures are typed with the console's own zod input types and parsed by a Vitest test, so they can't drift from what the console reads. The harness needs no credential and no live service. It runs outside the Feedback commands, because it needs a build and a browser.

## Alternatives Considered

### Alternative A: A shared React component library in `packages/graphite`

*   **Pros**: one set of components for the console and the storefront.
*   **Cons**: the storefront uses a handful of classes; a package of React components needs its own Tailwind `@source`, its own React peer dependency and a build story. `approvals-view.ts` and `chat.ts` need plain strings, not components.
*   **Reason for Rejection**: more moving parts than the problem needs. The console's recipe module plus `ui.tsx` covers 95% of the UI; the storefront's four files take the values inline.

### Alternative B: Restyle page by page with no shared recipes

*   **Pros**: smallest diff per ticket; each page can be tuned.
*   **Cons**: five copies of the button and table classes stay; the next density change is another full pass. The owner asked to prefer shared primitives.
*   **Reason for Rejection**: fails G-7.

### Alternative C: Named Tailwind utilities for every layout token (`p-card`, `h-row`)

*   **Pros**: shorter class names.
*   **Cons**: it relies on Tailwind resolving `--spacing-<name>` keys for every spacing utility, which this repo hasn't used or tested, and an unknown class silently produces no CSS (ADR 0006).
*   **Reason for Rejection**: the shorthand `p-(--card-padding)` is documented Tailwind v4 syntax, always emits, and keeps the token name visible.

### Alternative D: Commit the screenshots as golden images

*   **Pros**: later phases would catch visual drift.
*   **Cons**: 56 PNGs per run in git; fonts load from Google, so pixel diffs flake; timestamps in fixtures move.
*   **Reason for Rejection**: the shots are review evidence for this phase. The automated density checks carry forward instead.

--------------------------------------------------------------------------------

## Non-Functional Requirements

*   **Accessibility (brief §11).** Every control is at least 28px; Approve, Deny and Sign in on the approvals page are 44px; focus rings stay 1px `brand-border-focus` (solid buttons with a 2px offset, inputs inset); tertiary text only for timestamps, placeholders and hints; reduced-motion and `prefers-contrast` behaviour untouched. Hover styles stay inside Tailwind's `hover:` variant, which v4 already wraps in `@media (hover: hover)`.
*   **Security.** No change to what reaches the browser. The harness's fake upstream and fake approver key live only in `tests/ui-shots/` and never in app code.
*   **Rollout and rollback.** Pure restyle, one branch. Rolling back is reverting the merge. No data, route or API changes.

--------------------------------------------------------------------------------

### Additional Resources

*   [`Graphite Design/DESIGN.md`](../../../Graphite%20Design/DESIGN.md): the authority (ADR 0045).
*   [ADR 0006](../../../docs/adr/0006-styling-tailwind-v4-graphite-package-ag-theme.md): Tailwind v4 limited to Graphite tokens; the AG Studio theme.
*   [ADR 0018](../../../docs/adr/0018-console-panels-sidebar-rail-risk-desk-dashboard-first.md): console panels and sidebar (its 240px width is superseded by ADR 0045).
*   [ADR 0032](../../../docs/adr/0032-step-up-approvals-approver-key-and-approval-entries.md) and [ADR 0034](../../../docs/adr/0034-claims-vs-records-audit-api-and-evidence-export.md): the approvals page and the audit console being restyled.
*   Tailwind v4 CSS-variable shorthand: https://tailwindcss.com/docs/padding ("Using a custom value": `p-(<custom-property>)`); breakpoints: https://tailwindcss.com/docs/responsive-design ("Customizing your theme": `--breakpoint-*`).

### Future Improvements

*   **A visual regression job.** Once phase 13 hosts the demo, phase 19's smoke test could run the harness's density checks against the hosted URL.
*   **Sharing recipes with the storefront.** If the storefront grows past a few screens, move `controls.ts` into `packages/graphite` with an `@source` line.

--------------------------------------------------------------------------------

## Detailed Implementation Plan

Steps are in build order. Each step is one ticket unless it says otherwise. Every step keeps `npm run typecheck`, `npm run lint`, `npm test` and `npm run build` passing.

**The harness gate per step.** After `npm run build`, each step below runs exactly this and fixes every `FAIL` line before it's done. Steps 1 to 3 and 13 to 15 have no harness gate.

| Step | Command | Must print |
|---|---|---|
| 4 | `npm run ui:shots -- --checks shell,theme` (every console screen with `shell` true) | `0 failures` |
| 5 | `npm run ui:shots -- --only approvals,approvals-signed-out` | `0 failures` |
| 6 | `npm run ui:shots -- --only decisions` | `0 failures` |
| 7 | `npm run ui:shots -- --only audit,audit-check,disputes` | `0 failures` |
| 8 | `npm run ui:shots -- --only decision,decision-unreadable` | `0 failures` |
| 9 | `npm run ui:shots -- --only inbox,inbox-thread` | `0 failures` |
| 10 | `npm run ui:shots -- --only chat` | `0 failures` |
| 11 | `npm run ui:shots -- --only shop,product` | `0 failures` |
| 12 | `npm run ui:shots -- --only risk-desk` | `0 failures` |
| 16 | `npm run ui:shots` | `ui-shots: 56 shots, 0 failures` |

**How recipes compose.** Tailwind v4 doesn't let a later class in the attribute beat an earlier one; same-property utilities resolve by stylesheet order, and the repo has no `tailwind-merge`. So every recipe function builds its string from parts and never emits two classes for one property, and callers append only classes for properties the recipe doesn't set (layout such as `flex-1`, `w-full`, `self-start`, `ml-auto`, `md:hidden`, and chat's `FOCUS`). `apps/console/test/controls.test.ts` enforces the first half (step 3d). Where a primitive needs a different gap, padding or radius, it takes a prop, not a `className`.

### Tests that change

Only these existing tests change, all because a pinned size changes under ADR 0045:

*   `apps/console/test/approvals-view.test.ts`, "controls": Approve and Deny 44px (`h-11`) instead of 40px; every other control at least 28px instead of 24px; the allowed-imports list for `approvals-view.ts` gains `./controls`.
*   `apps/console/test/chat.test.ts`, "gives every control a hit target...": the floor becomes 28px and the send button 44px (`size-11`).
*   `apps/console/test/console-setup.test.ts` doesn't change: every page keeps a literal `className="overflow-x-auto..."` element directly around its `<table`, the `max-md:flex max-md:flex-col` stacking on the decision page, `title={hash.full}` on the audit log, `<ThemeControl />` and `<ConsoleNav openApprovals={count} />` in the shell, and the nav's item literals.
*   `packages/graphite/test/design-check.test.ts` doesn't change and must keep passing.

### Target Files to Create/Modify

#### Step 1. Harness fixtures

##### 1a. `tests/ui-shots/fixtures.ts` (Create)

*   **Type / Scope**: TypeScript module, typechecked by `tests/ui-shots/tsconfig.json` (step 2e).
*   **Proposed Changes**: Exports `type Fixtures` and `function fixtures(now: Date): Fixtures`, the canned upstream answers the console reads, each typed with the zod *input* type of the schema the console parses it with (`z.input<typeof ApprovalsViewSchema>` and so on, imported by relative path from `apps/console/src/approval-schemas.ts`, `audit-schemas.ts` and `resolve-schemas.ts`). Timestamps are relative to `now` (a card expiring in 12 minutes, decisions from 3 minutes to 2 days ago). Exports the IDs the shots visit: `FIXTURE_IDS = { readableSeq: "41", unreadableSeq: "7", threadId, productId: "market-basket" }` (`threadId` any valid `tkt_` ID; `market-basket` is a storefront product in `apps/storefront/src/products.ts`, not upstream data). Sample people follow the repo's convention (brief §8): every email is `@example.com`, every shop, supplier or person name shown on its own carries "(illustrative)", and the shop is Kikapu Studio as the seed names it. Contents:
    *   `approvals`: `ApprovalsViewSchema` with 3 open cards: the $240 damaged-basket refund step-up (photo, claim, excerpt, 3 claim pairs including one "doesn't match", 2 reasons), a dispute evidence card (2 documents, one with a download and one with a problem; 1 evidence item with tracking), and a $45.00 payout to "Kisumu Dye Works (illustrative)" for `KDW-2026-0412`; and 3 recent lines (approved, denied, expired).
    *   `decisions`: `DecisionRowsPageSchema` with 8 readable rows (allow, step-up and deny; refund, invoice, payout; one with no ticket) and 1 unreadable row, plus an older-page cursor.
    *   `decision[readableSeq]`: a readable `DecisionDetailSchema` for the attack email's denied refund: 3 claim pairs, 4 trace entries, 2 why items, a suggested reply, 3 "what happened" lines, the entry and 2 exports. `decision[unreadableSeq]`: the unreadable form with a raw payload.
    *   `intent`: `IntentDecisionSchema` pointing at `readableSeq`.
    *   `entries`: `EntryPageSchema` with 12 entries of mixed types and an older cursor. `verify`: an intact `ChainVerdictSchema`.
    *   `threads`: `ThreadListSchema` with 4 threads (email and chat; resolved, held, denied and baseline statuses; none working, so no page polls). `thread[threadId]`: a `ThreadDetailSchema` with the customer's email (one photo), Resolve's run (3 tool rows: a read, a held refund with reasons, a denied refund) and the reply.
    *   `disputes`: `DisputeListSchema` with 2 drafts, one drafted and one failed (so "Draft again" shows).
    *   `photo`: a 160 by 120 single-colour PNG as a `Uint8Array`, built once by a small `png(width, height, gray)` helper in this file with `node:zlib`'s `deflateSync` and `crc32` (IHDR 8-bit grayscale, one IDAT, IEND). The fake serves it for every attachment ID with `Content-Type: image/png`; the console's attachment route answers 502 for any other type (`apps/console/src/resolve-routes.ts`).
    *   Cursors: the older-page cursors (`before`) take the shapes their schemas define; the builder copies them from the schemas.
    *   The builder reads each schema and the view tests in `apps/console/test/` (`approvals-view.test.ts`, `decisions-view.test.ts`, `decision-view.test.ts`, `audit-view.test.ts`, `inbox-view.test.ts`, `disputes-view.test.ts`, `payouts-view.test.ts`) for valid shapes; the tests' builders show every field.

##### 1b. `tests/ui-shots/fixtures.test.ts` (Create)

*   **Type / Scope**: Vitest, in the root `repo` project (`tests/**/*.test.ts`), so it's part of `npm test`.
*   **Proposed Changes**: For `fixtures(new Date())`, parses every answer with the schema the console uses (`ApprovalsViewSchema`, `DecisionRowsPageSchema`, `DecisionDetailSchema` for both seqs, `IntentDecisionSchema`, `EntryPageSchema`, `ChainVerdictSchema`, `ThreadListSchema`, `ThreadDetailSchema`, `DisputeListSchema`) and expects success; checks every card's expiry is in the future, and that no fixture thread is working.

#### Step 2. Harness runner

##### 2a. `tests/ui-shots/upstream.ts` (Create)

*   **Type / Scope**: Node `node:http` servers.
*   **Proposed Changes**: `export async function startUpstream(fx: Fixtures): Promise<{ gateUrl: string; resolveUrl: string; close(): Promise<void> }>`. The gate fake listens on `127.0.0.1:4511` and the Resolve fake on `:4512`. Each GET path the console calls answers its fixture as JSON (200). The builder takes the exact paths and auth headers from `apps/console/src/approval-routes.ts`, `audit-routes.ts`, `dispute-routes.ts` and `resolve-routes.ts` (at least gate `/approvals`, `/audit/decisions`, `/audit/decisions/:seq`, `/audit/intents/:id`, `/audit/entries`, `/audit/verify`; Resolve `/threads`, `/threads/:id`, `/disputes`, `/attachments/:id`), including any key check `dispute-routes.ts` makes with the gate. Gate `/approvals` also answers the shell's open-card count, which `ConsoleShell` reads on every signed-in console screen, so those screens show the 3-card badge on the Approvals nav item. Query strings are ignored except `before` (answers the same page). A gate request without `Authorization: Bearer <the harness key>` answers 401. Any other path answers 404 `{ "message": "Not in the ui-shots fixtures." }` and is logged to stderr as `upstream: no fixture for <method> <path>`.

##### 2b. `tests/ui-shots/checks.ts` (Create)

*   **Type / Scope**: TypeScript with DOM types (from `tests/ui-shots/tsconfig.json`); one function serialized into the page with Playwright's `page.evaluate`.
*   **Proposed Changes**: `export function densityChecks(input: { width: number; shell: boolean; phonePrimary: string[]; scope: string | null; checks: string[] | null }): Finding[]`, where `type Finding = { check: string; detail: string }`. It must be self-contained (no closures over module scope) because it runs in the browser. `tsx` compiles with esbuild's `keepNames`, which wraps named inner functions in `__name(...)`; the page has no `__name`, so `shoot.ts` adds the init script `globalThis.__name = (fn) => fn;` to every browser context before any page loads (2c). `scope`, when set, is a CSS selector: element-level checks look only inside the matching elements (`overflow`, `theme` and `shell` stay page-wide). `checks`, when set, runs only the named checks. Visible means rendered with a non-zero box and not inside `.sr-only`. Checks, named as in validation.md:
    *   `table-header`: each visible `thead th` with `display: table-cell` is 44px tall (±1), 13px, weight 500, `text-transform: none`.
    *   `table-rows`: each visible `tbody tr` with `display: table-row` is at least 56px tall; each such `td` is at least 14px.
    *   `hit-target`: each visible `button`, `input` (not hidden), `select`, `textarea` and each `a` whose computed `display` is `flex` or `inline-flex` is at least 28px tall; each visible button whose text is one of `phonePrimary` is at least 44px tall.
    *   `small-text`: no visible element with its own non-whitespace text node is under 12px.
    *   `cards`: each visible `[data-graphite="card"]` has padding of at least 24px on every side, each `[data-graphite="card-nested"]` at least 16px, and any two visible cards that are siblings in one parent, or are each the only element child of sibling parents (grid items such as the storefront's `li`s), are at least 24px apart (rect gap, either axis).
    *   `toolbar`: from 768px up, every direct child of each visible `[data-graphite="toolbar"]` has the same `top` within 4px.
    *   `shell` (only when `shell`): from 768px up, `aside` is 260px wide, each `nav[aria-label="Console"] a` is 36px tall, and `main` has 8px from the viewport's top and right edges and a 12px border radius; below 768px, `main`'s left and right edges are 8px from the viewport.
    *   `page`: from 900px up, each `[data-graphite="page"]` has 48px top and 56px side padding; below 900px, 32px and 16px.
    *   `overflow`: `document.documentElement.scrollWidth` is at most `innerWidth`.
    *   `emoji`: `document.body.innerText` has no `\p{Extended_Pictographic}`.
    *   `uppercase`: no visible element has `text-transform: uppercase`. No screen in this repo has an eyebrow or a menu group heading, so this is a failing check, matching validation check 5.

##### 2c. `tests/ui-shots/shoot.ts` (Create)

*   **Type / Scope**: Node script run with `tsx`.
*   **Proposed Changes**:
    *   Imports `{ chromium }` from `@playwright/test` (a pinned root devDependency, 2d; it ships its own types). It launches `chromium.launch({ executablePath: process.env.UI_SHOTS_CHROMIUM })` when `UI_SHOTS_CHROMIUM` is set (a Chromium already on the machine), otherwise Playwright's own downloaded Chromium. If launch fails because no browser executable exists, it exits 2 with `ui-shots: no Chromium. Run npx playwright install chromium, or set UI_SHOTS_CHROMIUM.`
    *   Every browser context gets the init script `globalThis.__name = (fn) => fn;` (see 2b) before its first page.
    *   Starts the upstream fakes, then `next start -p 3100` in `apps/console` (env: `GATE_URL`, `RESOLVE_AGENT_URL` set to the fakes, `NODE_ENV=production`, plus `PATH`/`HOME`) and `next start -p 3101` in `apps/storefront` (no PayPal variables), each with `spawn("npx", ["next", "start", ...])`, and waits up to 60 seconds for each to answer HTTP. If `.next` is missing in either app it exits 2 with `ui-shots: run npm run build first`.
    *   The 14 screens, as a typed table in this file (`name`, `app`, `path`, `signedIn`, `shell`, `scope`):

        | Name | App | Path | Signed in | Shell | Scope |
        |---|---|---|---|---|---|
        | `inbox` | console | `/inbox` | yes | yes | none |
        | `inbox-thread` | console | `/inbox?thread=<threadId>` | yes | yes | none |
        | `approvals` | console | `/approvals` | yes | yes | none |
        | `approvals-signed-out` | console | `/approvals` | no | yes | none |
        | `disputes` | console | `/disputes` | yes | yes | none |
        | `decisions` | console | `/decisions` | yes | yes | none |
        | `decision` | console | `/decisions/<readableSeq>` | yes | yes | none |
        | `decision-unreadable` | console | `/decisions/<unreadableSeq>` | yes | yes | none |
        | `audit` | console | `/audit` | yes | yes | none |
        | `audit-check` | console | `/audit?check=1` | yes | yes | none |
        | `chat` | console | `/chat` | no | no | none |
        | `risk-desk` | console | `/spike/risk-desk` | no | no | `[data-graphite="spike-header"]` |
        | `shop` | storefront | `/` | no | no | none |
        | `product` | storefront | `/products/market-basket` | no | no | none |

        14 screens × 2 themes × 2 widths = 56 shots. (`/` redirects to `/decisions`, and `/decisions/intent/<id>` redirects to the decision page; both are covered by those shots.)
    *   `risk-desk` runs with no `AG_STUDIO_LICENSE_KEY` and no `GEMINI_API_KEY`, so Studio shows its watermark and the analyst is off. Its element checks are scoped to the page's own header, because AG Studio's DOM (watermark, its icon buttons) isn't ours to fix; `overflow` and `theme` still run page-wide. The shot is still taken as evidence of the Graphite theme.
    *   For each theme (`light`, `dark`) and width (`desktop` 1440 by 900; `phone` 390 by 844 with `isMobile` and `hasTouch`), a fresh browser context with `colorScheme` set to the theme. For signed-in screens it adds the cookie `countersign_approver` = the harness key (`ui-shots-` followed by 40 `k`s) for `127.0.0.1:3100`, HttpOnly, path `/`.
    *   Each shot: `goto` with `waitUntil: "load"` and a 30-second timeout (a timeout is a `load` failure for that shot, and the run continues); then `waitForLoadState("networkidle", { timeout: 5000 })`, ignoring its timeout (the approvals board polls every 3 seconds, so it may never go idle); then `document.fonts.ready` raced against 5 seconds. If the fonts don't load (no network to Google Fonts), it prints `note <shot> fonts: fallback fonts` and carries on; that note isn't a failure. Polling isn't blocked: a refresh lands on the same fixture data, so the shot is the same. Then it checks `html.dark` matches the theme (`theme` finding otherwise), runs `densityChecks` with the screen's `shell` and `scope`, `phonePrimary` `["Approve", "Deny", "Sign in"]` on the two approvals screens (`[]` elsewhere) and the `--checks` list, and saves a full-page PNG to `test-results/ui-shots/<screen>-<theme>-<width>.png`.
    *   After all shots, checks that each screen's `body` background colour differs between light and dark (`theme` finding otherwise).
    *   Writes `test-results/ui-shots/report.json` (`{ shots: [{ name, file, findings }] }`), prints `FAIL <shot> <check>: <detail>` per finding and the `note` lines, then `ui-shots: <n> shots, <f> failures`, and exits 1 if any finding failed. It stops both servers and the fakes on every exit path.
    *   Flags: `--only <name,name>` shoots only those screens; `--checks <name,name>` runs only those checks (with no `--only`, `--checks shell,theme` shoots only the screens whose `shell` is yes); `--theme light|dark` and `--width desktop|phone` narrow the matrix. An unknown screen or check name exits 2.

##### 2d. `package.json` and `package-lock.json` (Modify)

*   **Type / Scope**: root manifest.
*   **Proposed Changes**: add `"ui:shots": "tsx tests/ui-shots/shoot.ts"`; add `@playwright/test` as an exact root devDependency at the version `specs/tech-stack.md` already pins (1.64.1; the ticket step checks it exists and is at least two weeks old, as AUTOPILOT requires) with `npm install --save-exact --save-dev @playwright/test@1.64.1`, which also fixes tech-stack and the manifest disagreeing. The root `typecheck` script gains `tsc --noEmit -p tests/ui-shots/tsconfig.json` after the root project.

##### 2e. `tests/ui-shots/tsconfig.json` (Create) and `tsconfig.json` (Modify)

*   **Type / Scope**: TypeScript projects.
*   **Proposed Changes**: `tests/ui-shots/tsconfig.json` extends `../../tsconfig.base.json` with `"lib": ["ES2024", "DOM", "DOM.Iterable"]` and `"include": ["./**/*.ts"]`. The root `tsconfig.json` adds `"exclude": ["tests/ui-shots"]`, so DOM globals never reach the Node-only tests.

##### 2f. `scripts/cloud-setup.sh` (Modify)

*   **Type / Scope**: cloud session setup.
*   **Proposed Changes**: after dependencies install, run `npx playwright install chromium` (idempotent; it downloads only when the browser is missing), so a fresh cloud session can run the harness. Skipped when `UI_SHOTS_CHROMIUM` is set.

Steps 1 and 2 are tickets 1 and 2. At the end of step 2 the harness runs and reports today's density failures; it isn't expected to pass in full until step 16.

#### Step 3. Recipes and primitives

##### 3a. `packages/graphite/tailwind.css` (Modify)

*   **Type / Scope**: Tailwind v4 theme.
*   **Proposed Changes**: add a second, non-inline block after the existing `@theme` reset: `@theme { --breakpoint-wide: 900px; }`, with a comment that it's `DESIGN.md`'s 900px threshold for container padding and section gaps, and that media queries can't read variables. Add a comment above `@theme inline` listing the layout tokens and that they're used through the `(--token)` shorthand. Nothing else changes; every existing line stays (the design check reads them).

##### 3b. `apps/console/src/controls.ts` (Create)

*   **Type / Scope**: TypeScript module of class strings; no imports.
*   **Proposed Changes**: exports, each with a one-line comment naming its `DESIGN.md` spec:
    *   `type ButtonSize = "sm" | "md" | "lg" | "xl"` and `type ButtonVariant = "primary" | "secondary" | "tertiary" | "transparent" | "danger-subtle"`.
    *   `function button(variant: ButtonVariant, size: ButtonSize = "md", options: { icon?: "leading" | "only" } = {}): string`. It joins, with single spaces, exactly one class from each part below, so no property appears twice: the base, the box (by `icon`), the gap, the text and the variant. Base: `inline-flex shrink-0 items-center justify-center whitespace-nowrap font-medium motion-safe:transition motion-safe:duration-200 motion-safe:ease-out motion-safe:active:scale-[0.97] disabled:cursor-not-allowed`. Parts by size:

        | Size | Box, no icon | Box, `icon: "leading"` | Box, `icon: "only"` | Gap | Text |
        |---|---|---|---|---|---|
        | sm | `h-7 px-2.5 rounded-lg` | `h-7 pr-2.5 pl-2 rounded-lg` | `size-7 rounded-lg` | `gap-1.5` | `text-caption-lg` |
        | md | `h-8 px-3.5 rounded-lg` | `h-8 pr-3.5 pl-2.5 rounded-lg` | `size-8 rounded-lg` | `gap-1.5` | `text-body-sm` |
        | lg | `h-9 px-4 rounded-lg` | `h-9 pr-4 pl-3 rounded-lg` | `size-9 rounded-lg` | `gap-1.5` | `text-body-sm` |
        | xl | `h-11 px-5 rounded-lg` | `h-11 pr-5 pl-4 rounded-lg` | `size-11 rounded-xl` | `gap-2` | `text-body-sm` |

        (28, 32, 36 and 44px tall; 10, 14, 16 and 20px side padding; leading-icon start padding 8, 10, 12 and 16px; icon-only buttons are square with no side padding.) Callers never append padding, height, radius or gap; existing `pl-*` suffixes at call sites are removed.

        Variants: primary `bg-inverted-solid text-on-inverted-foreground hover:bg-inverted-solid-hover active:bg-inverted-solid-active focus-visible:outline-offset-2 disabled:bg-disabled disabled:text-disabled-foreground`; secondary `bg-component-on-container-strong text-primary-foreground shadow-default hover:bg-component-on-container-strong-hover disabled:bg-disabled disabled:text-disabled-foreground disabled:shadow-none`; tertiary `bg-component text-secondary-foreground hover:bg-component-hover disabled:bg-disabled disabled:text-disabled-foreground`; transparent `text-secondary-foreground hover:bg-transparent-hover hover:text-primary-foreground active:bg-transparent-active disabled:text-disabled-foreground`; danger-subtle `bg-danger-subtle text-danger-foreground hover:bg-danger-subtle-hover disabled:bg-disabled disabled:text-disabled-foreground`. No extra-small size: it's under the 28px hit target.
    *   `ICON = { sm: 14, md: 16, lg: 16, xl: 20 } as const` and `STROKE = (size: number) => (size > 16 ? 1.75 : 1.5)`.
    *   `LINK = "font-medium text-brand-foreground hover:underline"`.
    *   Fields: a private `INPUT_BASE = "w-full min-w-0 rounded-lg bg-component-on-container-strong px-3 text-primary-foreground shadow-default placeholder:text-tertiary-foreground focus-visible:outline-offset-[-1px] aria-invalid:inset-ring aria-invalid:inset-ring-danger-border-default"`; `INPUT = \`${INPUT_BASE} text-body-sm\``; `INPUT_MONO = \`${INPUT_BASE} font-mono text-code-sm\`` (the approver key field; used instead of `INPUT`, never with it); `INPUT_HEIGHT = { default: "h-9", toolbar: "h-8", touch: "h-11" } as const`; `TEXTAREA = \`${INPUT} min-h-28 resize-y py-2.5 leading-code-sm\`` (112px, 10 by 12px, 22px line height; `leading-code-sm` is the only 22px leading token; `INPUT` sets no height, vertical padding or `leading-*`, so nothing conflicts, and Tailwind v4's `leading-*` overrides the line height `text-body-sm` sets through `--tw-leading`); `FIELD = "flex flex-col gap-2"`; `FORM = "flex flex-col gap-5"`; `LABEL = "text-body-sm font-medium text-primary-foreground"`; `HELP = "text-caption-lg text-secondary-foreground"`; `FIELD_ERROR = "text-caption-lg text-danger-foreground"`.
    *   Segmented control: `SEGMENTED = "inline-flex max-w-full shrink-0 overflow-x-auto rounded-xl bg-sunken p-0.5"`; a private `SEGMENT_BASE = "inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-lg text-body-sm font-medium motion-safe:transition-colors motion-safe:duration-150 motion-safe:ease-out"`; `SEGMENT = \`${SEGMENT_BASE} h-7 px-3\``; `SEGMENT_ICON = \`${SEGMENT_BASE} size-7\`` (used instead of `SEGMENT`, never with it); `SEGMENT_ON = "bg-component-on-sunken text-primary-foreground shadow-default"`; `SEGMENT_OFF = "text-secondary-foreground hover:text-primary-foreground"`.
    *   Cards (no gap in the surface strings; the gap comes from `CARD_GAP`): `CARD = "flex flex-col rounded-3xl bg-container p-(--card-padding) shadow-border"`; `CARD_FILL = "flex flex-col rounded-3xl bg-card p-(--card-padding)"`; `CARD_NESTED = "flex flex-col rounded-2xl bg-card p-4"`; `CARD_GAP = { default: "gap-5", tight: "gap-3" } as const` (20px between blocks; 12px for a message's parts and nested cards); `CARD_TITLE = "text-body-base font-semibold tracking-heading text-primary-foreground"`; `CARD_DESCRIPTION = "text-caption-lg text-secondary-foreground"`; `STACK = "flex flex-col gap-(--grid-gap)"`.
    *   Tables: `TABLE_CARD = "relative flex flex-col overflow-hidden rounded-3xl bg-container shadow-border"`; `TOOLBAR = "flex flex-wrap items-center gap-3 border-b border-border-subtle px-5 py-3.5"`; `TABLE = "w-full border-collapse text-body-sm"`; `TABLE_HEAD_ROW = "border-b border-border-default"`; `TABLE_BODY = "divide-y divide-border-subtle"`; `TH = "h-(--table-header-height) px-4 text-left align-middle text-caption-lg font-medium whitespace-nowrap text-secondary-foreground"`; `TR = "hover:bg-transparent-hover motion-safe:transition-colors motion-safe:duration-150 motion-safe:ease-out"`; `TD = "h-(--table-row-height) px-4 py-4.5 align-top"`; `SUB_LINE = "mt-0.5 block text-caption-lg text-secondary-foreground"`; `NUMBER = "text-right whitespace-nowrap tabular-nums"`; `MONO = "font-mono text-code-sm leading-body-sm"`; `MONO_BREAK = \`${MONO} wrap-anywhere\`` (a value moves whole to the next line, and breaks mid-value only when it can't fit a line by itself).
    *   Page: `PAGE_PAD = "px-4 pt-8 pb-16 wide:px-14 wide:pt-12 wide:pb-24"`; `PAGE_WIDTH = { content: "max-w-(--content-max)", narrow: "max-w-3xl", form: "max-w-2xl" } as const` (1120, 768 and 672px); `SECTIONS = "flex flex-col gap-14 wide:gap-(--section-gap)"`; `PAGE_TITLE = "text-heading-6 font-semibold tracking-heading text-primary-foreground"`; `SECTION_TITLE = CARD_TITLE`; `DESCRIPTION = "text-body-sm text-secondary-foreground"`.
    *   Alerts: `ALERT = { warning: "flex items-start gap-2 rounded-xl bg-warning-subtle px-4 py-3 text-body-sm text-on-warning-subtle-foreground", danger: "flex items-start gap-2 rounded-xl bg-danger-subtle px-4 py-3 text-body-sm text-on-danger-subtle-foreground", positive: "flex items-start gap-2 rounded-xl bg-positive-subtle px-4 py-3 text-body-sm text-on-positive-subtle-foreground", neutral: "flex items-start gap-2 rounded-xl bg-card px-4 py-3 text-body-sm text-primary-foreground" } as const`.

##### 3c. `apps/console/app/ui.tsx` (Modify)

*   **Type / Scope**: React primitives; still no server-only imports.
*   **Proposed Changes**:
    *   `Badge`: `inline-flex h-6 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md px-2 text-caption-base font-medium` plus its tone; the live dot stays `size-1.5`.
    *   `Code`: `rounded-sm bg-component px-1 py-0.5 font-mono text-code-sm leading-body-sm wrap-anywhere` (inline code is 13px), with a `<wbr>` after each underscore so a reason code wraps only there. On the Decisions list the code sits on its own line under the words.
    *   `Spinner`, `Working`, `Notice`: unchanged.
    *   New `Page({ width = "content", children }: { width?: keyof typeof PAGE_WIDTH; children: ReactNode })`: `<div data-graphite="page" className={PAGE_PAD}><div className={\`mx-auto flex w-full flex-col ${PAGE_WIDTH[width]}\`}>{children}</div></div>`.
    *   New `PageHeader({ title, description, actions, before })`: a `header` with `mb-7 flex flex-col gap-2`; `before` (a breadcrumb) first; a row with the `h1` (`PAGE_TITLE`, `mr-auto`) and `actions` (`flex flex-wrap items-center gap-3`); then the description `p` (`DESCRIPTION`) when given. `title` is `ReactNode` so the decision page can put its badge beside it.
    *   New `Sections({ children })`: `<div className={SECTIONS}>`.
    *   New `Section({ id, title, description, actions, children, label })`: a `section` (`aria-labelledby` the heading's `id` when a title is given, else `aria-label={label}`), heading block `flex flex-col gap-2` with `h2` (`SECTION_TITLE`) and the description, then `mt-7` content. A Section with no title has no heading block and no top margin.
    *   New `Card({ as = "div", variant = "ring", gap, className = "", children, ...rest })`, typed `{ as?: "div" | "section" | "article"; variant?: "ring" | "fill" | "nested"; gap?: keyof typeof CARD_GAP; className?: string; children: ReactNode } & Pick<HTMLAttributes<HTMLElement>, "id" | "role" | "aria-label" | "aria-labelledby" | "aria-live">`. Variant → `CARD`, `CARD_FILL`, `CARD_NESTED`; `gap` defaults to `default` for ring and fill and `tight` for nested; `data-graphite="card"` (or `"card-nested"`). `className` is for layout only (`self-start`, `md:hidden`, `min-w-0`) and never sets padding, gap, radius, fill or shadow; a comment says so.
    *   New `CardHeading({ title, description, as = "h2", id })`: `flex flex-col gap-1` with the title (`CARD_TITLE`) and description (`CARD_DESCRIPTION`) on separate lines.
    *   Re-export nothing from `controls.ts`; components import recipes from `../src/controls` directly.

##### 3d. `apps/console/test/controls.test.ts` (Create)

*   **Type / Scope**: Vitest, console project.
*   **Proposed Changes**: imports `* as controls from "../src/controls"`. "Every recipe" is the list `recipes`: every exported string, every string value of every exported object (`INPUT_HEIGHT`, `CARD_GAP`, `PAGE_WIDTH`, `ALERT`), and `button(v, s, { icon })` for every variant × size × `icon` of `undefined`, `"leading"` and `"only"` (60 strings). `ICON` and `STROKE` are skipped (numbers and a function).
    *   Sizes: `button(v, "sm" | "md" | "lg" | "xl")` contains `h-7`, `h-8`, `h-9`, `h-11` and `px-2.5`, `px-3.5`, `px-4`, `px-5`; `{ icon: "only" }` contains `size-7` to `size-11` and no `px-`, `pl-`, `pr-` or `h-`; `{ icon: "leading" }` contains the table's `pr-*` and `pl-*` and no `px-`.
    *   Heights: a height is read with `/(?:^|\s)(?:h|size|min-h)-(\d+(?:\.\d+)?)(?=\s|$)/g` (× 4px), plus `h-(--table-header-height)` = 44 and `h-(--table-row-height)` = 56; responsive and state-prefixed classes are ignored. Every recipe with a height is at least 28px (recipes with none, such as `CARD`, are skipped).
    *   No conflicts: in each recipe, no two classes with the same variant prefix (none, `md:`, `wide:`, `hover:`, ...) share a property group from this map: `h-`/`size-` (height), `px-`/`pl-`/`pr-`/`p-` (inline padding), `rounded-` (radius), `gap-` (gap), `text-body-`/`text-caption-`/`text-code-`/`text-heading-` (font size).
    *   Tables: `TH` and `TD` use `--table-header-height` and `--table-row-height`.
    *   No recipe contains `uppercase` or `tracking-caption-upper`, and none contains `text-tertiary-foreground` except as `placeholder:text-tertiary-foreground`.
    *   `controls.ts` contains no `import`.

#### Step 4. Shell, nav and theme control

##### 4a. `apps/console/app/console-shell.tsx` (Modify)

*   **Proposed Changes**: `aside`: `flex shrink-0 flex-row items-center gap-2 px-3 pt-2 md:w-(--sidebar-width) md:flex-col md:items-stretch md:gap-6 md:py-2`. Brand row `flex h-9 items-center gap-2 px-3 text-body-sm font-semibold` (icon 16, `secondary-foreground`). `main` keeps `m-2 flex min-w-0 flex-1 flex-col rounded-2xl bg-container shadow-border md:ml-0`. The theme control stays last (`ml-auto md:mt-auto md:ml-0`). Comment updated to 260px.

##### 4b. `apps/console/app/console-nav.tsx` (Modify)

*   **Proposed Changes**: `nav` gap `gap-0.5` (2px) in both directions. Each link: `flex h-(--nav-item-height) shrink-0 items-center gap-2 whitespace-nowrap rounded-lg px-3 text-body-sm font-semimedium ...` (current and idle classes unchanged). Count badge: `ml-auto inline-flex h-6 min-w-6 items-center justify-center rounded-full bg-component px-2 text-caption-base font-medium text-secondary-foreground tabular-nums`. The `items` literals stay byte-identical.

##### 4c. `apps/console/app/theme-control.tsx` (Modify)

*   **Proposed Changes**: `fieldset` uses `SEGMENTED`; each button `SEGMENT_ICON` plus `SEGMENT_ON` or `SEGMENT_OFF`; icons stay 14px. The whole control is 32px.

#### Step 5. Approvals and the shared sign-in

##### 5a. `apps/console/src/approvals-view.ts` (Modify)

*   **Proposed Changes**: delete the local `BUTTON`, `PRIMARY` and `SECONDARY`. `CONTROL_CLASSES` becomes: `approve: \`${button("primary", "xl", { icon: "leading" })} flex-1\``; `deny: \`${button("secondary", "xl", { icon: "leading" })} flex-1\``; `signIn: \`${button("primary", "xl", { icon: "leading" })} w-full\``; `signOut: button("transparent", "md", { icon: "leading" })`; `download: button("secondary", "md", { icon: "leading" })`; `keyInput: \`${INPUT_MONO} ${INPUT_HEIGHT.default}\``. Imports `./controls`. The comment says 44px (ADR 0045).

##### 5b. `apps/console/test/approvals-view.test.ts` (Modify)

*   **Proposed Changes**: as "Tests that change" says: 44, 44, `>= 28`, and `"./controls"` in the allowed imports.

##### 5c. `apps/console/app/approvals/approvals-board.tsx` (Modify)

*   **Proposed Changes**: callers drop the `pl-2`/`pl-3` they now get from the recipes.
    *   Layout: `Page width="narrow"`; `PageHeader` with title "Approvals" and the sign-out button as `actions`; then `Sections` holding the cards section (`Section label="Open cards"` is not added: the open cards are a `div` `STACK` with no heading, as today), `Recent` and `OpenOnPhone`. The problem `Notice` and the empty line sit in the first section.
    *   `ApprovalCard`: `Card as="article" variant="ring"` (`gap-5`). Title `CARD_TITLE tabular-nums`; meta line `DESCRIPTION`. The claim block is `Card variant="nested"`; photos `size-20 rounded-xl`. Inner sub-heads (`Section` helper in this file, renamed `Part`) are `text-body-sm font-medium` with `gap-2`. Footer buttons in `flex gap-2`; error `FIELD_ERROR`. Outcome uses `ALERT[tone]` with `font-medium`.
    *   `ClaimPairs`: column labels `text-caption-lg font-medium text-secondary-foreground` (no uppercase, no tracking); rows `py-3`.
    *   `Approving`: rows `py-3`, `dt` `sm:w-32`; mono values `MONO_BREAK`; document rows `py-3 gap-x-3`; `Hash` uses `MONO`.
    *   `Recent`: `Section` titled "Recent" (`id="recent"`); rows `py-4`; time `text-caption-lg text-tertiary-foreground` (a timestamp).
    *   `OpenOnPhone`: `Section` titled with `QR_COPY.heading`, `hidden md:flex` on the section.
    *   Icon sizes: 20px in the xl buttons, 16px in md.

##### 5d. `apps/console/app/sign-in.tsx` (Modify)

*   **Proposed Changes**: `SIGN_IN_COLUMN` is removed (nothing else imports it); the component renders `Page width="form"` with `PageHeader` (title, `line` as description) and a `form` `FORM max-w-sm`; the field uses `FIELD`, `LABEL` and `FIELD_ERROR`. The button keeps `CONTROL_CLASSES.signIn` with a 20px icon.

##### 5e. `apps/console/app/approvals/page.tsx` (Modify only if needed)

*   **Proposed Changes**: no class changes are expected; it only composes `ConsoleShell`, `SignIn` and `ApprovalsBoard`. Listed so the builder checks it.

#### Step 6. Decisions list

##### 6a. `apps/console/app/decisions/page.tsx` (Modify)

*   **Proposed Changes**: delete `LINK`, `BUTTON`, `SECONDARY`, `HEAD`, `CELL` and `COLUMN`; import recipes.
    *   `Page` → `PageHeader` (title, subtitle) → a `STACK`.
    *   `ChainCard`: `Card as="section" aria-label="Audit chain"`, inner row `flex flex-wrap items-center gap-x-3 gap-y-2`.
    *   The table card: `<div data-graphite="table" className={TABLE_CARD}>` holding `<div data-graphite="toolbar" className={TOOLBAR}>` (the segmented filter `nav` with `SEGMENTED`/`SEGMENT`, and the search `form` `flex w-full gap-2 md:ml-auto md:w-auto` with an `INPUT INPUT_HEIGHT.toolbar` field `md:w-72` and a `button("secondary", "md", { icon: "leading" })`), then `<div className="overflow-x-auto">` directly around the `<table className={TABLE}>`.
    *   `thead tr` `TABLE_HEAD_ROW`; `th` `TH` (Amount adds `text-right`); `tbody` `TABLE_BODY`; rows `TR`; cells `TD`; Amount `NUMBER`; the claim under the sender `SUB_LINE`; Record `MONO whitespace-nowrap`; Why `min-w-64`.
    *   The empty line stays a `p` (`DESCRIPTION`) inside the table card's body (`px-5 py-6`) so the toolbar still shows.
    *   "Older" is `button("secondary", "md", { icon: "leading" })` with `self-start`.

#### Step 7. Audit log and Disputes

##### 7a. `apps/console/app/audit/page.tsx` (Modify)

*   **Proposed Changes**: same pattern as step 6. The toolbar holds the "Check the chain" `button("secondary", "md", { icon: "leading" })` and the total line (`DESCRIPTION`). `Verdict` is `Card as="section" role="status" aria-label="Chain check"`; problem codes `MONO`. Seq `NUMBER`; Type, Ref and Hash `MONO`; Summary `min-w-72`. `Hash` keeps `title={hash.full}`.

##### 7b. `apps/console/app/disputes/page.tsx` (Modify)

*   **Proposed Changes**: same pattern, no toolbar: `<div data-graphite="table" className={TABLE_CARD}><div className="overflow-x-auto"><table ...>`. When cell `text-tertiary-foreground` (a timestamp); dispute ID `MONO`; reason `SUB_LINE`; Amount `NUMBER`; Draft cell `flex flex-col items-start gap-2`.

##### 7c. `apps/console/app/disputes/draft-again.tsx` (Modify)

*   **Proposed Changes**: `button("secondary", "sm", { icon: "leading" })`, icons 14px; error `FIELD_ERROR`; wrapper `gap-2`.

#### Step 8. Decision detail

##### 8a. `apps/console/app/decisions/[seq]/page.tsx` (Modify)

*   **Proposed Changes**: delete local `LINK`, `BUTTON`, `SECONDARY`, `HEAD`, `CELL`, `MONO`, `SECTION`, `H2`, `COLUMN`; import recipes.
    *   `Page` (content width) → `PageHeader` with `before={<Breadcrumb/>}`, `title` = the `h1` text plus its badge (`flex flex-wrap items-center gap-x-3 gap-y-2`), description = `view.line`, and the "Open the ticket" `button("secondary", "md", { icon: "leading" })` as `actions` → `Sections`.
    *   Breadcrumb: 14px; separator `mx-2 text-tertiary-foreground`.
    *   `ClaimsTable` and `TraceTable`: each a `Section` (`id`s kept: `claims-heading`, `trace-heading`) holding `<div data-graphite="table" className={TABLE_CARD}><div className="overflow-x-auto"><table ...>`. Stacking at phone width stays: `STACK_TABLE = \`${TABLE} max-md:block\``; `STACK_ROW = \`${TR} max-md:flex max-md:flex-col max-md:gap-2 max-md:px-4 max-md:py-4\``; `STACK_CELL = \`${TD} max-md:h-auto max-md:p-0\``; `STACK_LABEL = "mb-1 block text-caption-lg font-medium text-secondary-foreground md:hidden"`. Trace verifier name `MONO` with `SUB_LINE` detail.
    *   `Why`: `Section`; list `gap-3`; detail `SUB_LINE`.
    *   `Reply`: `Section` with the note as its description; body `Card` with the text (`whitespace-pre-wrap text-body-sm`) and `CopyReply`.
    *   `Happened`: `Section`; `ol` `gap-3`; time column `sm:w-24 text-tertiary-foreground`.
    *   `AuditEntry` and `Exports`: one `Section` (no title of its own; `AuditEntry` keeps `aria-labelledby="entry-heading"` on its `Card as="section"`) with `STACK`: the entry `Card` (header row `CardHeading`-style `h2` `CARD_TITLE` with the chain badge and line; `dl` `gap-3`; `Field` `dt` `sm:w-36`) then the export buttons row (`flex flex-wrap gap-2`, `button("secondary", "md", { icon: "leading" })`).
    *   `Unreadable`: header as above; raw payload `pre` `overflow-x-auto rounded-2xl bg-sunken px-5 py-4 font-mono text-code-sm`; then the entry section.
    *   `NotFound`: `Page` → `flex flex-col gap-2`.
    *   The literal `className="overflow-x-auto..."` before each `<table` and the string `max-md:flex max-md:flex-col` must stay (console-setup test).

##### 8b. `apps/console/app/decisions/[seq]/copy-reply.tsx` (Modify)

*   **Proposed Changes**: `button("secondary", "md", { icon: "leading" })` plus `self-start`; delete the local `BUTTON`.

##### 8c. `apps/console/app/decisions/intent/[id]/page.tsx` (Modify)

*   **Proposed Changes**: its not-found view uses `Page` and `LINK`; delete the inline column classes.

#### Step 9. Inbox

##### 9a. `apps/console/app/inbox/page.tsx` (Modify)

*   **Proposed Changes**: wraps everything after `RefreshWhileWorking` in `Page` (content width). The list problem `Notice` sits under the header. The split: `flex min-h-0 flex-1 flex-col gap-6 md:flex-row md:gap-0`; list pane `md:w-90 md:shrink-0 md:pr-6`; divider unchanged; detail pane `min-w-0 flex-1 md:pl-8` (the `md:overflow-y-auto` internal scrolls go, since the page now scrolls as a whole). "All threads" back link `button("transparent", "md", { icon: "leading" })` with `-ml-2.5 mb-5 md:hidden`. Empty-detail line `DESCRIPTION`.

##### 9b. `apps/console/app/inbox/inbox-parts.tsx` (Modify)

*   **Proposed Changes**: `ThreadList`: `ul` `flex flex-col gap-0.5`; items `gap-3 rounded-xl px-3 py-3`; sender `font-semimedium`, time `text-caption-lg text-tertiary-foreground`; empty line `DESCRIPTION`. `Message`: `Card as="article" variant="fill" gap="tight"` and photos `size-24 rounded-xl`. `Run`: its `section` (`aria-label="Resolve's run"`) becomes `flex flex-col gap-6`, so the reply card, the outcome notice, the working line and "What Resolve did" sit 24px apart; reply `Card as="article"`; "What Resolve did" `Card variant="fill"` with `CardHeading`-sized `h3` (`CARD_TITLE`), status badge and the meta line (`HELP`); tool rows `py-4` with `first:pt-0 last:pb-0`; arg values `MONO`; the decision link `LINK self-start`. `ThreadDetail`: `flex flex-col gap-6`; heading `CARD_TITLE`, line `DESCRIPTION`.

##### 9c. `apps/console/app/inbox/inbox-header.tsx` (Modify)

*   **Proposed Changes**: delete local `BUTTON`, `PRIMARY`, `SECONDARY`, `FIELD`. The header becomes the `PageHeader` with title "Inbox" and `actions` = the segmented mode control (`SEGMENTED`/`SEGMENT`) and "Simulate a message" (`button("primary", "md", { icon: "leading" })`). The baseline note uses `ALERT.warning` and sits below the header (`-mt-2 mb-7`). The `Segmented` helper uses the recipes. Dialog: `p-7`, `sm:w-lg` (512px), bottom sheet unchanged; form `flex flex-col gap-6` with the header block (`h2` Heading 6, description `DESCRIPTION leading-code-sm`, 8px apart) then the fields (`FORM`), then the footer; fields use `FIELD`, `LABEL`, `HELP`, `FIELD_ERROR`, `INPUT INPUT_HEIGHT.default` and `TEXTAREA`; photo rows `h-9 rounded-lg bg-card pr-1 pl-3`, remove `button("transparent", "sm", { icon: "only" })` with its `aria-label`; footer `flex justify-end gap-2`, Cancel `button("secondary", "lg")` and Send `button("primary", "lg", { icon: "leading" })`. The dialog's error uses `ALERT.danger`.

#### Step 10. Customer chat

##### 10a. `apps/console/src/chat.ts` (Modify)

*   **Proposed Changes**: `CHAT_CONTROLS` from recipes, keeping `FOCUS`: `send: \`${button("primary", "xl", { icon: "only" })} ${FOCUS}\`` (`size-11`, 10px radius); `attach: button("transparent", "xl", { icon: "only" })`; `message: \`${INPUT} ${INPUT_HEIGHT.touch} flex-1 ${FOCUS}\``; `email: \`${INPUT} ${INPUT_HEIGHT.touch} ${FOCUS}\``; `start: button("primary", "xl")`; `removePhoto: button("transparent", "sm", { icon: "only" })`; `startOver: button("transparent", "sm")`.

##### 10b. `apps/console/test/chat.test.ts` (Modify)

*   **Proposed Changes**: floor 28px, send 44px (`size-11`).

##### 10c. `apps/console/app/chat/customer-chat.tsx` (Modify)

*   **Proposed Changes**: `max-w-md` instead of `max-w-[448px]`; header `px-4 py-4 gap-2`, title `CARD_TITLE`; the simulation notice `HELP` (it's what the customer must read, so `secondary-foreground`, not tertiary); start form `px-4 pt-8 pb-12` with `FORM`; title Heading 6; fields `FIELD`/`LABEL`/`HELP`/`FIELD_ERROR`; the "Chatting as" line `HELP`; messages `gap-4`, bubbles `px-4 py-3`; alerts `ALERT.danger`; composer `px-4 pt-3 gap-3`; photo chip `h-9 pl-3`; icons 20px in the xl buttons.

#### Step 11. Storefront

##### 11a. `apps/storefront/app/layout.tsx` (Modify)

*   **Proposed Changes**: `body` `bg-page`; wrapper `mx-auto flex min-h-full w-full max-w-(--content-max) flex-col px-4 pt-8 pb-16 wide:px-14 wide:pt-12 wide:pb-24`; the header link `inline-flex h-9 items-center text-body-sm font-semibold`; the content `flex-1 py-12 wide:py-16`; the footer notice `text-caption-lg text-secondary-foreground`.

##### 11b. `apps/storefront/app/page.tsx` (Modify)

*   **Proposed Changes**: heading stays serif Heading 3; description `mt-2 text-body-base`; grid `mt-7 grid gap-(--grid-gap) sm:grid-cols-2 lg:grid-cols-3`; card `flex h-full flex-col gap-5 rounded-3xl bg-container p-(--card-padding) shadow-border` with `data-graphite="card"`; title block `flex flex-col gap-1`: name `text-body-base font-semibold tracking-heading`, description `text-caption-lg text-secondary-foreground`; price `font-mono text-code-sm tabular-nums`.

##### 11c. `apps/storefront/app/products/[productId]/page.tsx` (Modify)

*   **Proposed Changes**: back link a small transparent button (`-ml-2 inline-flex h-7 items-center gap-1.5 rounded-lg pr-2.5 pl-2 text-caption-lg font-medium text-secondary-foreground hover:bg-transparent-hover hover:text-primary-foreground`, icon 14px); `h1` `mt-7` Heading 4; checkout section `mt-14 wide:mt-20`; `main` `max-w-2xl`.

##### 11d. `apps/storefront/app/products/[productId]/paypal-checkout.tsx` (Modify)

*   **Proposed Changes**: status card `rounded-3xl bg-container p-(--card-padding) shadow-border` with `data-graphite="card"`; badge `h-6 px-2 text-caption-base`; receipt rows `py-3`; IDs `font-mono text-code-sm`. The PayPal button slot keeps `max-w-xs`. The harness never renders this component (with no PayPal env the product page shows only its not-set-up line), so 11d is verified by validation manual check 5 (reading the diff), not by a shot.

#### Step 12. AG Studio theme and the spike page

##### 12a. `packages/graphite/src/sizes.ts` (Create)

*   **Proposed Changes**: `export const GRAPHITE_SIZES = { uiText: 14, captionText: 13, cardTitle: 16, tableRow: 56, tableHeader: 44, cellPadding: 16, cardPadding: 24, gridGap: 24, cardRadius: 16 } as const;` with a comment naming each token (`--text-body-sm`, `--text-caption-lg`, `--text-body-base`, `--table-row-height`, `--table-header-height`, `--space-4`, `--card-padding`, `--grid-gap`, `--radius-3xl`). AG Studio needs numbers for row and header heights (it measures rows in JavaScript), so these are numbers, checked against the tokens by 12c.

##### 12b. `packages/graphite/src/ag-theme.ts` (Modify)

*   **Proposed Changes**: from `GRAPHITE_SIZES`: `fontSize`, `gridFontSize` 14; `gridRowHeight` 56; `gridHeaderHeight` 44; `gridHeaderFontSize` 13 with `gridHeaderTextColor` `color-secondary-foreground` and weight 500; `gridCellHorizontalPadding` 16; `studioCanvasPadding` 24; `studioWidgetPadding` 24; `studioWidgetBorderRadius` 16; `studioWidgetTitleFontSize` 16, weight 600; `studioWidgetSubtitleFontSize` and `studioWidgetCaptionFontSize` 13. Every param name must type-check against `studioTheme.withParams`. For the header height the builder tries `gridHeaderHeight`, then `headerHeight`; for the cell padding `gridCellHorizontalPadding`, then `cellHorizontalPadding`. If neither name of a pair type-checks, that line is dropped and one line in `.ralph/progress.md` names it; Studio's grid then keeps its own header height or padding until phase 16 builds the Risk desk, which is an accepted trade-off (the spike isn't linked from the console). Colours are unchanged.

##### 12c. `packages/graphite/test/sizes.test.ts` (Create)

*   **Proposed Changes**: reads `packages/graphite/graphite-tokens.css`'s `:root` block (up to `.dark,`) and, for each row of this table, expects `GRAPHITE_SIZES[key]` to equal the token's px value, read with `new RegExp(\`${token}:\\s*(\\d+)px\`)`:

    | Key | Token |
    |---|---|
    | `uiText` | `--text-body-sm` |
    | `captionText` | `--text-caption-lg` |
    | `cardTitle` | `--text-body-base` |
    | `tableRow` | `--table-row-height` |
    | `tableHeader` | `--table-header-height` |
    | `cellPadding` | `--space-4` |
    | `cardPadding` | `--card-padding` |
    | `gridGap` | `--grid-gap` |
    | `cardRadius` | `--radius-3xl` |

    It also expects the table to cover every key of `GRAPHITE_SIZES`.

##### 12d. `apps/console/app/spike/risk-desk/page.tsx` and `money-protected-widget.tsx` (Modify)

*   **Proposed Changes**: header `flex items-center justify-between px-6 py-4` with `data-graphite="spike-header"` (the harness's scope for this screen); title `CARD_TITLE`; the "Spike S9, sample data" label `HELP` (it labels simulated data, brief §8, so not tertiary). Widget: caption `text-caption-lg text-secondary-foreground`; the rest unchanged.

#### Step 13. Brand book and component READMEs

Files (all Modify): `Graphite Design/brand-book.md`, `Graphite Design/components/README.md`, and `Graphite Design/components/{Accordion,Avatar,Badge,Breadcrumb,Button,Card,Checkbox,CodeCard,Command,Dialog,Input,InputOTP,Kbd,Menu,Switch,Table,Tabs,Toast,Tooltip}/README.md`.

*   **Type / Scope**: docs; `Tier: simple`.
*   **Proposed Changes**: replace every value and phrase that disagrees with `DESIGN.md`, as listed in requirements.md's "Graphite Design companions". No new guidance beyond `DESIGN.md`. The `Select`, `Skeleton`, `Spinner`, `Divider` and `ScrollArea` READMEs are unchanged (`Cover` has no README).

#### Step 14. `Graphite Design/components/bundle.css` and the previews (Modify)

Files: `Graphite Design/components/bundle.css` and every `Graphite Design/components/*/preview.html` whose inline styles or sample text contradict `DESIGN.md`.

*   **Type / Scope**: the reference component stylesheet and its previews; `Tier: simple`.
*   **Previews**: the builder finds them with `grep -nE "dense|uppercase|[0-9]+px" "Graphite Design/components"/*/preview.html` and fixes only the hits that contradict `DESIGN.md` (old sizes such as 13px UI text or 40px rows, "dense", uppercase table headers, and class names this step renames such as `.gr-avatar-24`). Layout-only px in a preview's own scaffolding (a demo frame's width) stays.
*   **Proposed Changes**: every value requirements.md lists for it. Where `DESIGN.md` names a layout token, use the variable (`var(--menu-item-height)`, `var(--table-row-height)`, `var(--table-header-height)`, `var(--card-padding)`); other values stay literal px, as the file already does. `.gr-btn`'s default height becomes `var(--control-md)` with 14px padding. Adds `.gr-kbd-sm` (18px), `.gr-table td .gr-sub` (the 13px second line) and `.gr-command-footer`. No raw hex is added.

#### Step 15. `Graphite Design/tokens.json` (Modify)

*   **Type / Scope**: token data; `Tier: simple`.
*   **Proposed Changes**: type styles, `space-20`, `space-24`, `space` (4px), the control heights and a new top-level `layout` group (`{ "note", "tokens": [{ "name", "value", "usage" }] }`, same shape as `size`) with the nine layout tokens, all with the values in `graphite-tokens.css`; usage strings that say "dense", "13px labels", "table headers" (for uppercase) or old paddings are rewritten to `DESIGN.md`'s wording. Valid JSON; one-space indent as now.

#### Step 16. Density pass

Files: any console or storefront file from steps 4 to 12 that the full harness run still flags.

*   **Proposed Changes**: run `npm run build` and `npm run ui:shots` with no filter; fix every `FAIL` line in the files that cause it, using the recipes; rerun until it prints `0 failures`. Record the final summary line in `.ralph/progress.md`.

### Verification Plan

*   **Compilation/Build**: `npm run typecheck`; `npm run build`.
*   **Unit Tests**: `npm test` (includes `design-check.test.ts`, the new `controls.test.ts`, `sizes.test.ts` and `tests/ui-shots/fixtures.test.ts`, and the edited approvals and chat tests).
*   **Static Analysis & Linting**: `npm run lint` (Biome).
*   **Test Coverage Requirement**: no coverage target; every recipe size and every `GRAPHITE_SIZES` value has an assertion.
*   **E2E/Integration**: `npm run build` then `npm run ui:shots`: 56 shots, `0 failures`, then the manual review of every shot in validation.md.

--------------------------------------------------------------------------------

*Drafted with EGM*
