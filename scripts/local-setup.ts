import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync } from "node:fs";
import { join } from "node:path";

// Environment files are loaded by Node before this script. Never display their values.
const root = join(import.meta.dirname, "..");
const keyNames = [
  "COUNTERSIGN_SUPPORT_AGENT_KEY",
  "COUNTERSIGN_OPS_AGENT_KEY",
  "COUNTERSIGN_APPROVER_KEY",
] as const;
const configured = keyNames.map((name) => ({ name, value: process.env[name]?.trim() || "" }));
const invalid = configured.filter(({ value }) => value !== "" && value.length < 32);
const existing = configured.filter(({ value }) => value !== "");
const duplicates = existing.filter(({ value }, index) =>
  existing.some((other, otherIndex) => otherIndex !== index && other.value === value),
);
if (invalid.length || duplicates.length) {
  const names = [...new Set([...invalid, ...duplicates].map(({ name }) => name))];
  console.error(`Fix these variables first (32+ characters, all different): ${names.join(", ")}.`);
  process.exitCode = 1;
} else {
  const additions = configured
    .filter(({ value }) => value === "")
    .map(({ name }) => `${name}=${randomBytes(32).toString("hex")}`);
  const defaults = {
    PAYPAL_BASE_URL: "https://api-m.sandbox.paypal.com",
    COUNTERSIGN_DEMO_RESET: "on",
    RESOLVE_BASELINE: "scenarios",
  };
  for (const [name, value] of Object.entries(defaults)) {
    if (!process.env[name]?.trim()) additions.push(`${name}=${value}`);
  }
  if (additions.length) {
    appendFileSync(
      join(root, ".env.local"),
      `\n# Local development settings. Sandbox only; never commit this file.\n${additions.join("\n")}\n`,
      { mode: 0o600 },
    );
  }
  console.log("Local settings ready. Existing configuration was preserved.");
  console.log(
    "Sign in using COUNTERSIGN_APPROVER_KEY from your environment file; keys are never printed.",
  );
  const missing = ["PAYPAL_CLIENT_ID", "PAYPAL_CLIENT_SECRET", "GEMINI_API_KEY"].filter(
    (name) => !process.env[name]?.trim(),
  );
  if (missing.length) console.log(`Live sandbox runs still need: ${missing.join(", ")}.`);
  const vaults = ["PAYPAL_SEED_VAULT_TOKEN", "PAYPAL_SEED_VAULT_TOKEN_B"].filter(
    (name) => !process.env[name]?.trim(),
  );
  if (vaults.length) console.log(`Seeding the demo orders still needs: ${vaults.join(", ")}.`);
  if (!existsSync(join(root, "node_modules")))
    console.log("Install dependencies with npm ci first.");
  console.log("Start all four apps with npm run dev. Stop them with Ctrl+C.");
}
