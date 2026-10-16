# Spinner

A small ring for work under a few seconds, plus the live timer pattern for longer work.

## What you provide

- `<span class="gr-spinner" role="status" aria-label="Loading">`, sized with `--size` (12, 16 or 20px). It inherits `currentColor`.
- For longer work, a status row: a spinner or `gr-dot-live`, a short verb ("Building"), and a timer in `gr-pixel`.

## Rules

- One turn per 800ms, linear. Under reduced motion the ring stays still.
- Inside buttons, the spinner replaces the leading icon and the label stays.
- Past 10 seconds, show progress or a timer instead of a bare spinner.
