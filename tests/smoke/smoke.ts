import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { z } from "zod";

// The hosted demo's smoke test: the gate's and Resolve's /health, the console's start page and the
// storefront's home. One line per check, exit 0 when all pass, 1 on any failure, 2 on bad arguments.
//
//   npm run smoke -- [--gate <url>] [--resolve <url>] [--console <url>] [--storefront <url>]
//
// Each base URL defaults to the local launcher's port (`npm run dev`).

export const DEFAULT_URLS = {
  gate: "http://127.0.0.1:8787",
  resolve: "http://127.0.0.1:8788",
  console: "http://127.0.0.1:3000",
  storefront: "http://127.0.0.1:3001",
} as const;

export type Service = keyof typeof DEFAULT_URLS;
export type BaseUrls = Record<Service, string>;
export type Fetch = (url: string, init: { signal: AbortSignal }) => Promise<Response>;

export interface CheckResult {
  name: string;
  url: string;
  ok: boolean;
  detail: string;
}

// A check needs 200 and the right body. The first request to a Next dev server compiles the page,
// so the timeout is generous.
export const TIMEOUT_MS = 30_000;

const health = z.object({ ok: z.literal(true) });
const httpUrl = z.url({ protocol: /^https?$/ });

interface Check {
  name: string;
  service: Service;
  path: string;
  verify: (res: Response) => Promise<string | undefined>;
}

async function healthy(res: Response): Promise<string | undefined> {
  const body: unknown = await res.json().catch(() => undefined);
  return health.safeParse(body).success ? undefined : 'body is not {"ok":true}';
}

async function html(res: Response): Promise<string | undefined> {
  const type = res.headers.get("content-type") ?? "";
  if (!type.includes("text/html")) return `content-type is ${type || "missing"}, not text/html`;
  const body = await res.text();
  return /<html[\s>]/i.test(body) ? undefined : "body is not an HTML page";
}

const CHECKS: readonly Check[] = [
  { name: "gate /health", service: "gate", path: "health", verify: healthy },
  { name: "resolve /health", service: "resolve", path: "health", verify: healthy },
  { name: "console start page", service: "console", path: "", verify: html },
  { name: "storefront home", service: "storefront", path: "", verify: html },
];

// Joins a path onto a base URL and keeps any path the base already has.
export function join(base: string, path: string): string {
  return new URL(path, base.endsWith("/") ? base : `${base}/`).toString();
}

async function run(check: Check, url: string, fetch: Fetch, timeoutMs: number) {
  const started = performance.now();
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (res.status !== 200) return { ok: false, detail: `HTTP ${res.status}` };
    const problem = await check.verify(res);
    const ms = Math.round(performance.now() - started);
    return problem ? { ok: false, detail: problem } : { ok: true, detail: `HTTP 200, ${ms} ms` };
  } catch (error) {
    return { ok: false, detail: `request failed: ${reason(error)}` };
  }
}

// Node's fetch says only "fetch failed"; the cause holds the useful part, such as ECONNREFUSED.
function reason(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const cause: unknown = error.cause;
  if (cause instanceof Error) {
    const code = (cause as { code?: unknown }).code;
    return `${error.message} (${typeof code === "string" ? code : cause.message})`;
  }
  return error.message;
}

export async function smoke(
  urls: BaseUrls,
  fetch: Fetch = globalThis.fetch,
  timeoutMs = TIMEOUT_MS,
): Promise<CheckResult[]> {
  return Promise.all(
    CHECKS.map(async (check) => {
      const url = join(urls[check.service], check.path);
      return { name: check.name, url, ...(await run(check, url, fetch, timeoutMs)) };
    }),
  );
}

export function format(result: CheckResult): string {
  return `${result.ok ? "PASS" : "FAIL"} ${result.name} ${result.url}: ${result.detail}`;
}

export function parseUrls(argv: string[]): BaseUrls {
  const { values, positionals } = parseArgs({
    args: argv,
    strict: true,
    allowPositionals: true,
    options: {
      gate: { type: "string" },
      resolve: { type: "string" },
      console: { type: "string" },
      storefront: { type: "string" },
    },
  });
  if (positionals.length > 0) throw new Error(`unexpected argument: ${positionals[0]}`);
  const urls = { ...DEFAULT_URLS, ...values };
  for (const [service, url] of Object.entries(urls)) {
    if (!httpUrl.safeParse(url).success) throw new Error(`--${service} is not an http(s) URL`);
  }
  return urls;
}

export async function main(argv: string[], fetch: Fetch = globalThis.fetch): Promise<number> {
  let urls: BaseUrls;
  try {
    urls = parseUrls(argv);
  } catch (error) {
    console.error(`smoke: ${error instanceof Error ? error.message : String(error)}`);
    console.error(
      "usage: npm run smoke -- [--gate <url>] [--resolve <url>] [--console <url>] [--storefront <url>]",
    );
    return 2;
  }
  const results = await smoke(urls, fetch);
  for (const result of results) console.log(format(result));
  return results.every((result) => result.ok) ? 0 : 1;
}

const entry = process.argv[1];
if (entry && realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url))) {
  process.exitCode = await main(process.argv.slice(2));
}
