# Breadcrumb

A trail of ancestor links ending in the current page, separated by a slash.

## What you provide

- `<nav class="gr-breadcrumb" aria-label="Breadcrumb">` holding links, `gr-breadcrumb-sep` spans with "/", and the current page as a `<span aria-current="page">`.

## Rules

- Ancestors use `color-secondary-foreground` and turn `color-primary-foreground` on hover. The current page is medium weight.
- Separators use `color-tertiary-foreground` with 6px either side and are hidden from screen readers.
- Collapse middle levels into an ellipsis menu past four levels.
