// Entry point for `npm run db:migrate`.

import { runMigrateCli } from "./migrate-cli";

const { exitCode, stdout, stderr } = await runMigrateCli(process.argv.slice(2), process.env);
process.stdout.write(stdout);
process.stderr.write(stderr);
process.exitCode = exitCode;
