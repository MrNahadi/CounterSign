# ScrollArea

A scrolling region with a thin rounded thumb and soft fades on the edges that have more content.

## What you provide

- A `gr-scroll` element with a fixed height or max-height.
- A small script that sets `data-fade` to "top", "bottom" or "top bottom" from the scroll position, as in the preview.

## Rules

- Thumb: 6px, `gray-a6`, `radius-full`. Track stays transparent.
- Fades are 16px mask gradients, shown only on edges with hidden content.
- Never nest scroll areas on the same axis.
