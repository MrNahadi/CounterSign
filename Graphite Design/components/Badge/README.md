# Badge

A 20px label for status, category or count, using a subtle fill with its matching text token.

## What you provide

- A `<span class="gr-badge">` with an optional status class (`gr-badge-brand`, `-positive`, `-warning`, `-danger`) and `gr-badge-pill` for the round shape.
- An optional leading `gr-dot`; add `gr-dot-live` for a breathing live indicator.

## Rules

- Neutral badges use `color-component` and `color-secondary-foreground`.
- Status badges always carry a word, never color alone: "Live", "Degraded", "Failed".
- One or two words in sentence case, caption-lg at weight 500.
- Subtle text measures 4.0 to 4.8:1 in light mode and above 7:1 in dark.
