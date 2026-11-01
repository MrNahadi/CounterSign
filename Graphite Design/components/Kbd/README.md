# Kbd

A key cap for keyboard shortcuts, in the mono font at 12px on `color-component`, at least 22px tall.

## What you provide

- One `<kbd class="gr-kbd">` per key. Separate keys with a space; write sequences with "then".

## Rules

- Show symbols on macOS (⌘ ⌥ ⇧ ⌃) and words elsewhere (Ctrl, Alt, Shift).
- Inside buttons and tooltips the cap shrinks to the small size (`gr-kbd-sm`, 18px) and takes its colors from the host.
- Pair shortcuts with the action name. A shortcut on its own means nothing.
