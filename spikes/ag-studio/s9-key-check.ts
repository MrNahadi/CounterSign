// Spike S9, check 6 (ADR 0016): the console's production build sends no Gemini key to the browser.
// Run after `npm run build`: node spikes/ag-studio/s9-key-check.ts
// It scans what the browser can receive: the client bundle (.next/static) and the prerendered
// HTML and RSC payloads. It prints counts and file names only, never the key.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

const root = join(import.meta.dirname, "..", "..");
try {
  process.loadEnvFile(join(root, ".env.local"));
} catch {
  // No local env file: the value check is skipped below.
}
const key = process.env.GEMINI_API_KEY ?? "";
const next = join(root, "apps", "console", ".next");

function* walk(dir: string): Generator<string> {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(path);
    else yield path;
  }
}

const sentToBrowser = [
  ...walk(join(next, "static")),
  ...[...walk(join(next, "server", "app"))].filter((p) => /\.(html|rsc|body|meta)$/.test(p)),
];
if (sentToBrowser.length === 0) {
  console.error("No build output found. Run `npm run build` first.");
  process.exit(2);
}

const needles = [
  { label: "the key's value", value: key },
  { label: "Google's AIza key prefix", value: "AIza" },
  { label: "the name GEMINI_API_KEY", value: "GEMINI_API_KEY" },
];

let failed = false;
console.log(`Scanned ${sentToBrowser.length} files the browser can receive.`);
for (const { label, value } of needles) {
  if (!value) {
    console.log(`- ${label}: skipped, GEMINI_API_KEY isn't set`);
    continue;
  }
  const hits = sentToBrowser.filter((p) => readFileSync(p, "latin1").includes(value));
  failed ||= hits.length > 0;
  console.log(`- ${label}: ${hits.length === 0 ? "not found" : `FOUND in ${hits.length} files`}`);
  for (const hit of hits) console.log(`    ${relative(root, hit)}`);
}
process.exit(failed ? 1 : 0);
