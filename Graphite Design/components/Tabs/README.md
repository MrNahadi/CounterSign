# Tabs

Underline tabs for switching views of one object, and a segmented control for switching a small set of modes in place.

## What you provide

- Underline tabs: a `gr-tabs` element with `role="tablist"`, and `<button class="gr-tab" role="tab">` children. The selected tab has `aria-selected="true"` and draws a 2px `color-inverted-solid` bar.
- Segmented control: a `gr-segmented` track holding `<button class="gr-segment">` items; the active one has `aria-pressed="true"`.

## Rules

- Tabs change the content below them; a segmented control changes how the same content is shown (Day, Week, Month).
- Two to six tabs. Labels are one or two words in sentence case.
- The segmented track is `color-sunken` with `radius-xl` and 2px padding, so active segments use `radius-lg`.
