import { openDatabase, resolveDatabaseTarget } from "@countersign/db";
import { createPayPalClient } from "@countersign/rail-paypal";
import { type AppDeps, createApp } from "./app";

const port = Number(process.env.PORT ?? 8787);
const env = process.env;

// The database the CLIs use, PayPal's sandbox, the carrier mock over the database (createApp's
// default) and the principal keys, all from the environment. Without them the gate still answers
// /health: the webhook answers 503 so PayPal redelivers, /mcp answers 401 with no principal key,
// and a guarded call that can't be recorded answers that nothing was done.
async function dependencies(): Promise<AppDeps> {
  const deps: AppDeps = {
    env,
    rail: () => createPayPalClient({ env }),
    log: (line) => console.error(line),
  };
  try {
    const handle = await openDatabase(resolveDatabaseTarget(env, undefined));
    deps.db = handle.db;
  } catch {
    console.error(
      "gate started without a database; the PayPal webhook will answer 503 and guarded tools can't record.",
    );
  }
  return deps;
}

createApp(await dependencies()).listen(port, "0.0.0.0", () => {
  console.log(`gate listening on port ${port}`);
});
