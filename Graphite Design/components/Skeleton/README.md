# Skeleton

Placeholder shapes that hold the layout while content loads, with a slow shimmer.

## What you provide

- `gr-skeleton` blocks sized like the content they replace, with the same radius (`radius-sm` for text lines, `radius-full` for avatars, `radius-2xl` for cards).
- `aria-busy="true"` on the region that is loading.

## Rules

- Fill is `color-component`; the shimmer slides `color-component-hover` across over 1.5s and stops under reduced motion.
- Show skeletons only after 300ms, so fast loads don't flash.
- Match the real layout closely. Line widths vary between 40% and 90%.
