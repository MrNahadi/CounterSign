# CodeCard

A code block with a filename header and copy button, plus inline code for identifiers inside prose.

## What you provide

- A `gr-codecard` with a `gr-codecard-head` (filename in 12px plus a small transparent icon-only copy button) and a `<pre>` holding the code.
- Optional syntax spans: `gr-tok-key` (`color-brand-foreground`), `gr-tok-str` (`color-positive-foreground`), `gr-tok-com` (`color-secondary-foreground`).
- Inline code as `<code class="gr-code">`.

## Rules

- Blocks use `color-sunken`, `radius-2xl`, mono 13px on a 20px line height. They scroll sideways and never wrap.
- Keep highlighting to those three roles. On the sunken fill they measure about 4.3:1 or better in light mode and well above that in dark.
- Confirm a copy with the icon swapping to a check for 2 seconds.
