# Ticket format

`tickets.md` for a feature is a list of tickets in this exact shape. The loop reads and updates these fields, so keep the labels as written.

```
## T-003: Compute attained CII from a voyage fuel log

Status: open
Blocked by: T-001, T-002
Slice: Import a fuel log CSV, compute attained CII for the voyage, show the value in the side panel.
Test seam: `ciiForVoyage(log, vessel)` in `src/cii/` (public interface only)
Acceptance:
- [ ] Matches the 5 reference voyages in `test/fixtures/cii/` to 3 decimal places
- [ ] Rejects a log with missing distance and shows which rows are bad
Notes:
```

## Status values

| Status | Meaning |
|---|---|
| open | Ready once its blockers are done |
| in-progress | An iteration is working on it |
| done | Committed, feedback commands passed |
| blocked-question | Waiting on a file in `questions/open/` |
| blocked-failing | Three fix attempts failed; details under Notes |

## Writing good tickets

- Each ticket is a tracer bullet: a thin slice that works end to end, from input to visible result. Avoid "build the data layer" tickets that only pay off three tickets later.
- One ticket fits one iteration. If it touches more than about five files or more than one module boundary, split it.
- Acceptance items are things a test or a command can check. If only a human can check it, put it in `validation.md` instead.
- `Blocked by` lists only real dependencies. Fewer edges means more tickets are ready at once.
- The Test seam names a public interface. Tests written against internals break on every refactor.
- No implementation detail the agent can work out itself: no variable names, no file-by-file instructions.
