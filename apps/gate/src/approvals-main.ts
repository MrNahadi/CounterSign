// Entry point for `npm run approvals -- list | show <id> | approve <id> --hash <hash> | deny <id>`.
// The root script loads .env.local when it's there.

import { runApprovals } from "./approvals-cli";

const { exitCode, stdout, stderr } = await runApprovals(process.argv.slice(2), process.env);
process.stdout.write(stdout);
process.stderr.write(stderr);
process.exitCode = exitCode;
