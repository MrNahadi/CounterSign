// Entry point for `npm run audit -- show <seq> | export (--intent <id> | --capture <id>)`.
// The root script loads .env.local when it's there.

import { runAudit } from "./audit-cli";

const { exitCode, stdout, stderr } = await runAudit(process.argv.slice(2), process.env);
process.stdout.write(stdout);
process.stderr.write(stderr);
process.exitCode = exitCode;
