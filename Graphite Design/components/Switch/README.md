# Switch

A 32 by 18px toggle for settings that take effect immediately, `color-component-active` when off and `color-brand-solid` when on.

## What you provide

- `<label class="gr-check">` wrapping `<input type="checkbox" role="switch" class="gr-switch">` and the setting name.
- Optional helper text under the label in `gr-help`.

## Rules

- A switch saves on change. If the setting needs a Save button, use a checkbox.
- Name the setting, not the action: "Auto-deploy on push", not "Turn on auto-deploy".
- The thumb moves over `duration-fast` with `ease-out`, and stays still under reduced motion.
