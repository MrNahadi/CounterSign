# Dialog

Modal dialogs for focused decisions, and the drawer, which is the same surface as a bottom sheet on small screens.

## What you provide

- An overlay (`gr-overlay`, filled with `color-overlay`) and a `gr-dialog` with `role="dialog"`, `aria-modal="true"` and `aria-labelledby` pointing at the title.
- A `gr-dialog-title` (heading-6, weight 600), an optional `gr-dialog-desc`, the body, and a `gr-dialog-footer`.
- Focus moved into the dialog on open and returned to the trigger on close. Escape closes it.
- For a drawer, a `gr-drawer` with a `gr-drawer-handle`, anchored to the bottom edge.

## Rules

- Dialog: `color-modal`, `shadow-xl`, `radius-3xl`, 20px padding, 448 or 512px wide.
- Footer buttons are large, right-aligned, Cancel first and the primary or danger action last.
- Titles ask the question or name the task: "Delete this project?", "Invite people".
- Don't stack dialogs. Use a drawer on screens narrower than 640px.
