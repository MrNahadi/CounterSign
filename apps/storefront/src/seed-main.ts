// Entry point for `npm run seed -- [--run <run>] | --dry-run | list`.

import { runSeedCli } from "./seed-cli";

const { exitCode, stdout, stderr } = await runSeedCli(process.argv.slice(2), process.env);
process.stdout.write(stdout);
process.stderr.write(stderr);
process.exitCode = exitCode;
