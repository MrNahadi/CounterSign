# Graphite components

The component specs from the owner's Graphite design system on claude.ai (https://claude.ai/artifact/6wWRQMiLxwZK13kzkxyfSZ), copied here on 16 Oct 2026. The design system is the source; refresh these copies from it rather than editing them.

## What's here

- `<Name>/README.md`: the guidelines for one component. The first sentence says what it's for, "What you provide" lists the markup and behavior the app supplies, and "Rules" sets the tokens, sizes and do's and don'ts.
- `<Name>/preview.html`: a live example of the markup. It renders correctly only inside the design system, which preloads the tokens and `bundle.css`. Read it for structure and class names.
- `bundle.css`: the stylesheet for every `gr-` class. Every value comes from a token in `../graphite-tokens.css`, and it uses only token names defined there. The `#000` values are alpha masks for scroll fades, not colors. It also carries base page styles and preview scaffolding (`gr-stage`, `gr-row`), which apps don't use.
- `Cover/preview.html`: the design system's cover art.

`../brand-book.md` is the design system's README: content and voice rules, visual foundations, iconography and how to use the components. `../tokens.json` holds the same values as `../graphite-tokens.css`, in the design system's format.

## Components

| Group | Components |
|---|---|
| Actions | Button |
| Forms | Input, InputOTP, Checkbox (and radio), Select, Switch |
| Data display | Avatar, Badge, Card, CodeCard, Table, Accordion |
| Navigation | Breadcrumb, Tabs, Command, Menu |
| Overlays | Dialog (and drawer), Tooltip, Toast |
| Feedback | Skeleton, Spinner |
| Layout | Divider, ScrollArea, Kbd |

## Using them in an app

Build the component a spec describes with the app's own markup and Tailwind classes named after Graphite tokens (ADR 0006): the same fills, rings, radii, sizes and states the spec names. Behavior such as opening menus, trapping focus and roving keyboard focus comes from the app, as each spec's "What you provide" says.
