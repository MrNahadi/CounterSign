// Entry point for `npm run agent -- <proposal file> [--json] [--url <gate MCP URL>] [--pglite <dir>]`.
// The root script loads .env.local when it's there.

import { runAgent } from "./agent-cli";

const { exitCode, stdout, stderr } = await runAgent(process.argv.slice(2), process.env);
process.stdout.write(stdout);
process.stderr.write(stderr);
process.exitCode = exitCode;
