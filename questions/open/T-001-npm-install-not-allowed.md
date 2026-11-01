# T-001: The loop isn't allowed to run `npm install`

Feature: specs/features/13-hosted-judge-path. Ticket: T-001 (the shared `@countersign/seed` package). Parked stash: `T-001 parked`.

## What blocks the ticket

T-001 creates a new workspace, `packages/seed`, which the storefront and the gate import by name (`@countersign/seed`). Design item 1 ends with "Run `npm install` so the lockfile links the workspace." Until that runs, `node_modules/@countersign` has no `seed` link, so none of the storefront's moved imports resolve and `package-lock.json` doesn't list the workspace.

The unattended loop's call `npm install` was refused (not on the permission allow list). I didn't hand-make the symlink in `node_modules` or hand-edit `package-lock.json`, since that would sidestep the refusal. It adds no external dependency: every package in `packages/seed/package.json` is already installed or a workspace.

## What's done in the parked stash

- `packages/seed/`: `package.json`, `tsconfig.json`, `src/index.ts`, `src/run-id.ts` (`VAULT_ENV_NAMES`, `randomRunSuffix`, `newRunId`, `readVaultTokens`), `test/run-id.test.ts`, and `products.ts`, `seed-catalog.ts`, `seed-run.ts` moved with `git mv` (`StoredRowSchema` now exported).
- `apps/storefront`: `seed-cli.ts` (re-exports `newRunId` and `VAULT_ENV_NAMES`), `shop-props.ts`, `checkout.ts`, the four tests, `package.json` and `next.config.ts` (`transpilePackages`) point at `@countersign/seed`.
- `apps/gate/package.json` depends on `@countersign/seed`; `tests/no-ai-in-decision-path.test.ts` lists `seed`.

Nothing has been run: no test, typecheck, lint or build.

## Options

1. **Allow `npm install` in `.ralph/settings.json` (recommended).** Then pick up `T-001 parked`, run it, and finish. T-002 onwards need it too only if they add a workspace; this is the only ticket that does.
2. Run `npm install` yourself on the `T-001 parked` stash (`git stash pop`, `npm install`, commit the lockfile), then mark the question answered.
3. Allow `npm install --offline --workspaces` only, as a narrower alternative to option 1.
