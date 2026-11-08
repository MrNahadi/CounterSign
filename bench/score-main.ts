// Entry point for `npm run bench:score`: scores every file in bench/results and writes the
// summaries into them and the tables into bench/README.md.

import { fileURLToPath } from "node:url";
import { scoreBench } from "./score";

const root = fileURLToPath(new URL("..", import.meta.url));
const { exitCode, stdout, stderr } = scoreBench(process.argv.slice(2), { root });
process.stdout.write(stdout);
process.stderr.write(stderr);
process.exitCode = exitCode;
