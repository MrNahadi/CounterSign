# Readiness re-audit B2: phase 13a, detailed implementation plan

Reviewer: Implementation Readiness Goldfish (Mode: REVIEW), re-audit.
Target: `specs/features/13a-graphite-comfortable/design.md`, read in full, with `reviews/resolution.md`, `validation.md` (the lines that count shots), the root `package.json`, `tsconfig.json`, `tsconfig.base.json`, `vitest.config.ts` and `scripts/cloud-setup.sh`.
Scope: only (1) whether the two Blockers in `B-readiness.md` are resolved, and (2) whether the round B fixes introduced a new Blocker. No Majors or Nits.

---

## Blocker 1 (screen matrix doesn't add up): resolved

The table in step 2c lists 14 screens: `inbox`, `inbox-thread`, `approvals`, `approvals-signed-out`, `disputes`, `decisions`, `decision`, `decision-unreadable`, `audit`, `audit-check`, `chat`, `risk-desk`, `shop`, `product`. Each has a path, a signed-in flag, a shell flag and a scope, so the implementer invents nothing. 14 × 2 themes × 2 widths = 56, and the text says so.

The count is the same everywhere I checked:
- design.md: the architecture diagram (line 140), G-4 (line 30), the step 2c table and its sum (line 301), the gate table's last row (`ui-shots: 56 shots, 0 failures`), Alternative D (line 170) and the Verification Plan (line 588).
- validation.md: manual check 1 says "all 56 PNGs".
- No stale `60` or `15` screen count is left in design.md or validation.md. The one `60` in design.md (step 3d) is the `button()` combination count (5 variants × 4 sizes × 3 icon modes), which is right.

## Blocker 2 (Playwright can't be loaded): resolved

The plan now makes the choice itself:
- Step 2d adds `@playwright/test` as an exact root devDependency at 1.64.1, the version `specs/tech-stack.md:44` already pins. The command is given, and the manifest and tech-stack no longer disagree. I confirmed the root `package.json` has no Playwright today, so the edit is needed and the plan names it.
- `shoot.ts` imports `{ chromium }` from `@playwright/test`, which resolves from the repo's `node_modules`, so the `createRequire` and global-prefix problem is gone.
- The browser source is stated: Playwright's own Chromium via `npx playwright install chromium` (new step 2f in `scripts/cloud-setup.sh`, which currently installs only dependencies), or `UI_SHOTS_CHROMIUM`. With neither, the harness exits 2 with a named message.

## New Blockers from the round B fixes: none

Checked the fixes that touch buildability or the done criterion:
- **New tsconfig (2e).** The root `tsconfig.json` includes `tests`, so `exclude: ["tests/ui-shots"]` is the right way to keep DOM types out of it. The new project extends `tsconfig.base.json` and overrides only `lib`. Nothing in the base conflicts: `noEmit`, `erasableSyntaxOnly` and `verbatimModuleSyntax` are all fine with the planned files. The root `typecheck` script gains the second `tsc` call, so the project is actually checked.
- **Vitest.** The `repo` project includes `tests/**/*.test.ts`, so `tests/ui-shots/fixtures.test.ts` still runs under `npm test` even though the root tsconfig excludes it. Vitest doesn't typecheck.
- **`--checks` and `--only` flags and the gate table.** Each step from 4 to 12 and 16 has an exact command. `--checks shell,theme` with no `--only` is defined (screens whose `shell` is yes). Steps 1 to 3 and 13 to 15 are stated to have no gate. The ordering contradiction from round B is gone.
- **`risk-desk` scope.** The selector `[data-graphite="spike-header"]` is added in 12d, step 12 (before the gate at step 12), so the gate is reachable.
- **`__name` init script, signed-in column, recipe composition rules, `Card` `gap` prop.** These are internally consistent. No step still refers to an API the fixes removed. `Card` now takes `gap`, and 9b uses `gap="tight"`.
- **Tests that change.** The `approvals-view.ts` allowed-imports change (`./controls`) is in both "Tests that change" and 5b.

I found no new step that leaves the implementer with a design choice at Blocker level, and nothing that makes the `56 shots, 0 failures` done line unreachable.

---

Counts: both prior Blockers resolved. New Blockers: 0.

GO
