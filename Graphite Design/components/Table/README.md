# Table

A dense data table with 40px rows, an uppercase caption header and hairline dividers.

## What you provide

- A `<table class="gr-table">` with `<thead>` and `<tbody>`.
- `gr-num` on numeric cells and their header (right-aligned, tabular numbers), `gr-mono` for IDs and hashes.
- Badges for status columns, and a trailing transparent icon button for row actions.

## Rules

- Header: caption-upper (11px, weight 500, 0.05em tracking) in `color-tertiary-foreground`, 32px tall, over a `color-border-default` rule.
- Rows: 13px, 40px tall, `color-border-subtle` dividers, `color-transparent-hover` on hover.
- Put the identifying column first and keep it left-aligned. Truncate long text with an ellipsis and show the full value in a tooltip.
