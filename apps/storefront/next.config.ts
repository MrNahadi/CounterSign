import { join } from "node:path";
import type { NextConfig } from "next";

// Local secrets live in the repo-root .env.local (see .env.example), but Next only reads env files
// from its own folder. Load the root one for server code; nothing here is exposed to the browser
// unless it starts with NEXT_PUBLIC_. On Render the variables come from the dashboard instead.
try {
  process.loadEnvFile(join(process.cwd(), "..", "..", ".env.local"));
} catch {
  // No local env file: fine in CI and on Render.
}

const config: NextConfig = {
  transpilePackages: ["@countersign/graphite", "@countersign/mandate", "@countersign/rail-paypal"],
};

export default config;
