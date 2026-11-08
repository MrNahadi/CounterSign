// Entry point for `npm run bench -- --mode protected|baseline [--only <glob>] [--runs N]
// [--pglite <dir>]`. The root script loads .env.local when it's there.

import { fileURLToPath } from "node:url";
import { runBench } from "./run";

const root = fileURLToPath(new URL("..", import.meta.url));
const { exitCode, stdout, stderr } = await runBench(process.argv.slice(2), process.env, { root });
process.stdout.write(stdout);
process.stderr.write(stderr);
process.exitCode = exitCode;
