# Phase 13a requirements: Graphite at a comfortable density

The owner's request of 31 Oct 2026 and their updated `Graphite Design/DESIGN.md` and `graphite-tokens.css` (ADR 0045, `Decided-by: owner`). Brief §8 (Graphite on every UI, semantic tokens only, Lucide, no emojis, light default, dark works), §11 (accessibility floors). ADR 0045 overrides the brief glossary's "small type" wording without editing the brief, and supersedes ADR 0018's 240px sidebar. Where this file and `DESIGN.md` disagree, `DESIGN.md` wins, except for the decisions listed under "Deliberate departures", which brief §8, §11 or CLAUDE.md settle. Where this file and the brief disagree, the brief wins.

## What doesn't change

- Routes, server and client behaviour, polling, sign-in, approvals, exports, links, `aria-*` labels and roles, and every copy string. Case comes from the source text, which is already sentence case.
- `Graphite Design/DESIGN.md`, `Graphite Design/graphite-tokens.css` and `packages/graphite/graphite-tokens.css` (byte-identical).
- Every existing test, except the edits to two test files in design.md's "Tests that change". `packages/graphite/test/design-check.test.ts` passes unchanged.
- The colour tokens each element uses, except where a rule below names a new one.

## Deliberate departures from DESIGN.md

- Extra-large buttons use `body-sm` (14px), because 15px has no token (CLAUDE.md: values from tokens).
- Table cell sub-lines are 13px in `secondary-foreground`, not tertiary (brief §11: tertiary never for what a user must read).
- From 768px up a toolbar is one row; below 768px it may wrap.
- The customer chat's message and email fields are 44px, matching its 44px touch buttons.
- Page titles stay Heading 6 (20px, 600).
- Table dividers stay 1px `divide-y` lines (DESIGN.md's Table spec names them); card and panel edges are rings.

## Shared values (every console screen)

### Layout

- **Shell.** The sidebar sits on `shell` with no fill, 260px wide (`--sidebar-width`) from 768px up. Nav items are 36px tall (`--nav-item-height`), 2px apart, 12px side padding, 14px weight 450, 16px icons. The brand row is 36px. The main panel is `container`, inset 8px from the shell on top, right and bottom (and left below 768px), `--radius-2xl`, `--shadow-border`. Below 768px the sidebar is one row above the panel, as now.
- **Page padding** inside the panel: 48px top, 56px sides, 96px bottom from 900px up; 32px, 16px and 64px below 900px.
- **Content width**: list and detail pages at most 1120px (`--content-max`), centered; the approvals board at most 768px; the sign-in at most 672px with its form at most 384px.
- **Page header**: title Heading 6 at 600 with heading tracking, description 14px `secondary-foreground` 8px below it, actions on the title's row, 28px from the header to the first content.
- **Sections**: 80px apart (`--section-gap`) from 900px up, 56px below. A section heading is 16px semibold with heading tracking, its description 14px `secondary-foreground` 8px below, then 28px to the content.
- **Cards**: `container` with `--shadow-border` (ring) or `card` fill (grouping), `--radius-3xl`, 24px padding (`--card-padding`), 20px between the blocks inside. Nested small cards: `card` fill, `--radius-2xl`, 16px padding. Cards in a stack or grid sit 24px apart (`--grid-gap`). A card title is 16px semibold with heading tracking; a card description is 13px `secondary-foreground` on its own line 4px below.

### Components

- **Buttons** (rounded `--radius-lg`, medium weight, no wrapping, press scale 97% over 200ms, motion-safe only):

  | Size | Height | Side padding | Leading-icon start padding | Gap | Icon | Text |
  |---|---|---|---|---|---|---|
  | Small | 28px | 10px | 8px | 6px | 14px | 13px |
  | Medium (default) | 32px | 14px | 10px | 6px | 16px | 14px |
  | Large | 36px | 16px | 12px | 6px | 16px | 14px |
  | Extra large | 44px | 20px | 16px | 8px | 20px | 14px |

  Icon-only buttons are square at the size's height; extra large icon-only uses `--radius-xl`. Variants: primary (`inverted-solid`, with a 2px focus offset), secondary (`component-on-container-strong` with `--shadow-default`), tertiary (`component`), transparent, danger subtle. Disabled uses `disabled` and `disabled-foreground` with `not-allowed`. No button is under 28px.
- **Inputs**: 36px by default, 32px in a toolbar, 44px in the customer chat; 12px side padding; 14px text; `component-on-container-strong` with `--shadow-default`; placeholder `tertiary-foreground`; inset 1px focus ring; error inset ring `danger-border-default`. Textarea: 10px by 12px padding, 22px line height, at least 112px tall. Label 14px medium `primary-foreground`; helper and error 13px; 8px between label, field and helper; 20px between fields.
- **Segmented control**: `sunken` track, `--radius-xl`, 2px padding; segments 28px tall, 12px side padding, 14px medium; the active one `component-on-sunken` with `--shadow-default` and `--radius-lg`. The whole control is 32px.
- **Badge**: 24px tall, 8px side padding, 12px medium, `--radius-md`; neutral `component` with `secondary-foreground`; status subtle fill with its `on-*-subtle` text; live dot 6px.
- **Inline code**: mono 13px, `component` fill, `--radius-sm`, 2px by 4px padding, line height of the surrounding 14px text.
- **Code block**: `sunken`, `--radius-2xl`, 16px by 20px padding, mono 13px, horizontal scroll.
- **Tables**: in a table card (`container`, ring, `--radius-3xl`, clipped). Header row 44px (`--table-header-height`), 13px medium sentence case `secondary-foreground`, 16px side padding, no uppercase and no letter-spacing. Body rows at least 56px (`--table-row-height`), 14px, 16px side padding, single lines centred in the row (18px top padding), 1px `border-subtle` dividers, `transparent-hover` on hover. Sub-lines 13px `secondary-foreground` 2px below. Numbers right-aligned and tabular. IDs, hashes, types and refs mono 13px. A toolbar above a table is part of the table card: 14px by 20px padding, 12px gap, a `border-subtle` line below it, one row from 768px up.
- **Inline alerts** (baseline note, dispatch errors, outcome lines): subtle fill with its text token, `--radius-xl`, 12px by 16px padding, 14px, icon 16px.
- **Breadcrumb**: 14px; ancestors `secondary-foreground`; current page `primary-foreground` medium; "/" in `tertiary-foreground` with 8px either side.
- **Dialog** ("Simulate a message"): `modal`, `--shadow-xl`, `--radius-3xl`, 28px padding, 512px wide from 640px up; title Heading 6 at 600; description 14px at a 22px line height, 8px below; 24px between the title block and the fields, 20px between fields, 24px before the footer; footer buttons large (36px), right-aligned, primary last. Below 640px it stays a bottom sheet with 16px top corners and the 32 by 4px handle.
- **Theme control**: the segmented control with 28px icon-only segments (14px icons), 32px overall.
- **Nav count badge**: 24px tall, at least 24px wide, pill, 12px medium, `component` with `secondary-foreground`, tabular.
- **Timestamps** use 13px `tertiary-foreground` (meta). Anything a user must read uses `primary-` or `secondary-foreground`.

## Per screen

### Decisions (`/decisions`)

Page header (title, subtitle) → stack, 24px apart: the chain card (badge, line and link on one wrapping row, 12px apart) and the table card. The table card's toolbar holds the decision filter (segmented, each segment with its count) and the search form (32px field, 288px wide from 768px up, and a secondary medium Search button with its icon). Columns as now: When (link), Ticket (sender, claim sub-line), Action, Amount (right), Decision (badge), Why (words then inline code; at least 256px), Status, Record (mono). The empty line sits inside the table card under the toolbar, 24px by 20px padded. "Older" is a secondary medium button with its chevron, 24px below the card.

### Decision (`/decisions/[seq]`)

Page header: breadcrumb, title with its badge beside it, the line, and "Open the ticket" (secondary medium) → sections 80px apart: Claims vs records (table card; stacked rows below 768px with 13px medium `secondary-foreground` labels, 16px padding, 8px between parts), How it decided (trace table card: words, verifier name in mono, detail sub-line; records; result badge), Why (list 12px apart, detail sub-line), the suggested reply (section description = the note; a ring card with the text and the copy button), What happened (list 12px apart, 96px time column from 640px up), and the audit entry section (the entry card: 16px semibold heading with the chain badge and line; fields 12px apart with a 144px label column; "Check the chain" link; then the export buttons, secondary medium, 24px below the card). Unreadable: header, the raw-payload code block, then the entry section. Not found: the message and link, 8px apart.

### Audit log (`/audit`, `/audit?check=1`)

Page header → stack: the verdict card (when checked; badge and heading on one row, problems list 4px apart with mono codes) and the table card. The toolbar holds "Check the chain" (secondary medium, shield icon) and the total line. Columns as now; Seq right-aligned tabular; Type, Ref and Hash mono; Hash keeps its full value as the tooltip and for screen readers; Summary at least 288px.

### Disputes (`/disputes`)

Page header → the table card with no toolbar. When is a 13px-meta timestamp; Dispute is the mono ID with the reason sub-line; Amount right; Draft holds the link or words with "Draft again" (secondary small, 14px icon) 8px below and its error 8px below that.

### Approvals (`/approvals`)

Narrow page (768px). Header: "Approvals" and, when signed in, Sign out (transparent medium with its icon). Then sections:

- The open cards, 24px apart, or the empty line, after any problem notice.
- Each card is a ring card (`article`), 24px padding, 20px between blocks. Header: the title (16px semibold, tabular), the time-left badge on its right, the meta line (14px `secondary-foreground`) with the simulated badge. The claim block is a nested card (16px padding): claim (14px medium), subject, excerpt, photos at 80px with `--radius-xl`. Parts ("Why it's waiting", the claim pairs, "What you're approving") each have a 14px medium heading 8px above their content. Claim-pair column labels are 13px medium sentence case `secondary-foreground`; pair rows 12px vertical padding. Approving rows 12px vertical padding with a 128px label column from 640px up; documents with name, size, hash (mono 13px) and a secondary medium Download. The footer is Deny and Approve, extra large (44px), each filling half the row, 8px apart, with 20px icons; the error line 13px `danger-foreground` above them. An answered card shows its outcome as an inline alert in its tone.
- Recent: a section titled "Recent"; lines 16px vertical padding, title weight 450, outcome badge, time as 13px meta on the right.
- Open on your phone (from 768px up): a section with its heading, the 160px QR card and its line.

Signed out: the shared sign-in.

### The shared sign-in (approvals, decisions, decision, audit log, disputes)

Form-width page; page header with the page's title and line; the form at most 384px wide: the key field (label, 36px mono field, error) and Sign in, extra large (44px) and full width with a 20px icon.

### Inbox (`/inbox`, `/inbox?thread=`)

Content-width page. Header: "Inbox", the Protected | Baseline segmented control and "Simulate a message" (primary medium with its icon) on the title row. In baseline mode the warning alert sits under the header. Then the list problem notice, or the split: from 768px up, the thread list 360px wide and 24px from the 1px divider, the thread 32px from it; below 768px one pane at a time, as now, with "All threads" (transparent medium with its arrow) above the thread. The page scrolls as a whole (no inner scroll panes).

- Thread list: items 2px apart, `--radius-xl`, 12px padding, 12px icon gap; sender 14px weight 450, time 13px meta, title 14px `secondary-foreground` with the status badge. The selected item keeps `brand-subtle`.
- Thread: title 16px semibold, line 14px `secondary-foreground`; entries 24px apart. A customer message is a `card`-fill card (24px padding, 12px between its parts) with photos at 96px and `--radius-xl`. Resolve's reply is a ring card. "What Resolve did" is a `card`-fill card: its 16px semibold heading, status badge and 13px meta line on one wrapping row, then the tool rows (16px vertical padding, dividers) with mono argument values, the decision badge, reason lines and the "Claims vs records" link.

### Customer chat (`/chat`)

Full-bleed `page`, at most 448px wide. Sticky header 16px padded: the shop name 16px semibold, Start over (transparent small), and the simulation notice at 13px `secondary-foreground`. The start form: 32px top padding, Heading 6 title with its 16px description, the email field (44px), its helper or error, and Start chat (primary extra large). The conversation: messages 16px apart, bubbles 12px by 16px padding at 16px text; errors as danger alerts; the composer 12px apart with attach (transparent, 44px, icon-only), the 44px message field and send (primary, 44px, icon-only, `--radius-xl`), a 36px photo chip with a 28px remove button.

### Risk desk spike (`/spike/risk-desk`)

Header 16px by 24px padded: "Risk desk" 16px semibold, the "Spike S9, sample data" label at 13px `secondary-foreground`, the theme control. The Studio panel stays inset 8px. The AG Studio theme (`packages/graphite/src/ag-theme.ts`): 14px UI and grid text; grid rows 56px; header 44px, 13px medium `secondary-foreground`; cell side padding 16px; canvas padding 24px; widgets 24px padding and 16px radius, title 16px semibold, subtitle and caption 13px. Each number comes from `packages/graphite/src/sizes.ts`, which a test checks against the tokens. A param that AG Studio's `withParams` type doesn't accept under either name design.md step 12b gives is left out and named in `.ralph/progress.md`; Studio keeps its own value for it until phase 16 (accepted trade-off, `reviews/resolution.md`).

### Storefront (`/`, `/products/[id]`)

Full-bleed `page`; the content padded like the console's page (48/56/96, below 900px 32/16/64) and at most 1120px wide. Header: the shop name link, 36px tall, 14px semibold. Footer: the illustrative-shop notice at 13px `secondary-foreground`.

- Shop: serif Heading 3 title, 16px description 8px below, then 28px to the grid: product cards 24px apart, one column below 640px, two from 640px, three from 1024px. Each card is a ring card (24px padding, `--radius-3xl`, 20px between blocks): the name at 16px semibold with heading tracking and the arrow icon, the description at 13px `secondary-foreground` 4px below, the price in mono 13px tabular.
- Product: at most 672px; "All products" as a transparent small button (28px, 14px icon); Heading 4 name 28px below it; description; price; the checkout section 80px below (56px below 900px). The checkout status card is a ring card with 24px padding; its badge 24px tall; receipt rows 12px vertical padding; IDs mono 13px. PayPal's own buttons are unchanged.

## Graphite Design companions

`DESIGN.md` wins. Each item below is a disagreement found on 31 Oct 2026; the builder fixes each one and anything else in the same files that contradicts `DESIGN.md`.

### `brand-book.md`

- Opening line: "dense, calm product UI ... 13px interface text" → "calm, roomy product UI ... generous spacing ... 14px interface text".
- Sentence case: drop "table headers before they're uppercased"; table headers are sentence case.
- `tertiary-foreground`: meta text is timestamps, placeholders and hints, not table headers.
- White on brand, danger and positive solid: "3.1 to 3.9:1", including positive.
- Type: `body-sm` 14px on 20px; `body-base` 16px on 24px; uppercase captions are for eyebrows and menu or sidebar group headings, not table headers; helper text, metadata and table sub-lines use `caption-lg` (13px); `caption-sm` and `caption-xs` only for avatar initials and tiny counters.
- Spacing: `space-1` to `space-24`; card padding 24px (`--card-padding`), 16px only for small nested cards; grid gaps 24px (`--grid-gap`); dialog padding 28px; page sections 80px apart (`--section-gap`), 56px below 900px; form fields 20px apart; the container padding and `--content-max` (1120px); the 260px sidebar (`--sidebar-width`) with 36px nav items; "when unsure, add space"; the signs of a too-dense screen.
- Controls: `control-xs` to `control-xl` are 24 to 44px; buttons default to `control-md` (32px); inputs are 36px, 32px in toolbars; the minimum hit target is 28px; touch primary actions use `control-xl` (44px).
- Radius: cards `radius-3xl`; small nested cards `radius-2xl`; menus, popovers, toasts and the main container `radius-2xl`.

### `components/*/preview.html`

- Any inline style or sample text that contradicts `DESIGN.md` (old UI text sizes, 40px rows, "dense", uppercase table headers) or uses a class `bundle.css` renames (`.gr-avatar-24` becomes `.gr-avatar-28`) follows the new values. A preview's own demo-frame scaffolding stays.

### `components/README.md`

- Say which values come from tokens (colours, radii, shadows, motion, control heights and the layout tokens) and that other sizes in `bundle.css` are literal px matching `DESIGN.md`.
- Say `tokens.json` mirrors `graphite-tokens.css` and that `DESIGN.md` is the authority (ADR 0045), replacing "refresh these copies rather than editing them".

### Component READMEs

- Badge: 24px, 8px side padding, `caption-base` (12px) medium.
- Button: 14px text for md and lg (xs 12, sm 13, xl 15 as `DESIGN.md` states for the reference CSS); heights xs 24, sm 28, md 32 (default), lg 36, xl 44; paddings 8, 10, 14, 16, 20; gaps 4, 6, 6, 6, 8; a keyboard hint only in secondary buttons, as the small Kbd (18px).
- Input: 36px, 14px text, 12px side padding; textarea 10 by 12px padding, 22px line height, 112px minimum; labels 14px medium; helper 13px; 8px between label, field and helper; 32px (`control-md`) in toolbars, without "dense".
- InputOTP: 44 by 52px cells, 8px apart.
- Menu: items 36px (`--menu-item-height`), 10px side padding, 10px icon gap, 14px; minimum width 240px; group headings 12px with 8px above and 6px below; shortcuts 13px; separators 6px vertical margin.
- Command: results 40px in a list with 6px padding; input 56px tall with 20px side padding (remove "15px"); footer with key hints, 12 by 20px padding, `caption-lg`.
- Dialog: 28px padding; 24px between title block and footer; description 22px line height, 8px below the title.
- Card: title 16px semibold with heading tracking; description on its own line 4px below at 13px; `radius-3xl`, 24px padding (`--card-padding`), 20px between blocks; small nested cards `radius-2xl` and 16px.
- CodeCard: filename `caption-lg` (13px); 22px line height; 16 by 20px padding.
- Kbd: minimum 22px, small 18px.
- Tabs: underline tabs 14px medium, 44px tall, 24px apart; segments 28px with 12px side padding, the control 32px.
- Table: 56px rows (`--table-row-height`), 14px, 16px cell padding; header 44px (`--table-header-height`), 13px medium sentence case `secondary-foreground`, no uppercase; a 13px second line 2px below; one-row toolbar above; drop "dense".
- Accordion: trigger 52px, 14px medium; panel 14px at 22px line height, 16px bottom padding.
- Avatar: 20, 28, 32 and 40px, 28px default in tables and lists.
- Breadcrumb: 14px, 8px either side of the separator.
- Checkbox: 18px checkbox and radio; option rows at least 28px with 10px between control and label.
- Switch: 36 by 20px with a 16px thumb.
- Toast: 16px padding, 12px icon gap, 24px from the edges, 12px between stacked toasts, title and description 14px.
- Tooltip: 13px, 6 by 10px padding.

### `components/bundle.css`

- Base text 14px; `.gr-label-meta` 12px.
- `.gr-btn`: default height `var(--control-md)` and 14px padding, 14px text; xs padding 8px; sm padding 10px, gap 6px, 13px text; md padding 14px; lg padding 16px; xl padding 20px, 15px text; the Kbd inside a button 18px (the small Kbd).
- Fields: `.gr-field` gap 8px; `.gr-label` 14px; `.gr-help` 13px on 18px; `.gr-input` padding 12px and 14px text; textarea `min-height: 112px`, padding 10px 12px, line height 22px; the input icon at 12px left, centred, with 36px start padding; `.gr-otp-group` gap 8px; `.gr-otp-cell` 44 by 52px; `.gr-select` start padding 12px and 14px text.
- Menus: `.gr-popover` min width 240px; `.gr-menu-item` height `var(--menu-item-height)`, gap 10px, padding 0 10px, 14px; shortcuts 13px; group headings 12px with 8px above and 6px below; separators 6px margin.
- Command: input 56px tall with 20px padding; list padding 6px; results 40px; a new `.gr-command-footer` (12px by 20px, 13px).
- Dialog: padding 28px; description 8px below the title at 22px line height; footer 24px above; drawer side padding 28px.
- Tooltip: padding 6px 10px, 13px on 18px; its Kbd 18px.
- Toast: padding 16px, gap 12px.
- Card: padding `var(--card-padding)`, `--radius-3xl`, 20px gap between blocks; title 16px weight 600 with heading tracking; description 4px below at 13px.
- CodeCard: header 13px; `pre` padding 16px 20px, line height 22px.
- Badge: height 24px, padding 0 8px (the pill variant keeps 8px).
- Kbd: minimum 22px; a new `.gr-kbd-sm` at 18px.
- Avatar: sizes 20, 28, 32 and 40px (`.gr-avatar-24` becomes `.gr-avatar-28`).
- Tabs: gap 24px; tab 44px tall, 14px.
- Checkbox and radio: 18px; check icon 14px; row gap 10px, 14px text, at least 28px tall.
- Switch: 36 by 20px, 16px thumb, travelling 16px.
- Table: 14px; `th` height `var(--table-header-height)`, padding 0 16px, 13px medium, no uppercase or tracking, `secondary-foreground`; `td` height `var(--table-row-height)`, padding 0 16px; a new `.gr-table td .gr-sub` second line (13px, `tertiary-foreground`, 2px above).
- Accordion: summary 52px; panel bottom padding 16px, 22px line height.
- Breadcrumb: gap 8px, 14px.

### `tokens.json`

- Type styles: `heading-1` line height 60px; `body-lg` 18/28; `body-base` 16/24; `body-sm` 14/20; `caption-lg` 13/18; `caption-base` 12/16; `caption-sm` 11/16; `caption-xs` 10/12; `code-sm` line height 22px; `caption-upper` 12px.
- Spacing: add `space` (4px), `space-20` (80px) and `space-24` (96px).
- Size: `control-xs` 24, `control-sm` 28, `control-md` 32, `control-lg` 36, `control-xl` 44; the note says text is 12, 13, 14, 14 and 15px from xs to xl.
- A new top-level `layout` group with `sidebar-width` 260px, `nav-item-height` 36px, `content-max` 1120px, `card-padding` 24px, `grid-gap` 24px, `section-gap` 80px, `table-row-height` 56px, `table-header-height` 44px, `menu-item-height` 36px, each with a usage line from `DESIGN.md`.
- Usage strings: no "dense", no uppercase table headers, labels 14px, badges `caption-base`, card padding 24px, form gap 20px, dialog padding 28px, section gap 80px, code block padding 16 by 20px, cards on `radius-3xl`.
- Every value equals `graphite-tokens.css`; colour, radius, shadow, weight, tracking, duration and easing entries are untouched.

## Docs that follow (written with the design draft)

- `docs/adr/0045-graphite-at-comfortable-density-on-every-ui.md` (new).
- `docs/adr/0018-...md`: its Status line notes the sidebar width is superseded by ADR 0045.
- `specs/roadmap.md`: item 13a under Product.
- `specs/tech-stack.md`: the `Graphite Design/` line says app work never edits `DESIGN.md` or `graphite-tokens.css` and may align the other files with them (ADR 0045).
