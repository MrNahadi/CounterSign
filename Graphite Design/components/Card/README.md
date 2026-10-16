# Card

A container for one object or group, edged with a hairline ring on `color-container`, or tinted with `color-card` when it sits inside another container.

## What you provide

- A `gr-card` element. Inside, a `gr-card-title` (13px medium), an optional `gr-card-desc`, and any content.
- `gr-card-tinted` for a grouped block inside a container instead of a ringed card.
- For a selectable card, a button or link as the card, with `box-shadow: 0 0 0 1px var(--color-brand-border-default)` when selected.

## Rules

- `radius-2xl` and 16px padding (20px for roomy cards). Inner elements follow the nesting rule.
- Cards sit on `color-shell` or `color-container`. Never put a ringed card inside another ringed card; use the tinted variant.
- No colored left borders, no drop shadows heavier than `shadow-border`.
