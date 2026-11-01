# Table

A roomy data table with 56px rows, a sentence-case header and hairline dividers.

## What you provide

- A `<table class="gr-table">` with `<thead>` and `<tbody>`.
- `gr-num` on numeric cells and their header (right-aligned, tabular numbers), `gr-mono` for IDs and hashes.
- Badges for status columns, and a trailing transparent icon button for row actions.

## Rules

- Header: 13px medium in sentence case, `color-secondary-foreground`, no uppercase or letter-spacing, 44px tall (`--table-header-height`), over a `color-border-default` rule.
- Rows: 14px, at least 56px tall (`--table-row-height`), 16px cell padding, `color-border-subtle` dividers, `color-transparent-hover` on hover.
- A second line in a cell is 13px, 2px below the first.
- Put a one-row toolbar above the table, inside the same card.
- Put the identifying column first and keep it left-aligned. Truncate long text with an ellipsis and show the full value in a tooltip.
