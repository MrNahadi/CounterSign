# Phase 13a validation: Graphite at a comfortable density

The authority is `Graphite Design/DESIGN.md` (ADR 0045), with the departures listed in requirements.md. Nothing in this phase calls an external service, so there are no live checks.

## Automated checks

Checks 1 to 5 are part of the Feedback commands. Checks 6 to 8 run by hand at validation, from the repo root.

1. **Feedback commands.** `npm run typecheck`, `npm run lint`, `npm test` and `npm run build` pass. `packages/graphite/test/design-check.test.ts` passes unchanged. `git diff main --stat -- '*.test.ts'` shows only the two edited files, `apps/console/test/approvals-view.test.ts` and `apps/console/test/chat.test.ts`, and the three new ones, `apps/console/test/controls.test.ts`, `packages/graphite/test/sizes.test.ts` and `tests/ui-shots/fixtures.test.ts`; the edits to the first two only change the 40 to 44, 24 to 28 and allowed-imports lines. `npm run typecheck` includes `tests/ui-shots/tsconfig.json`, and the root project excludes `tests/ui-shots`. `@playwright/test` is an exact root devDependency at the version `specs/tech-stack.md` lists.
2. **Recipes** (`apps/console/test/controls.test.ts`): small, medium, large and extra-large buttons are 28, 32, 36 and 44px with 10, 14, 16 and 20px side padding; icon-only buttons are square; no recipe is under 28px; table headers and rows use `--table-header-height` and `--table-row-height`; no recipe uppercases text or uses tertiary text outside placeholders; `controls.ts` has no imports.
3. **Pinned sizes.** Approve, Deny and Sign in are 44px and every approvals control at least 28px (`approvals-view.test.ts`); every chat control is at least 28px and send is 44px (`chat.test.ts`); every `GRAPHITE_SIZES` value equals its token in `graphite-tokens.css` (`sizes.test.ts`).
4. **Layout in source.** The shell uses `--sidebar-width` and the nav `--nav-item-height`; every console page except `/chat` and the spike renders inside `Page` (`data-graphite="page"`); `packages/graphite/tailwind.css` registers `--breakpoint-wide: 900px` and still has every line the design check reads.
5. **One place to change the system.** `grep -rnE "const (BUTTON|PRIMARY|SECONDARY|HEAD|CELL|COLUMN|FIELD) =" apps/console/app` finds nothing, and no file under `apps/console/app` contains `tracking-caption-upper` or `uppercase`. The fixtures parse with the console's schemas (`tests/ui-shots/fixtures.test.ts`).
6. **Screenshots and density checks.** `npm run build`, then `npm run ui:shots`. It renders the 14 screens in design.md step 2c (console: `inbox`, `inbox-thread`, `approvals`, `approvals-signed-out`, `disputes`, `decisions`, `decision`, `decision-unreadable`, `audit`, `audit-check`, `chat`, `risk-desk`; storefront: `shop`, `product`) in light and dark at 1440px and 390px, 56 shots in `test-results/ui-shots/`, and must end with `ui-shots: 56 shots, 0 failures`. It needs `@playwright/test`'s Chromium (`npx playwright install chromium`, run by `scripts/cloud-setup.sh`) or `UI_SHOTS_CHROMIUM`. `risk-desk` runs without an AG Studio licence or Gemini key, and its element checks cover only the page's own header. `note ... fonts` lines (no network to Google Fonts) aren't failures, but the validator says in the notes whether the shots used Inter or fallback fonts. Its checks:
   - `table-header`: every header cell 44px, 13px, weight 500, no uppercase;
   - `table-rows`: every body row at least 56px, every cell at least 14px;
   - `hit-target`: every control at least 28px; Approve, Deny and Sign in at least 44px;
   - `small-text`: no text under 12px;
   - `cards`: card padding at least 24px (nested cards 16px), cards at least 24px apart;
   - `toolbar`: one row from 768px up;
   - `shell`: a 260px sidebar, 36px nav items, the panel inset 8px with a 12px radius;
   - `page`: 48px top and 56px side padding from 900px, 32px and 16px below;
   - `overflow`: no sideways scroll at 390px (tables scroll inside their card);
   - `emoji`: none on screen;
   - `uppercase`: no text is uppercased by CSS (no screen has an eyebrow or menu group heading);
   - `theme`: `html.dark` matches the theme, and each screen's background differs between light and dark.7. **Graphite Design companions.** In `Graphite Design/brand-book.md`, `Graphite Design/components/README.md`, every `components/*/README.md`, every `components/*/preview.html` and `components/bundle.css`, a search for `dense`, `13px interface`, `15px on`, `240px`, `40px rows`, `uppercase caption header` and `text-transform: uppercase` on table headers finds nothing, and each value listed in requirements.md's "Graphite Design companions" is present. `bundle.css` has no raw hex added (`git diff main -- "Graphite Design/components/bundle.css" | grep -E "^\+.*#[0-9a-fA-F]{3,8}\b"` is empty).
8. **`tokens.json`.** `node -e 'JSON.parse(require("fs").readFileSync("Graphite Design/tokens.json","utf8"))'` succeeds. Every type style, `space-*`, `control-*` and `layout` value equals `graphite-tokens.css`'s light block (the validator compares them with a short script and lists any difference), and nothing outside those groups changed (`git diff main` on the file touches no colour, radius, shadow, weight, tracking, duration or easing entry).

## Manual review (by the validator)

1. **Every shot against `DESIGN.md`.** Open all 56 PNGs from check 6. For each, note a pass or the problem against:
   - the density signs: more than one row of toolbar controls at desktop, two badges or hints competing in one button, table text under 14px, cards closer than 24px, a section running into the next with no clear gap;
   - the Do and don't table: one primary button per screen (the approvals cards' Approve buttons count as one action repeated per card), hierarchy from weight and colour rather than big type, 24px card padding and gaps, 56px rows with 14px text, one toolbar row, alpha tokens only, ring edges, blue only for links, focus, selection and one brand action (no blue backgrounds or headings), Lucide icons and no emojis, both themes right;
   - the layout model: the sidebar sits directly on the shell, the main panel is inset with its radius and hairline, `/chat` and the storefront are full-bleed `page` screens;
   - dark mode: no unreadable text, no lost edges, no light-only shadows, the theme control showing the current choice.
   Record the result as a table in the validation notes, one row per screen with light/dark × desktop/phone.
2. **Behaviour unchanged.** With the harness's servers running (or `next dev` against the fakes), click through: the decision filter and search, Older, a decision link, the breadcrumb, Check the chain, a disputes Draft again (it fails against the fake, showing its one sentence), the inbox's thread links and All threads at 390px, opening and closing Simulate a message (Escape and Cancel), the theme control's three choices (System clears the saved value), and the approvals sign-out. Each works as on `main`.
3. **Keyboard and focus.** Tab through `/decisions` and `/approvals`: every control shows the 1px `brand-border-focus` ring (inset on fields, offset on solid buttons), in both themes.
4. **Reduced motion and more contrast.** With Chromium's `reducedMotion: "reduce"` and `forcedColors`/`prefers-contrast: more` emulation, buttons don't scale when pressed, transitions keep colour fades only, and secondary and tertiary text step up as the tokens' `prefers-contrast` block says.
5. **What no shot shows.** Read the diff of `apps/storefront/app/products/[productId]/paypal-checkout.tsx` (the harness has no PayPal env, so its status card never renders) and check it against requirements.md's checkout values. Note in the validation notes any AG Studio param that `.ralph/progress.md` says was dropped.

## Manual checks for the owner

1. Open the console and the storefront on your own desktop browser and phone, in light and dark, and say whether the comfortable density reads as you intended. Anything you'd change goes to `.ralph/human.md` as a follow-up; the values come from your `DESIGN.md`, so changing them there changes them everywhere once the tokens are updated.
2. Before recording the video, check the approvals card at phone width: Approve and Deny are now 44px and the card is roomier, so less of a long card fits on one screen.
