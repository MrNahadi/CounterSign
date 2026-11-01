# Accordion

Stacked sections that expand in place, which also covers a single collapsible.

## What you provide

- A `gr-accordion` holding `<details class="gr-acc-item">` elements, each with a `<summary>` (title plus trailing chevron icon) and a `gr-acc-panel`.
- For a single collapsible, one `gr-acc-item` on its own.

## Rules

- Triggers are 52px tall, 14px medium. The chevron rotates 180 degrees over `duration-base`.
- Panels use `color-secondary-foreground` at 14px on a 22px line height, with 16px bottom padding.
- Use for FAQs and optional settings. Don't hide anything a user needs to finish the task.
