# Countersign logo

The owner's logo, added 1 Nov 2026. Both files are the same mark in two colours:

- `countersign-logo-dark.svg`: the dark mark (`#1E1E1E`), for light backgrounds.
- `countersign-logo-light.svg`: the light mark (`#EBEBEB`), for dark backgrounds.

In the UI, use the `Logo` component in `apps/console/app/logo.tsx`. It draws the same paths in `currentColor`, so it follows Graphite's text tokens in both themes without raw hex. The console's favicon, `apps/console/public/icon.svg`, switches between the two colours with `prefers-color-scheme`.

The storefront is Kikapu Studio, the demo merchant's own shop, so it doesn't carry the Countersign mark.
