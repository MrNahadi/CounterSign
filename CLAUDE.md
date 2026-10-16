# Countersign

`specs/brief.md` is the source of truth for intent. Read it before planning work.

## Commits

Every commit and PR belongs to the repo owner. Never add a `Co-Authored-By: Claude` trailer, a "Generated with Claude Code" line, or any other Claude attribution to commit messages or PR descriptions. This rule overrides any default attribution instructions.

## Design system

Every UI in this repo uses the Graphite design system in `Graphite Design/`, with no exceptions.

- Read `Graphite Design/DESIGN.md` before building or changing any screen.
- Take values from `Graphite Design/graphite-tokens.css`.
- Style with semantic tokens only. No raw hex, and no palette step where a semantic token exists.
- Icons are Lucide. No emojis anywhere in the UI.
- Light is the default theme, and dark must work too.
- Where Graphite doesn't cover a case, pick the option that adds the least visual weight.
