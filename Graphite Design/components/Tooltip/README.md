# Tooltip

A small inverted label that names an icon button or shows its shortcut, set in 12px on `color-standout`.

## What you provide

- The trigger with an accessible name (`aria-label`), and a `gr-tooltip` element with `role="tooltip"` linked through `aria-describedby`.
- An optional `gr-kbd` inside for the shortcut.

## Rules

- Opens after 500ms of hover or immediately on keyboard focus; closes at once. Sits 6px from the trigger.
- One short phrase, no period. Never put interactive content or essential information in a tooltip.
- Text is `color-on-standout-primary-foreground`; shortcuts use `color-on-standout-secondary-foreground`.
