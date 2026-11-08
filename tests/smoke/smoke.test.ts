import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_URLS, type Fetch, join, main, parseUrls, smoke } from "./smoke";

const PAGE = '<!DOCTYPE html><html lang="en"><body>ok</body></html>';
const htmlPage = () =>
  new Response(PAGE, { headers: { "content-type": "text/html; charset=utf-8" } });
const healthy = () => Response.json({ ok: true });

const urls = {
  gate: "https://gate.example.test",
  resolve: "https://resolve.example.test",
  console: "https://console.example.test",
  storefront: "https://shop.example.test/base",
};

// A fake deployment: every check passes unless an override answers for that URL.
function fakeFetch(overrides: Record<string, () => Promise<Response> | Response> = {}) {
  const calls: string[] = [];
  const fetch: Fetch = async (url) => {
    calls.push(url);
    const override = overrides[url];
    if (override) return override();
    if (url.endsWith("/health")) return healthy();
    return htmlPage();
  };
  return { fetch, calls };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("smoke", () => {
  it("passes when every service answers", async () => {
    const { fetch, calls } = fakeFetch();
    const results = await smoke(urls, fetch);
    expect(results.map((r) => [r.name, r.ok])).toEqual([
      ["gate /health", true],
      ["resolve /health", true],
      ["console start page", true],
      ["storefront home", true],
    ]);
    expect(calls).toEqual([
      "https://gate.example.test/health",
      "https://resolve.example.test/health",
      "https://console.example.test/",
      "https://shop.example.test/base/",
    ]);
  });

  it("fails a non-200, a wrong health body, a non-HTML page and a network error", async () => {
    const { fetch } = fakeFetch({
      "https://gate.example.test/health": () => new Response("down", { status: 503 }),
      "https://resolve.example.test/health": () => Response.json({ ok: false }),
      "https://console.example.test/": () => Response.json({ ok: true }),
      "https://shop.example.test/base/": () =>
        Promise.reject(
          new TypeError("fetch failed", {
            cause: Object.assign(new Error("connect refused"), { code: "ECONNREFUSED" }),
          }),
        ),
    });
    const results = await smoke(urls, fetch);
    expect(results.every((r) => !r.ok)).toBe(true);
    expect(results.map((r) => r.detail)).toEqual([
      "HTTP 503",
      'body is not {"ok":true}',
      "content-type is application/json, not text/html",
      "request failed: fetch failed (ECONNREFUSED)",
    ]);
  });

  it("fails a check that times out", async () => {
    const hang: Fetch = (_url, { signal }) =>
      new Promise((_resolve, reject) =>
        signal.addEventListener("abort", () => reject(signal.reason)),
      );
    const results = await smoke(urls, hang, 5);
    expect(results.every((r) => !r.ok && r.detail.startsWith("request failed"))).toBe(true);
  });
});

describe("main", () => {
  it("prints one PASS line per check and exits 0", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const code = await main(["--gate", urls.gate], fakeFetch().fetch);
    expect(code).toBe(0);
    const lines = log.mock.calls.map(([line]) => String(line));
    expect(lines).toHaveLength(4);
    expect(lines.every((line) => line.startsWith("PASS "))).toBe(true);
    expect(lines[0]).toContain("https://gate.example.test/health");
    expect(lines[1]).toContain(`${DEFAULT_URLS.resolve}/health`);
  });

  it("exits 1 when any check fails, with one line per check", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const { fetch } = fakeFetch({
      "https://console.example.test/": () => new Response("boom", { status: 500 }),
    });
    const code = await main(
      ["--gate", urls.gate, "--resolve", urls.resolve, "--console", urls.console],
      fetch,
    );
    expect(code).toBe(1);
    const lines = log.mock.calls.map(([line]) => String(line));
    expect(lines).toHaveLength(4);
    expect(lines.filter((line) => line.startsWith("FAIL "))).toEqual([
      "FAIL console start page https://console.example.test/: HTTP 500",
    ]);
  });

  it("exits 2 on a bad URL, an unknown flag or a stray argument", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { fetch, calls } = fakeFetch();
    expect(await main(["--gate", "ftp://gate.example.test"], fetch)).toBe(2);
    expect(await main(["--gate", "not a url"], fetch)).toBe(2);
    expect(await main(["--carrier", urls.gate], fetch)).toBe(2);
    expect(await main([urls.gate], fetch)).toBe(2);
    expect(calls).toEqual([]);
  });
});

describe("parseUrls and join", () => {
  it("defaults every base URL to the local launcher", () => {
    expect(parseUrls([])).toEqual(DEFAULT_URLS);
  });

  it("keeps a base path and doesn't double a slash", () => {
    expect(join("https://a.test/x", "health")).toBe("https://a.test/x/health");
    expect(join("https://a.test/", "health")).toBe("https://a.test/health");
  });
});
