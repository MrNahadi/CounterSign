// Entry point for `npm run decide -- <case file> [--json] [--record [--pglite <dir>]]`.

import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runDecide } from "./decide-cli";

// Only recording needs the environment (DATABASE_URL). Like --env-file-if-exists, this loads
// .env.local when it's there, never overrides a variable that's already set, and carries on
// without it, so the script itself stays as it was in phase 3.
const args = process.argv.slice(2);
if (args.includes("--record")) {
  const envFile = fileURLToPath(new URL("../../../.env.local", import.meta.url));
  if (existsSync(envFile)) process.loadEnvFile(envFile);
}

const { exitCode, stdout, stderr } = await runDecide(args, process.env);
process.stdout.write(stdout);
process.stderr.write(stderr);
process.exitCode = exitCode;
