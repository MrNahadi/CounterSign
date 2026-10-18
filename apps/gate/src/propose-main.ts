// Entry point for `npm run propose -- <proposal file> [--json] [--pglite <dir>]`. The root script
// loads .env.local when it's there.

import { runPropose } from "./propose-cli";

const { exitCode, stdout, stderr } = await runPropose(process.argv.slice(2), process.env);
process.stdout.write(stdout);
process.stderr.write(stderr);
process.exitCode = exitCode;
