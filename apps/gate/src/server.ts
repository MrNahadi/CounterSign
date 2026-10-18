import { openDatabase, resolveDatabaseTarget } from "@countersign/db";
import { createPayPalClient } from "@countersign/rail-paypal";
import { type AppDeps, createApp } from "./app";

const port = Number(process.env.PORT ?? 8787);
const env = process.env;

// The database the CLIs use. Without one the gate still answers /health, and the webhook
// answers 503 so PayPal redelivers.
async function dependencies(): Promise<AppDeps> {
  const deps: AppDeps = { env, rail: () => createPayPalClient({ env }) };
  try {
    const handle = await openDatabase(resolveDatabaseTarget(env, undefined));
    deps.db = handle.db;
  } catch {
    console.error("gate started without a database; the PayPal webhook will answer 503.");
  }
  return deps;
}

createApp(await dependencies()).listen(port, "0.0.0.0", () => {
  console.log(`gate listening on port ${port}`);
});
