// Entry point for `npm run reconcile [-- --pglite <dir>]`. The root script
// loads .env.local when it's there.

import { runReconcile } from "./reconcile-cli";

const { exitCode, stdout, stderr } = await runReconcile(process.argv.slice(2), process.env);
process.stdout.write(stdout);
process.stderr.write(stderr);
process.exitCode = exitCode;
