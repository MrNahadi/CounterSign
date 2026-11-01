# Input

Single-line inputs and textareas with their label and helper text; 36px tall, 14px text, 12px side padding, filled with `color-component-on-container-strong` and edged with `shadow-default`.

## What you provide

- A `gr-field` wrapper holding a `<label class="gr-label">`, the control and an optional `<p class="gr-help">`.
- `<input class="gr-input">` or `<textarea class="gr-input">` (3 rows minimum): 10px by 12px padding, a 22px line height and at least 112px tall.
- A leading icon by wrapping the input in `gr-input-wrap` and putting a `gr-icon` first.
- `aria-invalid="true"` plus a `gr-help gr-help-error` line, linked with `aria-describedby`, when the value is wrong.

## Rules

- Labels sit above the field at 14px medium in `color-primary-foreground`. Helper and error text is 13px. Leave 8px between the label, the field and the helper text. Never use the placeholder as the label.
- Placeholders use `color-tertiary-foreground`, so keep them to examples ("acme-web"), not instructions.
- Focus draws a 1px inset ring in `color-brand-border-focus`; errors use `color-danger-border-default`.
- Use 32px height (`control-md`) only inside toolbars.
- Error copy says what to do: "Use lowercase letters, numbers and hyphens", not "Invalid input".
