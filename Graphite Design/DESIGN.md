# Graphite design system

Graphite is a design system for dense, calm product UI. It's monochrome first, with one blue accent, hairline edges and small type. Light is the default theme and dark is fully supported.

This file is written for coding agents and for people. If you're an agent building UI, read the rules in "How to use this file" first, then use the token file in Appendix A as the single source of truth for values.

Graphite is modeled on the public Interfere design system. Its raw palette is [Radix Colors](https://github.com/radix-ui/colors) (MIT license), and the semantic layer, type scale, radius, elevation and button specs follow the Interfere source. Appendix B lists every place Graphite differs from it.

## How to use this file

1. Paste Appendix A into your global stylesheet. Every value in this file comes from those tokens.
2. Style components with semantic tokens only, such as `var(--color-primary-foreground)`. Never write raw hex in a component, and never reach for a palette step like `--gray-11` when a semantic token exists.
3. Light is the default. Add `class="dark"` or `data-theme="dark"` to `<html>` for dark. Both themes use the same token names, so components never branch on theme.
4. Pair every fill with its text token. A `--color-x-solid` fill always takes `--color-on-x-solid-foreground` text, and a `--color-x-subtle` fill takes `--color-on-x-subtle-foreground`.
5. Icons come from Lucide or Phosphor. No emojis anywhere in the UI, including empty states, toasts and buttons.
6. When this file doesn't cover a case, pick the option that adds the least visual weight.

## Principles

**Monochrome first.** The primary button is black in light mode and white in dark. Blue is reserved for brand moments, links, focus rings and selection. If a screen has more than one or two blue things on it, something is wrong.

**Dense and quiet.** UI text is 13px and body copy is 15px. Hierarchy comes from weight, color and spacing, not from size jumps or decoration.

**Transparency over fixed grays.** Fills, borders and secondary text use alpha steps, such as black at 6% for a border. The same token then looks right on white, on a card, or inside a modal.

**Depth from surfaces, not shadows.** Layering comes from the surface tokens plus hairline rings. Shadows stay soft, and dark mode swaps drop shadows for a faint inner highlight.

**Every fill brings its text color.** The `on-*` tokens settle contrast once, in the system, so screens never have to.

## Setup

### Fonts

| Role | Graphite font | Replaces | License | Use |
|---|---|---|---|---|
| Sans | Inter (variable) | Inter Variable | OFL, free | All UI and body text |
| Mono | Geist Mono | Berkeley Mono | OFL, free | Code, keyboard keys, IDs, numbers in tables |
| Serif | Newsreader | Heldane Text | OFL, free | Display headlines and pull quotes only |
| Pixel | Departure Mono | Departure Mono | OFL, free | Tiny accents like timers and counters, optional |

```html
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400..600&family=Geist+Mono:wght@400..600&family=Newsreader:opsz,wght@6..72,400..700&display=swap" rel="stylesheet">
```

Departure Mono isn't on Google Fonts. Self-host it from its official site if you need it, or let `--font-pixel` fall back to the mono font.

For the full Inter feature set, you can load `https://rsms.me/inter/inter.css` instead and use the family name `InterVariable`, which is already in the `--font-sans` stack.

### Base styles

```css
html, body { height: 100%; }
body {
  margin: 0;
  background: var(--color-shell);
  color: var(--color-primary-foreground);
  font-family: var(--font-sans);
  font-size: var(--text-body-base);
  line-height: var(--leading-body-base);
  font-feature-settings: "ss03";
  font-synthesis: none;
  text-rendering: optimizeLegibility;
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
}
:focus-visible {
  outline: 1px solid var(--color-brand-border-focus);
  outline-offset: -1px;
}
```

### Theme switching

```html
<script>
  // Before first paint. Light unless the user chose dark or their OS prefers it.
  (function () {
    var saved = null;
    try { saved = localStorage.getItem('theme'); } catch (e) {}
    var dark = saved ? saved === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
    document.documentElement.classList.toggle('dark', dark);
  })();
</script>
```

Offer a System / Light / Dark control in settings. "System" clears the saved value.

### App layout model

- `shell` is the app frame. The sidebar sits directly on it with no fill of its own.
- `container` is the main content panel. Inset it 8px from the shell edges, give it `--radius-2xl` and `--shadow-border`.
- `page` is for full-bleed screens with no shell, such as docs, auth and marketing.
- `modal` floats above everything. In dark mode it's the lightest surface, so depth reads as "closer is lighter".

## Color

### Palette

Graphite uses five Radix Colors scales: gray, blue, green, orange and tomato. Each has 12 solid steps and 12 alpha steps, with separate light and dark values. Fixed black and white alpha scales round it out.

| Steps | Purpose |
|---|---|
| 1 to 2 | App and subtle backgrounds |
| 3 to 5 | Component fills: idle, hover, pressed |
| 6 to 8 | Borders: subtle, default, strong |
| 9 to 10 | Solid fills and their hover |
| 11 | Low-contrast text |
| 12 | High-contrast text |

Brand is blue 9 (`#0090ff`). Positive is green, warning is orange, danger is tomato. Gray is pure neutral with no tint.

For avatars, labels and chart series you can add more hues from the `@radix-ui/colors` package: indigo, iris, violet, purple, plum, pink, crimson, red, amber, gold, grass and cyan. Use step 3 as the fill and step 11 as the text for tags and avatars, and step 9 for chart lines and dots.

### Semantic tokens

Values below are what each token resolves to. "black at 6%" means the token is transparent black, so the visible color depends on what's behind it.

### Surfaces

| Token | Light | Dark | Use |
|---|---|---|---|
| `--color-page` | `#ffffff` | `#0b0b0b` | Full-page background for docs, marketing and auth screens |
| `--color-shell` | `#f6f6f6` | `#000000` | App frame behind the sidebar and main panel |
| `--color-container` | `#ffffff` | `#111111` (gray-1) | Main content panel that sits inside the shell |
| `--color-container-recessed` | `#fcfcfc` (gray-1) | `#111111` (gray-1) | Slightly recessed panel inside a container |
| `--color-card` | `black at 2.4%` (gray-a2) | `white at 3.5%` (gray-a2) | Tinted card or grouped block on a container |
| `--color-sunken` | `black at 5.1%` (black-a1) | `black at 40%` (black-a6) | Wells and tracks, such as a segmented control track or code block |
| `--color-modal` | `#ffffff` | `#222222` | Dialogs, popovers, menus, toasts |
| `--color-overlay` | `black at 30.2%` (black-a5) | `black at 50.2%` (black-a7) | Scrim behind dialogs and drawers |
| `--color-standout` | `#202020` (gray-12) | `#222222` (gray-3) | Inverted chip, such as a tooltip or a highlight banner |

### Component fills

| Token | Light | Dark | Use |
|---|---|---|---|
| `--color-component` | `black at 5.9%` (gray-a3) | `white at 7.1%` (gray-a3) | Default fill for tertiary buttons, chips, inline code |
| `--color-component-hover` | `black at 9%` (gray-a4) | `white at 10.6%` (gray-a4) | Hover state of component |
| `--color-component-active` | `black at 12.2%` (gray-a5) | `white at 13.3%` (gray-a5) | Pressed or selected state of component |
| `--color-component-on-sunken` | `#ffffff` | `#2a2a2a` (gray-4) | Raised item inside a sunken track, such as the active segment |
| `--color-component-on-inverted` | `white at 10.2%` (white-a2) | `black at 10.2%` (black-a2) | Fill on top of an inverted or standout surface |
| `--color-component-on-container-subtle` | `#ffffff` | `white at 3.5%` (gray-a2) | Quiet field fill on a container |
| `--color-component-on-container-strong` | `#ffffff` | `white at 7.1%` (gray-a3) | Secondary button and input fill |
| `--color-component-on-container-strong-hover` | `#f9f9f9` (gray-2) | `white at 10.6%` (gray-a4) | Hover state of the above |
| `--color-transparent-hover` | `black at 5.9%` (gray-a3) | `white at 10.6%` (gray-a4) | Hover fill for ghost buttons, menu items, table rows |
| `--color-transparent-active` | `black at 5.9%` (gray-a3) | `white at 7.1%` (gray-a3) | Pressed fill for ghost elements |
| `--color-disabled` | `black at 5.9%` (gray-a3) | `white at 3.5%` (gray-a2) | Fill of disabled filled controls |

### Text

| Token | Light | Dark | Use |
|---|---|---|---|
| `--color-primary-foreground` | `black at 87.5%` (gray-a12) | `white at 92.9%` (gray-a12) | Headings and body text |
| `--color-secondary-foreground` | `black at 60.8%` (gray-a11) | `white at 68.6%` (gray-a11) | Supporting text, labels, idle icons |
| `--color-tertiary-foreground` | `black at 44.7%` (gray-a9) | `white at 39.2%` (gray-a9) | Meta only: timestamps, placeholders, hints. Not for body |
| `--color-disabled-foreground` | `black at 26.7%` (gray-a8) | `white at 33.3%` (gray-a8) | Disabled controls only |
| `--color-brand-foreground` | `#006dcb at 94.9%` (blue-a11) | `#3b9eff` (blue-a10) | Links and brand-tinted text |
| `--color-positive-foreground` | `#00713f at 87.1%` (green-a11) | `#43fea4 at 67.1%` (green-a10) | Success text |
| `--color-warning-foreground` | `#cc4e00` (orange-a11) | `#ff801f` (orange-a10) | Warning text |
| `--color-danger-foreground` | `#cd2200 at 91.8%` (tomato-a11) | `#ff6847 at 92.2%` (tomato-a10) | Error text and destructive links |

### Brand and status fills

| Token | Light | Dark | Use |
|---|---|---|---|
| `--color-brand-solid` | `#0090ff` (blue-9) | `#0090ff` (blue-9) | Brand button, selected checkbox, switch on, progress |
| `--color-brand-solid-hover` | `#0588f0` (blue-10) | `#3b9eff` (blue-10) |  |
| `--color-brand-subtle` | `#008ff5 at 9.8%` (blue-a3) | `#0077ff at 22.7%` (blue-a3) | Brand-tinted badge, selected row, info banner |
| `--color-on-brand-solid-foreground` | `#ffffff` | `#ffffff` | Text on brand-solid |
| `--color-on-brand-subtle-foreground` | `#006dcb at 94.9%` (blue-a11) | `#70b8ff` (blue-a11) | Text on brand-subtle |
| `--color-positive-solid` | `#30a46c` (green-9) | `#30a46c` (green-9) | Success indicator, live dot |
| `--color-positive-subtle` | `#00a433 at 9.8%` (green-a3) | `#22ff99 at 11.8%` (green-a3) | Success badge or banner |
| `--color-on-positive-subtle-foreground` | `#00713f at 87.1%` (green-a11) | `#46fea5 at 83.1%` (green-a11) | Text on positive-subtle |
| `--color-warning-solid` | `#f76b15` (orange-9) | `#f76b15` (orange-9) | Warning indicator |
| `--color-on-warning-solid-foreground` | `#202020` (gray-12) | `#111111` | Text on warning-solid |
| `--color-warning-subtle` | `#ff9c00 at 16.1%` (orange-a3) | `#fb6a00 at 14.5%` (orange-a3) | Warning badge or banner |
| `--color-on-warning-subtle-foreground` | `#cc4e00` (orange-a11) | `#ffa057` (orange-a11) | Text on warning-subtle |
| `--color-danger-solid` | `#e54d2e` (tomato-9) | `#e54d2e` (tomato-9) | Destructive button |
| `--color-danger-subtle` | `#ff2000 at 3.1%` (tomato-a2) | `#ff5533 at 5.9%` (tomato-a2) | Error badge, banner, destructive-subtle button |
| `--color-on-danger-solid-foreground` | `#fffcfc` (tomato-1) | `#ffffff` | Text on danger-solid |
| `--color-on-danger-subtle-foreground` | `#cd2200 at 91.8%` (tomato-a11) | `#ff977d` (tomato-a11) | Text on danger-subtle |

### Inverted

| Token | Light | Dark | Use |
|---|---|---|---|
| `--color-inverted-solid` | `black at 94.9%` (black-a12) | `white at 94.9%` (white-a12) | Primary button fill |
| `--color-inverted-solid-hover` | `black at 80%` (black-a10) | `white at 80%` (white-a10) |  |
| `--color-inverted-solid-active` | `black at 70.2%` (black-a9) | `white at 70.2%` (white-a9) |  |
| `--color-on-inverted-foreground` | `#ffffff` | `#000000` | Text on the primary button |
| `--color-on-standout-primary-foreground` | `#ffffff` | `white at 92.9%` (gray-a12) | Main text on standout |
| `--color-on-standout-secondary-foreground` | `white at 50.2%` (white-a7) | `white at 50.2%` (white-a7) | Secondary text on standout |

### Borders

| Token | Light | Dark | Use |
|---|---|---|---|
| `--color-border-default` | `black at 5.9%` (gray-a3) | `white at 7.1%` (gray-a3) | Dividers, input and card edges |
| `--color-border-subtle` | `black at 2.4%` (gray-a2) | `white at 3.5%` (gray-a2) | Quiet dividers inside cards and tables |
| `--color-border-strong` | `black at 14.9%` (gray-a6) | `white at 17.3%` (gray-a6) | Emphasised edges, checkbox and radio outlines |
| `--color-border-inverted` | `#000000` | `#ffffff` | Edge in the opposite tone |
| `--color-border-control` | `black at 44.7%` (gray-a9) | `white at 39.2%` (gray-a9) | Unchecked checkbox and radio outlines, 3:1 or better |
| `--color-brand-border-focus` | `#0588f0` (blue-10) | `#0090ff` (blue-a9) | Focus ring |
| `--color-brand-border-default` | `#0088f6 at 32.5%` (blue-a6) | `#0f89fd at 49.8%` (blue-a6) | Selected card or brand-tinted outline |
| `--color-positive-border-default` | `#00963c at 32.2%` (green-a6) | `#44ffaa at 29.4%` (green-a6) | Success outline |
| `--color-warning-border-default` | `#ff8100 at 49%` (orange-a6) | `#fd7504 at 36.1%` (orange-a6) | Warning outline |
| `--color-danger-border-default` | `#f92d00 at 31.4%` (tomato-a6) | `#ff4f38 at 39.2%` (tomato-a6) | Error outline on inputs |

Every family also has `-hover` and `-active` variants and `-subtle-hover` / `-subtle-active` fills. They're in Appendix A.

### Color rules

- Body text is `primary-foreground`. Labels and supporting copy are `secondary-foreground`.
- `tertiary-foreground` is 3.3:1 on white. Use it for timestamps, placeholders and hints, never for anything a user must read to complete a task.
- Status badges and inline alerts use the subtle fill with its `on-*-subtle` text. Save solid status fills for small indicators and destructive buttons.
- Links are `brand-foreground`, medium weight, no underline until hover.
- Selection states use brand: checked checkboxes, switches that are on, the selected row tint (`brand-subtle`).
- Don't put text on `card` that relies on the card for contrast. Cards are a 2 to 4% tint, so treat them as transparent.
- White on `brand-solid`, `danger-solid` and `positive-solid` measures 3.1 to 3.9:1. That passes for UI components and large text. For important 13px labels, prefer the primary button.

## Typography

### Scale

All sizes derive from a 4px base. Headings use -0.01em tracking.

| Style | Token | Size | Line height | Default weight |
|---|---|---|---|---|
| Heading 1 | `--text-heading-1` | 56px | 56px | 500 |
| Heading 2 | `--text-heading-2` | 44px | 56px | 500 |
| Heading 3 | `--text-heading-3` | 36px | 44px | 500 |
| Heading 4 | `--text-heading-4` | 28px | 36px | 500 |
| Heading 5 | `--text-heading-5` | 24px | 32px | 600 |
| Heading 6 | `--text-heading-6` | 20px | 24px | 600 |
| Body large | `--text-body-lg` | 18px | 24px | 400 |
| Body base | `--text-body-base` | 15px | 24px | 400 |
| Body small | `--text-body-sm` | 13px | 20px | 400 |
| Caption large | `--text-caption-lg` | 12px | 16px | 400 |
| Caption base | `--text-caption-base` | 11px | 16px | 400 |
| Caption small | `--text-caption-sm` | 10px | 16px | 400 |
| Caption extra small | `--text-caption-xs` | 8px | 12px | 500 |
| Code small | `--text-code-sm` | 13px | 20px | 400 |
| Code extra small | `--text-code-xs` | 12px | 16px | 400 |

### Weights

| Name | Value | Use |
|---|---|---|
| Regular | 400 | Body text, descriptions |
| Semimedium | 450 | Nav items, list titles, table cells that need a touch more presence |
| Medium | 500 | Buttons, labels, tabs, large headings |
| Semibold | 600 | Small headings, numbers in stat tiles |

There's no bold in the sans. Weight 700 only exists for the serif.

### Type rules

- Product UI runs on body small (13px). Body base (15px) is for reading: docs, descriptions, long-form settings help.
- Uppercase captions take medium weight and `--tracking-caption-upper` (0.05em). Use them for group headings in menus and sidebars.
- Use `font-variant-numeric: tabular-nums` for tables, timers and anything that updates in place.
- The serif is for display moments only, at Heading 3 or larger. Never use it in controls.
- The pixel font is for tiny accents, such as a "1m 34s" timer. Never set a sentence in it.
- Keep line length between 60 and 75 characters for body base.

## Spacing and layout

The base unit is 4px. Use these steps, available as `--space-1` through `--space-16` where the number is the multiple of 4: 4, 8, 12, 16, 20, 24, 32, 40, 48, 64.

| Context | Value |
|---|---|
| Gap between an icon and its label | 4 to 8px, matching the button size |
| Padding inside cards | 16px, or 20px for roomy cards |
| Gap between form fields | 16px |
| Gap between page sections | 32 to 48px |
| Container inset from shell | 8px |
| Sidebar width | 240px |

Content widths come from the source container scale: 320, 384, 448, 512, 576, 672 and 768px. Dialogs use 448 or 512. Forms and settings pages cap at 672.

## Radius

| Token | Value | Use |
|---|---|---|
| `--radius-xs` | 2px | Tiny indicators, progress bars |
| `--radius-sm` | 4px | Keyboard keys, inline code, checkboxes |
| `--radius-md` | 6px | Badges, small inputs, kbd inside buttons |
| `--radius-lg` | 8px | Buttons, inputs, menu items, tooltips |
| `--radius-xl` | 10px | Extra-large icon buttons, segmented tracks |
| `--radius-2xl` | 12px | Cards, popovers, menus, toasts, the main container |
| `--radius-3xl` | 16px | Dialogs, drawers, large cards |
| `--radius-4xl` | 20px | Feature panels |
| `--radius-5xl` | 24px | Hero panels, marketing cards |
| `--radius-full` | 9999px | Pills, avatars, switches |

When one rounded element sits inside another, the inner radius equals the outer radius minus the padding between them. A menu with 12px radius and 4px padding gets 8px items.

## Elevation

| Token | Light | Dark | Use |
|---|---|---|---|
| `--shadow-border` | 1px ring, black at 7% | 1px ring, white at 7% | Hairline edge on containers and cards in place of a CSS border |
| `--shadow-default` | 0.5px ring plus a 1 to 2px soft drop | 0.5px inner white highlight at 7% | Secondary buttons, inputs, small raised items |
| `--shadow-large` | 0.5px ring plus layered drops up to 16px | 1px ring plus deeper dark drops | Menus, popovers, selects, toasts |
| `--shadow-xl` | 0.5px ring plus a wide 40px drop | Inner highlight plus wide drop | Dialogs, drawers, command palette |

Edges come from box-shadow rings, not borders, so they never change an element's size. Dark mode drops most of the dark shadows, because shadows don't read on black. A faint inner highlight defines the edge instead.

## Motion

| Token | Value | Use |
|---|---|---|
| `--duration-fast` | 150ms | Color and background changes |
| `--duration-base` | 200ms | Transforms, chevrons, small reveals |
| `--ease-out` | cubic-bezier(0, 0, 0.2, 1) | Default for state changes |
| `--ease-out-quint` | cubic-bezier(0.23, 1, 0.32, 1) | Popovers and dialogs entering |
| `--ease-in-out` | cubic-bezier(0.4, 0, 0.2, 1) | Things that move and come back |

- Buttons shrink to 97% while pressed, over 200ms.
- Popovers and menus enter with opacity 0 to 1 and scale 0.95 to 1, 150ms, origin at the trigger.
- Wrap transitions in `@media (prefers-reduced-motion: no-preference)`. With reduced motion, keep color fades and drop all transforms.
- Wrap hover styles in `@media (hover: hover)` so touch devices don't get stuck hover states.
- Skeletons use a shimmer: a gradient sliding from 200% to -200% background position over 1.5s.
- Live indicators "breathe" between opacity 1 and 0.55 over 2s.

## Focus and accessibility

- Every interactive element shows a 1px `brand-border-focus` outline on `:focus-visible`. It's blue 10 in light and blue 9 in dark, which keeps it at 3:1 or better on every surface. Inputs draw it inset with `outline-offset: -1px`. Buttons with a solid fill add a 2px ring offset in `--color-container` so the ring stays visible.
- The tokens include a `prefers-contrast: more` block. When the OS asks for more contrast, secondary and tertiary text go to full strength and borders darken. Don't override it.
- Measured contrast in light mode: primary text 16.3:1, secondary 5.9:1, brand text 4.8:1, danger text 5.0:1, tertiary 3.3:1. Dark mode is higher across the board.
- Minimum hit target is 24px. On touch layouts, use the 40px button size for primary actions.
- Icon-only buttons need an `aria-label` and a tooltip.

## Iconography

- Use Lucide by default. Phosphor is fine if a project already uses it, but don't mix the two on one screen.
- Stroke width 1.5 at 16px and below, 1.75 at 20px.
- Icons inherit `currentColor`. Idle icons sit in `secondary-foreground`, and turn `primary-foreground` on hover.
- Icon size follows the control: 12px in extra-small buttons, 14px in small, 16px in medium and large, 20px in extra large.
- No emojis in the interface. Use an icon or plain text.

## Components

### Button

All buttons share one structure: flex, centered, medium weight, 13px text, no wrapping, label truncates with an ellipsis.

| Variant | Fill | Text | Hover fill | Use |
|---|---|---|---|---|
| Primary | `inverted-solid` | `on-inverted-foreground` | `inverted-solid-hover` | The one main action on a screen |
| Secondary | `component-on-container-strong` plus `--shadow-default` | `primary-foreground` | `component-on-container-strong-hover` | Most other actions |
| Tertiary | `component` | `secondary-foreground` | `component-hover` | Toolbar actions, low-emphasis actions |
| Brand | `brand-solid` | `on-brand-solid-foreground` | `brand-solid-hover` | Upgrade, connect, brand moments. One per screen at most |
| Danger | `danger-solid` | `on-danger-solid-foreground` | `danger-solid-hover` | Confirming a destructive action |
| Danger subtle | `danger-subtle` | `danger-foreground` | `danger-subtle-hover` | Starting a destructive action, such as "Delete" before the confirm |
| Transparent | none | `secondary-foreground`, `primary-foreground` on hover | `transparent-hover` | Icon buttons, nav, inline actions |
| Link | none | `brand-foreground` | text only | Inline actions in text |

| Size | Height | Side padding | Gap | Icon | Text |
|---|---|---|---|---|---|
| Extra small | 20px | 6px | 4px | 12px | 12px |
| Small | 24px | 8px | 4px | 14px | 13px |
| Medium | 28px | 10px | 6px | 16px | 13px |
| Large | 32px | 12px | 6px | 16px | 13px |
| Extra large | 40px | 14px | 8px | 20px | 13px |

- Shapes: rounded uses `--radius-lg` (8px). Pill uses `--radius-full`. Extra-large icon-only buttons use 10px.
- When a button starts with an icon, reduce the start padding by the icon offset (2 to 4px) so the visual padding looks even. Same for a trailing icon.
- Icon-only buttons are square, width equal to height.
- Pending state: swap the leading icon for a spinner, keep the label, keep the width, and block clicks.
- Disabled: `disabled` fill and `disabled-foreground` text with `cursor: not-allowed`. Transparent buttons stay transparent.
- A keyboard hint can sit inside a button, on the right, using the Kbd component at 16px.

### Input and textarea

- Height 32px by default, 28px in dense toolbars. Side padding 10px. Radius `--radius-lg`.
- Fill `component-on-container-strong` plus `--shadow-default`. Text `primary-foreground` at 13px. Placeholder `tertiary-foreground`.
- Focus: inset 1px ring in `brand-border-focus`.
- Error: inset ring in `danger-border-default`, with a helper line below in `danger-foreground` at 12px.
- Textarea uses the same styling with 8px vertical padding and a minimum of 3 rows.
- Labels sit above at 13px medium in `primary-foreground`. Helper text below at 12px in `secondary-foreground`.

### Input OTP

- Cells are 40 by 44px, radius `--radius-lg`, with the input fill and `--shadow-default`. Digits are mono at 18px with tabular numbers.
- Group cells in threes with an 8px `border-strong` dash between groups.
- The cell where the next digit goes shows the inset `brand-border-focus` ring.
- Back the cells with one real input (`autocomplete="one-time-code"`, `inputmode="numeric"`) so paste and autofill work.

### Select, combobox, menu, context menu, popover

- Surface `modal`, `--shadow-large`, radius `--radius-2xl`, 4px padding.
- Items are 32px tall, 8px side padding, radius `--radius-lg`, 13px text.
- Highlighted item gets `transparent-hover`. Checked items show a 16px check icon on the left.
- Group headings use uppercase caption base in `tertiary-foreground`.
- Shortcuts sit right-aligned in `tertiary-foreground`.
- Separators are 1px `border-subtle` with 4px vertical margin.

### Command palette

- Surface `modal`, `--shadow-xl`, radius `--radius-3xl`, width 640px, opened with Cmd+K or Ctrl+K.
- Search input is 48px tall with no ring, separated from results by a 1px `border-subtle`.
- Results follow the menu item spec at 36px tall.

### Dialog and drawer

- Overlay is `--color-overlay`: black at 30% in light and 50% in dark.
- Dialog: surface `modal`, `--shadow-xl`, radius `--radius-3xl`, 20px padding, width 448 or 512px.
- Title is Heading 6 at weight 600. Description is body small in `secondary-foreground`.
- Footer buttons are right-aligned, large size, with the primary or danger action last.
- Drawer: same surface. On mobile it's a bottom sheet with 16px top corners and a 32 by 4px grab handle in `border-strong`.

### Card

- Fill `container` with `--shadow-border`, radius `--radius-2xl`, 16px padding.
- Use `card` fill instead of the ring when grouping content inside a container.
- A card title is 13px medium, its description 13px regular in `secondary-foreground`.

### Code card and inline code

- Inline code: mono at 13px, `component` fill, 4px radius, 2px by 4px padding.
- Code blocks: `sunken` fill, `--radius-2xl`, 12px by 16px padding, mono 13px at 20px line height, horizontal scroll, never wrap.
- Header row with filename in caption large and a copy button (transparent, small, icon-only).

### Badge

- Height 20px, 6px side padding, caption large (12px) medium, radius `--radius-md` or `--radius-full`.
- Neutral: `component` fill, `secondary-foreground` text.
- Status: subtle fill with its `on-*-subtle` text. An optional 6px dot in the solid color goes before the label.

### Kbd

- Mono at 12px, `component` fill, `secondary-foreground` text, radius `--radius-sm`.
- Minimum width and height 20px, centered.
- Show modifier symbols on macOS (⌘ ⌥ ⇧) and words elsewhere (Ctrl, Alt, Shift).

### Avatar and avatar group

- Circular. Sizes 20, 24, 32 and 40px. Initials in medium weight at about 40% of the avatar size.
- Without a photo, fill with step 3 of a hue picked from the user's ID and set initials in step 11 of the same hue.
- Groups overlap by about a fifth of the size. Separate them with a mask cutout, not a colored ring, so the edge works on any background. Show overflow as "+5" in a neutral avatar.

### Tabs and segmented control

- Underline tabs: 13px medium, `secondary-foreground` idle, `primary-foreground` active, with a 2px `inverted-solid` bar under the active tab.
- Segmented control: `sunken` track with radius `--radius-xl` and 2px padding. The active segment uses `component-on-sunken` with `--shadow-default` and radius `--radius-lg`.

### Checkbox, radio and switch

- Checkbox: 16px, radius `--radius-sm`, 1px `border-control` ring when unchecked. Checked fills with `brand-solid` and shows a white check icon.
- Radio: 16px circle, same states, with a 6px white dot when selected.
- Switch: 32 by 18px pill. Track `component-active` when off and `brand-solid` when on. White 14px thumb with `--shadow-default`, moving over 150ms. Disabled switches use the `disabled` track and a `disabled-foreground` thumb.

### Tooltip

- Surface `standout` with a 1px inset `border-on-standout` ring, text `on-standout-primary-foreground`, 12px, radius `--radius-lg`, 4px by 8px padding.
- Opens after 500ms, closes immediately. Sits 6px from the trigger.
- Keyboard shortcuts inside a tooltip use `on-standout-secondary-foreground`.

### Toast

- Surface `modal`, `--shadow-large`, radius `--radius-2xl`, width 360px, bottom right on desktop and bottom center on mobile.
- Title 13px medium, description 13px in `secondary-foreground`. A 16px status icon on the left in the status foreground color.
- Auto-dismiss after 4 seconds, pause on hover.

### Table

- Header row: caption base (11px) uppercase medium, `tertiary-foreground`, 32px tall.
- Body rows: 13px, 40px tall, 1px `border-subtle` dividers, `transparent-hover` on hover.
- Numbers right-aligned and tabular. IDs and hashes in mono.

### Accordion and collapsible

- Trigger is 13px medium with a 16px chevron on the right that rotates 180 degrees over 200ms.
- Panel content is 13px in `secondary-foreground` with 12px bottom padding.

### Breadcrumb

- 13px. Ancestors in `secondary-foreground`, current page in `primary-foreground` medium.
- Separator is a "/" in `tertiary-foreground` with 6px space either side.

### Skeleton, spinner and divider

- Skeleton: `component` fill with the shimmer animation, radius matching the content it replaces.
- Spinner: a 16px ring arc in `currentColor`, one turn per 800ms, linear.
- Divider: 1px `border-default`. Use `border-subtle` inside cards.

### Scroll area

- 6px thumb in `--gray-a6`, rounded, visible on hover or while scrolling.
- Fade the content 16px at any edge that has more to scroll, using a mask gradient.

## Do and don't

| Do | Don't |
|---|---|
| Use one primary button per screen | Line up three solid buttons in a row |
| Get hierarchy from weight and color | Jump to big type sizes in product UI |
| Use alpha tokens for borders and fills | Hardcode a gray like `#e5e5e5` |
| Use rings for edges | Add CSS borders that shift layout by 1px |
| Keep blue for links, focus, selection and one brand action | Tint backgrounds or headings blue |
| Use Lucide or Phosphor icons | Use emojis in the interface |
| Test every screen in both themes | Design light only and invert later |

## Appendix A: tokens.css

```css
/* Graphite tokens. Palette: Radix Colors (MIT). Light is the default theme; add class="dark" or data-theme="dark" on <html> for dark. */
:root, .light, [data-theme="light"] {
  color-scheme: light;
  /* gray */
  --gray-1: #fcfcfc; --gray-2: #f9f9f9; --gray-3: #f0f0f0; --gray-4: #e8e8e8; --gray-5: #e0e0e0; --gray-6: #d9d9d9; --gray-7: #cecece; --gray-8: #bbbbbb; --gray-9: #8d8d8d; --gray-10: #838383; --gray-11: #646464; --gray-12: #202020;
  --gray-a1: #00000003; --gray-a2: #00000006; --gray-a3: #0000000f; --gray-a4: #00000017; --gray-a5: #0000001f; --gray-a6: #00000026; --gray-a7: #00000031; --gray-a8: #00000044; --gray-a9: #00000072; --gray-a10: #0000007c; --gray-a11: #0000009b; --gray-a12: #000000df;
  /* blue */
  --blue-1: #fbfdff; --blue-2: #f4faff; --blue-3: #e6f4fe; --blue-4: #d5efff; --blue-5: #c2e5ff; --blue-6: #acd8fc; --blue-7: #8ec8f6; --blue-8: #5eb1ef; --blue-9: #0090ff; --blue-10: #0588f0; --blue-11: #0d74ce; --blue-12: #113264;
  --blue-a1: #0080ff04; --blue-a2: #008cff0b; --blue-a3: #008ff519; --blue-a4: #009eff2a; --blue-a5: #0093ff3d; --blue-a6: #0088f653; --blue-a7: #0083eb71; --blue-a8: #0084e6a1; --blue-a9: #0090ff; --blue-a10: #0086f0fa; --blue-a11: #006dcbf2; --blue-a12: #002359ee;
  /* green */
  --green-1: #fbfefc; --green-2: #f4fbf6; --green-3: #e6f6eb; --green-4: #d6f1df; --green-5: #c4e8d1; --green-6: #adddc0; --green-7: #8eceaa; --green-8: #5bb98b; --green-9: #30a46c; --green-10: #2b9a66; --green-11: #218358; --green-12: #193b2d;
  --green-a1: #00c04004; --green-a2: #00a32f0b; --green-a3: #00a43319; --green-a4: #00a83829; --green-a5: #019c393b; --green-a6: #00963c52; --green-a7: #00914071; --green-a8: #00924ba4; --green-a9: #008f4acf; --green-a10: #008647d4; --green-a11: #00713fde; --green-a12: #002616e6;
  /* orange */
  --orange-1: #fefcfb; --orange-2: #fff7ed; --orange-3: #ffefd6; --orange-4: #ffdfb5; --orange-5: #ffd19a; --orange-6: #ffc182; --orange-7: #f5ae73; --orange-8: #ec9455; --orange-9: #f76b15; --orange-10: #ef5f00; --orange-11: #cc4e00; --orange-12: #582d1d;
  --orange-a1: #c0400004; --orange-a2: #ff8e0012; --orange-a3: #ff9c0029; --orange-a4: #ff91014a; --orange-a5: #ff8b0065; --orange-a6: #ff81007d; --orange-a7: #ed6c008c; --orange-a8: #e35f00aa; --orange-a9: #f65e00ea; --orange-a10: #ef5f00; --orange-a11: #cc4e00; --orange-a12: #431200e2;
  /* tomato */
  --tomato-1: #fffcfc; --tomato-2: #fff8f7; --tomato-3: #feebe7; --tomato-4: #ffdcd3; --tomato-5: #ffcdc2; --tomato-6: #fdbdaf; --tomato-7: #f5a898; --tomato-8: #ec8e7b; --tomato-9: #e54d2e; --tomato-10: #dd4425; --tomato-11: #d13415; --tomato-12: #5c271f;
  --tomato-a1: #ff000003; --tomato-a2: #ff200008; --tomato-a3: #f52b0018; --tomato-a4: #ff35002c; --tomato-a5: #ff2e003d; --tomato-a6: #f92d0050; --tomato-a7: #e7280067; --tomato-a8: #db250084; --tomato-a9: #df2600d1; --tomato-a10: #d72400da; --tomato-a11: #cd2200ea; --tomato-a12: #460900e0;
  /* fixed alphas, same in both themes */
  --black-a1: #0000000d; --black-a2: #0000001a; --black-a3: #00000026; --black-a4: #00000033; --black-a5: #0000004d; --black-a6: #00000066; --black-a7: #00000080; --black-a8: #00000099; --black-a9: #000000b3; --black-a10: #000000cc; --black-a11: #000000e6; --black-a12: #000000f2;
  --white-a1: #ffffff0d; --white-a2: #ffffff1a; --white-a3: #ffffff26; --white-a4: #ffffff33; --white-a5: #ffffff4d; --white-a6: #ffffff66; --white-a7: #ffffff80; --white-a8: #ffffff99; --white-a9: #ffffffb3; --white-a10: #ffffffcc; --white-a11: #ffffffe6; --white-a12: #fffffff2;
  /* semantic */
  --color-page: #ffffff;
  --color-shell: #f6f6f6;
  --color-container: #ffffff;
  --color-container-recessed: var(--gray-1);
  --color-modal: #ffffff;
  --color-overlay: var(--black-a5);
  --color-card: var(--gray-a2);
  --color-sunken: var(--black-a1);
  --color-standout: var(--gray-12);
  --color-component: var(--gray-a3);
  --color-component-hover: var(--gray-a4);
  --color-component-active: var(--gray-a5);
  --color-component-on-sunken: #ffffff;
  --color-component-on-inverted: var(--white-a2);
  --color-component-on-container-subtle: #ffffff;
  --color-component-on-container-subtle-hover: #ffffff;
  --color-component-on-container-strong: #ffffff;
  --color-component-on-container-strong-hover: var(--gray-2);
  --color-transparent: transparent;
  --color-transparent-hover: var(--gray-a3);
  --color-transparent-active: var(--gray-a3);
  --color-brand-solid: var(--blue-9);
  --color-brand-solid-hover: var(--blue-10);
  --color-brand-solid-active: var(--blue-11);
  --color-brand-subtle: var(--blue-a3);
  --color-brand-subtle-hover: var(--blue-a4);
  --color-brand-subtle-active: var(--blue-a5);
  --color-positive-solid: var(--green-9);
  --color-positive-solid-hover: var(--green-10);
  --color-positive-solid-active: var(--green-11);
  --color-positive-subtle: var(--green-a3);
  --color-positive-subtle-hover: var(--green-a4);
  --color-positive-subtle-active: var(--green-a5);
  --color-warning-solid: var(--orange-9);
  --color-warning-solid-hover: var(--orange-10);
  --color-warning-solid-active: var(--orange-11);
  --color-warning-subtle: var(--orange-a3);
  --color-warning-subtle-hover: var(--orange-a4);
  --color-warning-subtle-active: var(--orange-a5);
  --color-danger-solid: var(--tomato-9);
  --color-danger-solid-hover: var(--tomato-10);
  --color-danger-solid-active: var(--tomato-11);
  --color-danger-subtle: var(--tomato-a2);
  --color-danger-subtle-hover: var(--tomato-a3);
  --color-danger-subtle-active: var(--tomato-a5);
  --color-inverted-solid: var(--black-a12);
  --color-inverted-solid-hover: var(--black-a10);
  --color-inverted-solid-active: var(--black-a9);
  --color-disabled: var(--gray-a3);
  --color-primary-foreground: var(--gray-a12);
  --color-secondary-foreground: var(--gray-a11);
  --color-secondary-foreground-solid: var(--gray-11);
  --color-tertiary-foreground: var(--gray-a9);
  --color-disabled-foreground: var(--gray-a8);
  --color-brand-foreground: var(--blue-a11);
  --color-positive-foreground: var(--green-a11);
  --color-warning-foreground: var(--orange-a11);
  --color-danger-foreground: var(--tomato-a11);
  --color-on-inverted-foreground: #ffffff;
  --color-on-standout-primary-foreground: #ffffff;
  --color-on-standout-secondary-foreground: var(--white-a7);
  --color-border-on-standout: var(--white-a2);
  --color-on-brand-solid-foreground: #ffffff;
  --color-on-brand-subtle-foreground: var(--blue-a11);
  --color-on-positive-solid-foreground: var(--green-1);
  --color-on-positive-subtle-foreground: var(--green-a11);
  --color-on-warning-solid-foreground: var(--gray-12);
  --color-on-warning-subtle-foreground: var(--orange-a11);
  --color-on-danger-solid-foreground: var(--tomato-1);
  --color-on-danger-subtle-foreground: var(--tomato-a11);
  --color-border-default: var(--gray-a3);
  --color-border-subtle: var(--gray-a2);
  --color-border-strong: var(--gray-a6);
  --color-border-strong-solid: var(--gray-6);
  --color-border-inverted: #000000;
  --color-border-control: var(--gray-a9);
  --color-brand-border-default: var(--blue-a6);
  --color-brand-border-subtle: var(--blue-a5);
  --color-brand-border-focus: var(--blue-10);
  --color-positive-border-default: var(--green-a6);
  --color-positive-border-subtle: var(--green-a5);
  --color-warning-border-default: var(--orange-a6);
  --color-warning-border-subtle: var(--orange-a5);
  --color-danger-border-default: var(--tomato-a6);
  --color-danger-border-subtle: var(--tomato-a4);
  /* elevation */
  --shadow-border: 0 0 0 1px #00000012;
  --shadow-default: 0 0 0 0.5px #0000000f, 0 1px 1px -1px #0000001a, 0 1px 2px 0 #0000000d;
  --shadow-large: 0 0 0 0.5px var(--gray-a3), 0 2px 3px -2px var(--gray-a3), 0 3px 12px -4px var(--black-a2), 0 4px 16px -8px var(--black-a1);
  --shadow-xl: 0 0 0 0.5px #0000000f, 0 8px 40px 0 #0000000d, 0 12px 32px -16px #00000026;
  /* type */
  --font-sans: "Inter", "InterVariable", system-ui, -apple-system, "Segoe UI", sans-serif;
  --font-mono: "Geist Mono", ui-monospace, "SFMono-Regular", Menlo, monospace;
  --font-serif: "Newsreader", Georgia, "Times New Roman", serif;
  --font-pixel: "Departure Mono", var(--font-mono);
  --font-weight-regular: 400; --font-weight-semimedium: 450; --font-weight-medium: 500; --font-weight-semibold: 600;
  --text-heading-1: 56px; --leading-heading-1: 56px;
  --text-heading-2: 44px; --leading-heading-2: 56px;
  --text-heading-3: 36px; --leading-heading-3: 44px;
  --text-heading-4: 28px; --leading-heading-4: 36px;
  --text-heading-5: 24px; --leading-heading-5: 32px;
  --text-heading-6: 20px; --leading-heading-6: 24px;
  --tracking-heading: -0.01em;
  --text-body-lg: 18px; --leading-body-lg: 24px;
  --text-body-base: 15px; --leading-body-base: 24px;
  --text-body-sm: 13px; --leading-body-sm: 20px;
  --text-caption-lg: 12px; --leading-caption-lg: 16px;
  --text-caption-base: 11px; --leading-caption-base: 16px;
  --text-caption-sm: 10px; --leading-caption-sm: 16px;
  --text-caption-xs: 8px; --leading-caption-xs: 12px;
  --tracking-caption-upper: 0.05em;
  --text-code-sm: 13px; --text-code-xs: 12px;
  /* space, radius, motion */
  --space: 4px;
  --space-1: 4px; --space-2: 8px; --space-3: 12px; --space-4: 16px; --space-5: 20px; --space-6: 24px; --space-8: 32px; --space-10: 40px; --space-12: 48px; --space-16: 64px;
  --radius-xs: 2px; --radius-sm: 4px; --radius-md: 6px; --radius-lg: 8px; --radius-xl: 10px;
  --control-xs: 20px; --control-sm: 24px; --control-md: 28px; --control-lg: 32px; --control-xl: 40px;
  --radius-2xl: 12px; --radius-3xl: 16px; --radius-4xl: 20px; --radius-5xl: 24px; --radius-full: 9999px;
  --ease-out: cubic-bezier(0, 0, 0.2, 1);
  --ease-in-out: cubic-bezier(0.4, 0, 0.2, 1);
  --ease-out-quint: cubic-bezier(0.23, 1, 0.32, 1);
  --duration-fast: 150ms; --duration-base: 200ms;
}
.dark, [data-theme="dark"] {
  color-scheme: dark;
  /* gray */
  --gray-1: #111111; --gray-2: #191919; --gray-3: #222222; --gray-4: #2a2a2a; --gray-5: #313131; --gray-6: #3a3a3a; --gray-7: #484848; --gray-8: #606060; --gray-9: #6e6e6e; --gray-10: #7b7b7b; --gray-11: #b4b4b4; --gray-12: #eeeeee;
  --gray-a1: #00000000; --gray-a2: #ffffff09; --gray-a3: #ffffff12; --gray-a4: #ffffff1b; --gray-a5: #ffffff22; --gray-a6: #ffffff2c; --gray-a7: #ffffff3b; --gray-a8: #ffffff55; --gray-a9: #ffffff64; --gray-a10: #ffffff72; --gray-a11: #ffffffaf; --gray-a12: #ffffffed;
  /* blue */
  --blue-1: #0d1520; --blue-2: #111927; --blue-3: #0d2847; --blue-4: #003362; --blue-5: #004074; --blue-6: #104d87; --blue-7: #205d9e; --blue-8: #2870bd; --blue-9: #0090ff; --blue-10: #3b9eff; --blue-11: #70b8ff; --blue-12: #c2e6ff;
  --blue-a1: #004df211; --blue-a2: #1166fb18; --blue-a3: #0077ff3a; --blue-a4: #0075ff57; --blue-a5: #0081fd6b; --blue-a6: #0f89fd7f; --blue-a7: #2a91fe98; --blue-a8: #3094feb9; --blue-a9: #0090ff; --blue-a10: #3b9eff; --blue-a11: #70b8ff; --blue-a12: #c2e6ff;
  /* green */
  --green-1: #0e1512; --green-2: #121b17; --green-3: #132d21; --green-4: #113b29; --green-5: #174933; --green-6: #20573e; --green-7: #28684a; --green-8: #2f7c57; --green-9: #30a46c; --green-10: #33b074; --green-11: #3dd68c; --green-12: #b1f1cb;
  --green-a1: #00de4505; --green-a2: #29f99d0b; --green-a3: #22ff991e; --green-a4: #11ff992d; --green-a5: #2bffa23c; --green-a6: #44ffaa4b; --green-a7: #50fdac5e; --green-a8: #54ffad73; --green-a9: #44ffa49e; --green-a10: #43fea4ab; --green-a11: #46fea5d4; --green-a12: #bbffd7f0;
  /* orange */
  --orange-1: #17120e; --orange-2: #1e160f; --orange-3: #331e0b; --orange-4: #462100; --orange-5: #562800; --orange-6: #66350c; --orange-7: #7e451d; --orange-8: #a35829; --orange-9: #f76b15; --orange-10: #ff801f; --orange-11: #ffa057; --orange-12: #ffe0c2;
  --orange-a1: #ec360007; --orange-a2: #fe6d000e; --orange-a3: #fb6a0025; --orange-a4: #ff590039; --orange-a5: #ff61004a; --orange-a6: #fd75045c; --orange-a7: #ff832c75; --orange-a8: #fe84389d; --orange-a9: #fe6d15f7; --orange-a10: #ff801f; --orange-a11: #ffa057; --orange-a12: #ffe0c2;
  /* tomato */
  --tomato-1: #181111; --tomato-2: #1f1513; --tomato-3: #391714; --tomato-4: #4e1511; --tomato-5: #5e1c16; --tomato-6: #6e2920; --tomato-7: #853a2d; --tomato-8: #ac4d39; --tomato-9: #e54d2e; --tomato-10: #ec6142; --tomato-11: #ff977d; --tomato-12: #fbd3cb;
  --tomato-a1: #f1121208; --tomato-a2: #ff55330f; --tomato-a3: #ff35232b; --tomato-a4: #fd201142; --tomato-a5: #fe332153; --tomato-a6: #ff4f3864; --tomato-a7: #fd644a7d; --tomato-a8: #fe6d4ea7; --tomato-a9: #fe5431e4; --tomato-a10: #ff6847eb; --tomato-a11: #ff977d; --tomato-a12: #ffd6cefb;
  /* semantic */
  --color-page: #0b0b0b;
  --color-shell: #000000;
  --color-container: var(--gray-1);
  --color-container-recessed: var(--gray-1);
  --color-modal: #222222;
  --color-overlay: var(--black-a7);
  --color-card: var(--gray-a2);
  --color-sunken: var(--black-a6);
  --color-standout: var(--gray-3);
  --color-component: var(--gray-a3);
  --color-component-hover: var(--gray-a4);
  --color-component-active: var(--gray-a5);
  --color-component-on-sunken: var(--gray-4);
  --color-component-on-inverted: var(--black-a2);
  --color-component-on-container-subtle: var(--gray-a2);
  --color-component-on-container-subtle-hover: var(--gray-a3);
  --color-component-on-container-strong: var(--gray-a3);
  --color-component-on-container-strong-hover: var(--gray-a4);
  --color-transparent: transparent;
  --color-transparent-hover: var(--gray-a4);
  --color-transparent-active: var(--gray-a3);
  --color-brand-solid: var(--blue-9);
  --color-brand-solid-hover: var(--blue-10);
  --color-brand-solid-active: var(--blue-11);
  --color-brand-subtle: var(--blue-a3);
  --color-brand-subtle-hover: var(--blue-a4);
  --color-brand-subtle-active: var(--blue-a5);
  --color-positive-solid: var(--green-9);
  --color-positive-solid-hover: var(--green-10);
  --color-positive-solid-active: var(--green-11);
  --color-positive-subtle: var(--green-a3);
  --color-positive-subtle-hover: var(--green-a4);
  --color-positive-subtle-active: var(--green-a5);
  --color-warning-solid: var(--orange-9);
  --color-warning-solid-hover: var(--orange-10);
  --color-warning-solid-active: var(--orange-11);
  --color-warning-subtle: var(--orange-a3);
  --color-warning-subtle-hover: var(--orange-a4);
  --color-warning-subtle-active: var(--orange-a5);
  --color-danger-solid: var(--tomato-9);
  --color-danger-solid-hover: var(--tomato-10);
  --color-danger-solid-active: var(--tomato-11);
  --color-danger-subtle: var(--tomato-a2);
  --color-danger-subtle-hover: var(--tomato-a3);
  --color-danger-subtle-active: var(--tomato-a5);
  --color-inverted-solid: var(--white-a12);
  --color-inverted-solid-hover: var(--white-a10);
  --color-inverted-solid-active: var(--white-a9);
  --color-disabled: var(--gray-a2);
  --color-primary-foreground: var(--gray-a12);
  --color-secondary-foreground: var(--gray-a11);
  --color-secondary-foreground-solid: var(--gray-11);
  --color-tertiary-foreground: var(--gray-a9);
  --color-disabled-foreground: var(--gray-a8);
  --color-brand-foreground: var(--blue-a10);
  --color-positive-foreground: var(--green-a10);
  --color-warning-foreground: var(--orange-a10);
  --color-danger-foreground: var(--tomato-a10);
  --color-on-inverted-foreground: #000000;
  --color-on-standout-primary-foreground: var(--gray-a12);
  --color-on-standout-secondary-foreground: var(--white-a7);
  --color-border-on-standout: var(--white-a1);
  --color-on-brand-solid-foreground: #ffffff;
  --color-on-brand-subtle-foreground: var(--blue-a11);
  --color-on-positive-solid-foreground: #ffffff;
  --color-on-positive-subtle-foreground: var(--green-a11);
  --color-on-warning-solid-foreground: #111111;
  --color-on-warning-subtle-foreground: var(--orange-a11);
  --color-on-danger-solid-foreground: #ffffff;
  --color-on-danger-subtle-foreground: var(--tomato-a11);
  --color-border-default: var(--gray-a3);
  --color-border-subtle: var(--gray-a2);
  --color-border-strong: var(--gray-a6);
  --color-border-strong-solid: var(--gray-6);
  --color-border-inverted: #ffffff;
  --color-border-control: var(--gray-a9);
  --color-brand-border-default: var(--blue-a6);
  --color-brand-border-subtle: var(--blue-a5);
  --color-brand-border-focus: var(--blue-a9);
  --color-positive-border-default: var(--green-a6);
  --color-positive-border-subtle: var(--green-a5);
  --color-warning-border-default: var(--orange-a6);
  --color-warning-border-subtle: var(--orange-a5);
  --color-danger-border-default: var(--tomato-a6);
  --color-danger-border-subtle: var(--tomato-a4);
  /* elevation */
  --shadow-border: 0 0 0 1px #ffffff12;
  --shadow-default: inset 0 0 0 0.5px #ffffff12;
  --shadow-large: 0 0 0 1px var(--gray-a6), 0 2px 3px -2px var(--black-a3), 0 3px 8px -2px var(--black-a6), 0 4px 12px -4px var(--black-a7);
  --shadow-xl: inset 0 0 0 0.5px #ffffff12, 0 8px 40px 0 #0000000d, 0 12px 32px -16px #00000026;
}
/* Increased contrast, when the OS asks for it */
@media (prefers-contrast: more) {
  :root, .light, .dark, [data-theme] {
    --color-primary-foreground: var(--gray-12);
    --color-secondary-foreground: var(--gray-a12);
    --color-secondary-foreground-solid: var(--gray-12);
    --color-tertiary-foreground: var(--gray-a11);
    --color-disabled-foreground: var(--gray-a11);
    --color-brand-foreground: var(--blue-a11);
    --color-positive-foreground: var(--green-a11);
    --color-warning-foreground: var(--orange-a11);
    --color-danger-foreground: var(--tomato-a11);
    --color-on-brand-subtle-foreground: var(--blue-a11);
    --color-on-positive-subtle-foreground: var(--green-a11);
    --color-on-warning-subtle-foreground: var(--orange-a11);
    --color-on-danger-subtle-foreground: var(--tomato-a11);
    --color-border-default: var(--gray-a7);
    --color-border-subtle: var(--gray-a6);
    --color-border-strong: var(--gray-a8);
    --color-border-strong-solid: var(--gray-8);
    --color-border-control: var(--gray-a11);
    --color-brand-border-default: var(--blue-a11);
    --color-brand-border-subtle: var(--blue-a10);
    --color-brand-border-focus: var(--blue-a11);
    --color-positive-border-default: var(--green-a11);
    --color-positive-border-subtle: var(--green-a10);
    --color-warning-border-default: var(--orange-a11);
    --color-warning-border-subtle: var(--orange-a10);
  }
}
```

## Appendix B: changes from the source

Graphite keeps the Interfere token structure and values with these exceptions.

- Fonts: Berkeley Mono becomes Geist Mono, and Heldane Text becomes Newsreader. Both originals need paid licenses.
- Light mode text contrast: brand, positive, warning and danger text move from alpha step 10 to step 11, and subtle-badge text moves from step 9 to step 11. Each now measures about 4.3 to 5.0:1. Dark mode already passed and keeps the original values.
- Warning solid: text on the orange fill becomes near-black in both themes. White measured 2.9:1, and near-black measures 5.5 to 6.4:1.
- Focus ring: light mode uses blue 10 instead of alpha blue 8. The original measured 2.3:1 on white, and blue 10 measures 3.2 to 3.6:1 on every light surface.
- New token `--color-border-control` for unchecked checkbox and radio outlines. The source used `border-strong`, which is about 1.4:1 on white. The new token is 3.3:1 or better in both themes.
- High contrast block: primary text uses gray 12 in both themes. The source set it to white, which would hide text in light mode.
- Light and dark now expose the same token set. Missing light `-active` and `-border-subtle` tokens were added on the same steps dark mode uses.
- New token `--color-overlay` for the dialog scrim, so no component has to branch on theme.
- Product-specific tokens, like provider brand colors, were removed. Shadows were flattened into four ready-to-use tokens.
