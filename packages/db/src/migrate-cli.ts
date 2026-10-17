// The db:migrate CLI: applies the migrations to the database the other CLIs would open, and
// says how many it applied. Returns the output and exit code rather than writing them, so
// tests can call it directly.

import { openDatabase } from "./client";
import { type Environment, openFailure, resolveDatabaseTarget, takePgliteOption } from "./target";

export type MigrateCliResult = { exitCode: number; stdout: string; stderr: string };

export const MIGRATE_USAGE = "Usage: npm run db:migrate [-- --pglite <dir>]";

export const EXIT_MIGRATED = 0;
export const EXIT_MIGRATE_FAILED = 2;

const failure = (error: string): MigrateCliResult => ({
  exitCode: EXIT_MIGRATE_FAILED,
  stdout: "",
  stderr: `${error}\n`,
});

export async function runMigrateCli(
  args: readonly string[],
  env: Environment,
): Promise<MigrateCliResult> {
  const option = takePgliteOption(args);
  if (!option.ok) return failure(`${option.error} ${MIGRATE_USAGE}`);
  const [extra] = option.rest;
  if (extra !== undefined) {
    const what = extra.startsWith("-") ? `Unknown option ${extra}.` : `Unexpected ${extra}.`;
    return failure(`${what} ${MIGRATE_USAGE}`);
  }
  const target = resolveDatabaseTarget(env, option.pgliteDir);

  let applied: number;
  try {
    const handle = await openDatabase(target, { migrate: false });
    try {
      applied = await handle.migrate();
    } finally {
      await handle.close().catch(() => {});
    }
  } catch (error) {
    return failure(openFailure(error, target));
  }
  const noun = applied === 1 ? "migration" : "migrations";
  return { exitCode: EXIT_MIGRATED, stdout: `Applied ${applied} ${noun}.\n`, stderr: "" };
}
