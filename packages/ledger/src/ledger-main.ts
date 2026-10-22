// Entry point for `npm run ledger -- verify | tail [count] | check-export <file>`.

import { runLedgerCli } from "./cli";

const { exitCode, stdout, stderr } = await runLedgerCli(process.argv.slice(2), process.env);
process.stdout.write(stdout);
process.stderr.write(stderr);
process.exitCode = exitCode;
