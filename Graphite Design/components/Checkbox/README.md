# Checkbox

Checkboxes and radio groups: 16px native inputs restyled, unchecked with a `color-border-control` outline and checked in `color-brand-solid`.

## What you provide

- `<label class="gr-check">` wrapping `<input type="checkbox" class="gr-checkbox">` and the label text, so the whole row is clickable.
- For radios, `<input type="radio" class="gr-radio">` with a shared `name`, inside a `<fieldset>` with a `<legend>` styled as `gr-label`.
- `disabled` on the input; the label dims with it.

## Rules

- Use checkboxes for independent on/off choices that apply after a save. For instant settings, use the switch.
- Use radios for one choice out of two to five. Stack them vertically with 8px gaps.
- The unchecked outline is 3.3:1 or better in both themes, so the control stays findable.
