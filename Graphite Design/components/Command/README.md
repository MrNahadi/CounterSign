# Command

The command palette: a search field over grouped actions, opened with Cmd+K or Ctrl+K.

## What you provide

- A `gr-command` panel in a dialog, with a `gr-command-input` row (search icon plus `<input>`) and a `gr-command-list` of groups.
- Items as `gr-menu-item` elements (36px tall here) with a leading icon and an optional `gr-menu-shortcut` of `gr-kbd` keys.
- Filtering, keyboard highlight (`data-highlighted`) and Enter to run.

## Rules

- Panel: `color-modal`, `shadow-xl`, `radius-3xl`, 640px wide, placed in the upper third of the screen.
- The input is 15px, with no ring; a 1px `color-border-subtle` line separates it from results.
- Show recent and suggested actions before the user types. Show "No results" in `color-secondary-foreground` when nothing matches.
