# Select

A select trigger and its option list, which also covers the combobox when a search field sits at the top of the list.

## What you provide

- A trigger `<button class="gr-select">` with the value in a `<span>` and a trailing chevron icon. Add `data-placeholder` when nothing is chosen.
- The list in a `gr-popover` with `role="listbox"`, opened below the trigger with a 4px gap and at least the trigger's width.
- Options as `gr-menu-item` elements with `role="option"`; the chosen one carries `aria-selected="true"` and a check in `gr-menu-check`.
- For a combobox, a `gr-input-wrap` search field as the first row of the popover.

## Rules

- The highlighted option uses `color-transparent-hover`. Keyboard arrows move the highlight; Enter picks.
- Use a select for 5 to 15 options. Fewer: use radios. More: use a combobox.
- Group headings use `gr-menu-group` (uppercase caption).
