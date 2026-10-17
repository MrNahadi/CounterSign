// Entry point for `npm run decide -- <case file> [--json]`.

import { runDecideCli } from "./decide-cli";

const { exitCode, stdout, stderr } = runDecideCli(process.argv.slice(2));
process.stdout.write(stdout);
process.stderr.write(stderr);
process.exitCode = exitCode;
