# Toast

A brief, non-blocking message about something that just happened, with an optional single action.

## What you provide

- A container with `role="status"` (or `role="alert"` for failures), bottom right on desktop and bottom center on mobile.
- A `gr-toast` with a status class (`gr-toast-positive`, `-warning`, `-danger`, `-info`), a leading status icon, a `gr-toast-title` and an optional `gr-toast-desc`.
- An optional trailing small transparent button for one action, such as Undo or View.

## Rules

- Surface `color-modal`, `shadow-large`, `radius-2xl`, 360px wide.
- Auto-dismiss after 4 seconds, pause on hover and focus. Failures stay until dismissed.
- Write the outcome, not the process: "Deployment ready", not "Your deployment has been successfully completed!"
