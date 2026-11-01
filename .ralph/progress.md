# Progress: phase 13, the hosted judge path (specs/features/13-hosted-judge-path)

Gotchas only, one line each.

- `main` (feature 13a, the comfortable-density restyle) is merged into this branch before T-001; UI tickets use `apps/console/app/ui.tsx` and `Graphite Design/DESIGN.md`, never design item 21's class strings or hard-coded density values.
- `yaml` 2.9.1 is installed as a root devDependency (the conductor did it); T-023 doesn't need to install it.
- The gate's `mountPairing` must come before `mountApprovals`, or `/approvals/:id` swallows `/approvals/pair` (T-011).
- Baseline runs never write the audit log (ADR 0031), so the reset catches them by `queued_at`, not by log entries (T-008).
- Every reset test moves the clock past the one-minute cooldown between resets (T-007, T-008, T-025).
- Right after a container restart, one `npm test` run failed 2 test files at load (no failing test); the next two runs passed. Rerun once before debugging.
