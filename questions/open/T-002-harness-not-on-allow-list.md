# T-002: The loop isn't allowed to run the screenshot harness

Feature: specs/features/13a-graphite-comfortable. Ticket: T-002 (the harness runner). Parked stash: `T-002 parked` (commit cd9301e).

## What blocks the ticket

T-002's test seam is `npm run ui:shots`, and tickets.md says every ticket with a harness gate runs `UI_SHOTS_CHROMIUM=/opt/pw-browsers/chromium-1243/chrome-linux64/chrome npm run ui:shots ...`, as `.ralph/progress.md` says. The `permissions.allow` list in `.claude/settings.json` has no entry for that command, so the unattended loop's call needs approval and is refused. I tried three forms:

- `npm run ui:shots`
- `UI_SHOTS_CHROMIUM=... npm run ui:shots`
- `npx tsx --env-file-if-exists=.env.local tests/ui-shots/shoot.ts --only nope`, which matches the allow-list prefix but was still refused

I didn't work around it with a wrapper, such as a Vitest or Playwright test that launches the browser and both apps. That would sidestep the allow list.

## What's done in the parked stash

- `tests/ui-shots/upstream.ts`: the fake gate (:4511) and fake Resolve (:4512).
- `tests/ui-shots/checks.ts`: `CHECK_NAMES` plus the `densityChecks` stub.
- `tests/ui-shots/shoot.ts`: the 14-screen table, the flags, the build and Chromium exits, both `next start` servers in their own process groups, the `__name` init script, the theme checks, `report.json` and the summary line.
- `tests/ui-shots/shoot.test.ts`: checks that an unknown screen, check, theme or width exits 2.
- The root `ui:shots` script.

With the stash applied, `npm run typecheck`, `npm run lint`, `npm test` (2201 passed) and `npm run build` all pass. None of the six acceptance items has been checked against a real run (56 PNGs, the `upstream: no fixture` log, the count badge, no processes left on 3100, 3101, 4511 or 4512).

## Options

1. **Add the harness to the allow list (recommended).** For example `"Bash(npm run ui:shots:*)"` and `"Bash(UI_SHOTS_CHROMIUM=/opt/pw-browsers/chromium-1243/chrome-linux64/chrome npm run ui:shots:*)"`. Steps 4 to 12 and 16 need this too, because every harness gate runs it.
2. Run the harness once yourself, record the output here, and let the next iteration finish T-002 from that record. Later gate tickets would block the same way.
3. Accept T-002 on typecheck, lint, tests and build alone, and move the full run to T-018. This is weaker: T-005 onwards depend on the harness working.
