// Entry point for `npm run disputes -- <command> [--pglite <dir>]`. The root script
// loads .env.local when it's there.

import { runDisputes } from "./disputes-cli";

const { exitCode, stdout, stderr } = await runDisputes(process.argv.slice(2), process.env);
process.stdout.write(stdout);
process.stderr.write(stderr);
process.exitCode = exitCode;
