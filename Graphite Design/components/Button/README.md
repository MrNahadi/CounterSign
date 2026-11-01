# Button

Buttons start actions; Graphite has seven variants, five sizes and two shapes, all set in medium weight text: 12px for extra small, 13px for small, 14px for medium and large, and 15px for extra large in the reference CSS (the console uses 14px at that size, because 15px has no token).

## Variants

| Class | Fill and text | Use |
|---|---|---|
| `gr-btn-primary` | `color-inverted-solid`, `color-on-inverted-foreground` | The one main action on a screen |
| `gr-btn-secondary` | `color-component-on-container-strong` with `shadow-default` | Most other actions, and Cancel |
| `gr-btn-tertiary` | `color-component`, `color-secondary-foreground` | Toolbar and low-emphasis actions |
| `gr-btn-brand` | `color-brand-solid`, `color-on-brand-solid-foreground` | Upgrade, connect and other brand moments, once per screen at most |
| `gr-btn-danger` | `color-danger-solid`, `color-on-danger-solid-foreground` | Confirming a destructive action |
| `gr-btn-danger-subtle` | `color-danger-subtle`, `color-danger-foreground` | Starting a destructive action before the confirm |
| `gr-btn-transparent` | none, `color-secondary-foreground` | Icon buttons, nav and inline actions |
| `gr-btn-link` | none, `color-brand-foreground` | Actions inside a sentence |

## Sizes

`gr-btn-xs` 24px, `gr-btn-sm` 28px, `gr-btn-md` 32px (default), `gr-btn-lg` 36px, `gr-btn-xl` 44px. Side padding is 8, 10, 14, 16 and 20px, and the gap between icon and label is 4, 6, 6, 6 and 8px. Icons follow the size: 12, 14, 16, 16 and 20px. No button is under 28px in a product screen; touch primary actions use `gr-btn-xl`. Add `gr-btn-pill` for a full pill and `gr-btn-icon` for a square icon-only button.

## What you provide

- A `<button>` (or `<a>` for navigation) with `gr-btn`, one variant and one size class.
- The label in a `<span>` so it truncates. Write it as a verb in sentence case: "Create project", not "Project Creation".
- Optional leading or trailing `gr-icon` SVG from Lucide. The button pulls in its padding by 2 to 4px on the icon side.
- A keyboard hint goes only in a secondary button, as the small Kbd (18px).
- `aria-label` on every icon-only button, plus a tooltip.
- For pending work, set `aria-busy="true"`, swap the leading icon for a `gr-spinner`, keep the label and the width.
- `disabled` for unavailable actions. Say why nearby when it isn't obvious.

## Do and don't

- Do put the primary or danger button last in a button row.
- Do keep brand and danger labels short: white on those fills is 3.1 to 3.9:1, which passes for UI but not for small body text.
- Don't place two primary buttons on one screen.
- Don't use emoji in labels.
