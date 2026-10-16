Graphite is for dense, calm product UI. It's monochrome first with one blue accent, hairline edges instead of borders, and 13px interface text. Light is the default theme and dark is fully supported through the same token names.

## Content fundamentals

Write like a calm colleague. Short, plain, specific.

- Talk to the user as "you". The product doesn't say "I". Use "we" only when owning a failure: "We couldn't reach GitHub. Try again in a minute."
- Sentence case everywhere: buttons, titles, menu items, tabs, table headers before they're uppercased. Proper nouns keep their capitals.
- Buttons are a verb and an object: "Create project", "Invite people". A confirm button repeats the verb in the dialog title: "Delete this project?" → "Delete project".
- Errors say what happened and what to do: "Build failed. Fix the type error in src/app.ts on line 42."
- Toasts state the outcome: "Deployment ready", not "Your deployment was completed successfully!"
- Empty states get one line about what will appear and one action: "No deployments yet. Push to main to start one."
- No exclamation marks and no emoji, anywhere. There's no reaction picker in this system for the same reason.
- Durations are compact ("1m 08s"), counts use digits ("3 items"), and dates are relative under a week ("4m ago"), absolute after.

## Visual foundations

### Color

- Style components with `color-*` tokens only. The gray, blue, green, orange and tomato scales sit underneath; reach for a scale step directly only for avatar and label hues.
- Lay apps out as `color-shell` (the frame and sidebar) holding one `color-container` panel inset 8px, with `radius-2xl` and `shadow-border`. Full-bleed screens use `color-page`. Floating layers use `color-modal`.
- Keep the interface monochrome. The primary button is `color-inverted-solid`: black in light, white in dark. Blue (`color-brand-solid`, `color-brand-foreground`) is for links, focus, selection and at most one brand button per screen.
- Set body text in `color-primary-foreground` and labels in `color-secondary-foreground`. Use `color-tertiary-foreground` only for meta text such as timestamps, placeholders and table headers. It measures 3.3:1 in light, below AA for body copy.
- Pair every fill with its text token. `color-x-solid` takes `color-on-x-solid-foreground`, and `color-x-subtle` takes `color-on-x-subtle-foreground`.
- Show status with a subtle fill, its text token and a word or icon. Never rely on color alone.
- White on `color-brand-solid` and `color-danger-solid` measures 3.3 to 3.9:1. That passes for icons and large text but not small body text, so keep those button labels short, and use the primary button for anything the user must read carefully.
- Treat `color-card` as transparent. It's a 2 to 4% tint, so text on it gets its contrast from the surface underneath.

### Type

- Set all UI in `font-sans` (Inter) at `body-sm`: 13px on 20px. Labels, buttons and tabs take weight 500.
- Use `body-base` (15px on 24px) for reading: docs, descriptions and long help text, at 60 to 75 characters a line.
- Headings track at -0.01em. App pages top out at `heading-4`; `heading-1` to `heading-3` are for marketing and docs.
- Uppercase group headings in menus, sidebars and table headers use `caption-upper` with `text-transform: uppercase`.
- Numbers in tables and timers use `font-variant-numeric: tabular-nums`. IDs and hashes use `code-xs` in `font-mono`.
- `font-serif` (Newsreader) is for `display-serif` moments only: hero headlines and pull quotes. Never in controls.
- `font-pixel` (Departure Mono) is for `pixel-accent` readouts such as a live timer. Never a sentence.
- Weights are 400, 450, 500 and 600 (`font-weight-*`). There's no bold in the sans.

### Spacing and layout

- Space on the 4px grid with `space-1` to `space-16`. Gaps between buttons are `space-2`, card padding is `space-4`, dialog padding is `space-5`, page sections sit `space-8` to `space-12` apart.
- Control heights come from `control-xs` to `control-xl` (20 to 40px). The default is `control-lg`, 32px. Use `control-xl` for primary actions on touch layouts.
- Cap forms and settings at 672px wide, dialogs at 448 or 512px.

### Radius

- Buttons, inputs, menu items and tooltips use `radius-lg`. Cards, menus, popovers and toasts use `radius-2xl`. Dialogs and drawers use `radius-3xl`. Pills, avatars and switches use `radius-full`.
- When one rounded shape sits inside another, the inner radius is the outer radius minus the padding between them. A 12px menu with 4px padding gets 8px items.

### Edges and elevation

- Draw edges with box-shadow rings, never CSS borders, so nothing shifts by a pixel. `shadow-border` is the 1px hairline for containers and cards.
- Raise small controls with `shadow-default`, floating menus with `shadow-large`, and dialogs with `shadow-xl`.
- In dark mode the shadows swap drop shadows for a faint inner highlight, because shadows don't read on black. Don't add extra shadows to compensate.

### Motion

- Animate color changes over `duration-fast` with `ease-out`, and transforms over `duration-base`.
- Buttons shrink to 97% while pressed. Popovers enter with opacity and a 0.95 to 1 scale using `ease-out-quint`.
- Wrap every transition in `prefers-reduced-motion: no-preference`, and every hover style in `hover: hover`.

### States

- Hover uses the `-hover` token of the same family. Pressed uses `-active`.
- Focus shows a 1px `color-brand-border-focus` outline on every interactive element: inset on fields, 2px outside on buttons and toggles. It measures 3:1 or better on every surface in both themes.
- Disabled controls use `color-disabled` and `color-disabled-foreground`, with `cursor: not-allowed`. Say why an action is disabled when it isn't obvious.
- Selection uses brand: checked boxes, switches that are on, and selected rows tinted `color-brand-subtle`.

### Themes

- Light comes first. Dark switches on with `data-theme="dark"` on `<html>`, and every token keeps its name, so components never branch on theme.
- When the OS asks for more contrast, secondary and tertiary text and borders step up automatically. Don't override them.
- Check every screen in both themes before shipping.

## Iconography

- Use Lucide by default. Phosphor is fine where a project already uses it, but never mix the two on one screen.
- Draw at stroke width 1.5 up to 16px and 1.75 at 20px, with round caps and joins.
- Icons inherit `currentColor`: idle icons sit in `color-secondary-foreground` and turn `color-primary-foreground` on hover.
- Size icons to their control: 12px in `control-xs`, 14px in `control-sm`, 16px in `control-md` and `control-lg`, 20px in `control-xl`.
- Use an icon or a word where you'd reach for an emoji.

## Using the components

- Load the generated `tokens.css`, then `components/bundle.css`. Load the hosted fonts from Google Fonts: Inter (400 to 600), Geist Mono (400 to 600) and Newsreader (with optical size). Departure Mono ships in `fonts/` under the SIL Open Font License, with the license in `licenses/`.
- Every component class starts with `gr-`. Each component's guidelines list the markup and attributes you provide.
- The stylesheet covers appearance only. Opening menus, trapping focus in dialogs and roving keyboard focus come from your framework or a headless library.
