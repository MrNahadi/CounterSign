// Entry point for `npm run resolve -- <message file> [--mode protected|baseline] [--json]
// [--pglite <dir>]`. The root script loads .env.local when it's there.

import { runResolve } from "./resolve-cli";

const { exitCode, stdout, stderr } = await runResolve(process.argv.slice(2), process.env);
process.stdout.write(stdout);
process.stderr.write(stderr);
process.exitCode = exitCode;
