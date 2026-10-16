# Input

Single-line inputs and textareas with their label and helper text; 32px tall, 13px text, filled with `color-component-on-container-strong` and edged with `shadow-default`.

## What you provide

- A `gr-field` wrapper holding a `<label class="gr-label">`, the control and an optional `<p class="gr-help">`.
- `<input class="gr-input">` or `<textarea class="gr-input">` (3 rows minimum).
- A leading icon by wrapping the input in `gr-input-wrap` and putting a `gr-icon` first.
- `aria-invalid="true"` plus a `gr-help gr-help-error` line, linked with `aria-describedby`, when the value is wrong.

## Rules

- Labels sit above the field at 13px medium in `color-primary-foreground`. Never use the placeholder as the label.
- Placeholders use `color-tertiary-foreground`, so keep them to examples ("acme-web"), not instructions.
- Focus draws a 1px inset ring in `color-brand-border-focus`; errors use `color-danger-border-default`.
- Use 28px height (`control-md`) only inside dense toolbars.
- Error copy says what to do: "Use lowercase letters, numbers and hyphens", not "Invalid input".
