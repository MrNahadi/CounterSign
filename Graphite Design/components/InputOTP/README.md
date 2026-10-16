# InputOTP

A one-time code entry made of 40 by 44px cells in the mono font, grouped in threes.

## What you provide

- One real `<input autocomplete="one-time-code" inputmode="numeric">` that holds the value, visually hidden or overlaid, so paste and autofill work.
- The `gr-otp` display: two `gr-otp-group` rows of `gr-otp-cell` elements with a `gr-otp-sep` between them.
- `data-active` on the cell where the next digit goes.

## Rules

- Cells use the input fill and `shadow-default`; the active cell shows the `color-brand-border-focus` ring.
- Digits use `font-variant-numeric: tabular-nums` at 18px.
- Accept a pasted code into all cells at once and submit when the last cell fills.
