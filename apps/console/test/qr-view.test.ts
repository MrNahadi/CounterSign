import { describe, expect, it } from "vitest";
import manifest from "../app/manifest";
import {
  approvalsUrl,
  pairedApprovalsUrl,
  QUIET_ZONE,
  qrView,
  requestOrigin,
} from "../src/qr-view";

describe("pairedApprovalsUrl", () => {
  const PLAIN = "https://countersign.example/approvals";
  const KEY = "approver-key-0123456789abcdefghijklmnop";
  const CODE = "AbCdEfGhIjKlMnOpQrSt_-";
  const env = { GATE_URL: "http://gate.test" };

  function gate(answer: () => Response | Promise<Response>) {
    const calls: { url: string; init: RequestInit | undefined }[] = [];
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      return answer();
    }) as typeof fetch;
    return { calls, deps: { env, fetch: fetchImpl } };
  }

  it("adds a fresh pairing code to the fragment when the gate mints one", async () => {
    const minted = gate(() =>
      Response.json({ code: CODE, expires_at: "2026-11-01T12:05:00.000Z" }, { status: 201 }),
    );
    expect(await pairedApprovalsUrl(PLAIN, KEY, minted.deps)).toBe(`${PLAIN}#pair=${CODE}`);
    expect(minted.calls).toHaveLength(1);
    const call = minted.calls[0];
    expect(call?.url).toBe("http://gate.test/approvals/pairing-codes");
    expect(call?.init?.method).toBe("POST");
    expect(new Headers(call?.init?.headers).get("authorization")).toBe(`Bearer ${KEY}`);
  });

  it("gives the plain URL for any answer but exactly 201 with a parsed code", async () => {
    for (const answer of [
      () => Response.json({ code: CODE }, { status: 200 }),
      () => Response.json({ message: "A valid approver key is required." }, { status: 401 }),
      () => Response.json({ code: CODE }, { status: 500 }),
      () => Response.json({ code: "short" }, { status: 201 }),
      () => Response.json({ code: `${CODE.slice(0, 21)}#` }, { status: 201 }),
      () => Response.json({}, { status: 201 }),
      () => new Response("<html>", { status: 201 }),
      () => Promise.reject(new Error("offline")),
    ]) {
      expect(await pairedApprovalsUrl(PLAIN, KEY, gate(answer).deps)).toBe(PLAIN);
    }
  });

  it("gives the plain URL when the gate's address isn't usable", async () => {
    const unset = gate(() => Response.json({ code: CODE }, { status: 201 }));
    expect(
      await pairedApprovalsUrl(PLAIN, KEY, {
        env: { GATE_URL: "ftp://gate" },
        fetch: unset.deps.fetch,
      }),
    ).toBe(PLAIN);
    expect(unset.calls).toEqual([]);
  });
});

describe("approvalsUrl", () => {
  it("uses CONSOLE_PUBLIC_URL when set", () => {
    expect(
      approvalsUrl({ publicUrl: "https://countersign.example/", origin: "http://localhost:3000" }),
    ).toBe("https://countersign.example/approvals");
  });
  it("falls back to the request origin", () => {
    expect(approvalsUrl({ publicUrl: undefined, origin: "http://192.168.1.5:3000" })).toBe(
      "http://192.168.1.5:3000/approvals",
    );
    expect(approvalsUrl({ publicUrl: "  ", origin: "http://192.168.1.5:3000" })).toBe(
      "http://192.168.1.5:3000/approvals",
    );
  });
  it("ignores a public URL that isn't http(s)", () => {
    expect(approvalsUrl({ publicUrl: "javascript:alert(1)", origin: "http://h:1" })).toBe(
      "http://h:1/approvals",
    );
  });
  it("is null when nothing usable is given", () => {
    expect(approvalsUrl({ publicUrl: "nope", origin: null })).toBeNull();
  });
});

describe("requestOrigin", () => {
  const headers = (h: Record<string, string>) => ({ get: (n: string) => h[n] ?? null });
  it("reads the forwarded protocol and host", () => {
    expect(requestOrigin(headers({ host: "a:1", "x-forwarded-proto": "https" }))).toBe(
      "https://a:1",
    );
    expect(requestOrigin(headers({ host: "a:1" }))).toBe("http://a:1");
    expect(requestOrigin(headers({}))).toBeNull();
  });
});

describe("qrView", () => {
  const view = qrView("https://countersign.example/approvals");
  it("draws rects inside the quiet zone, one module tall", () => {
    expect(view.rects.length).toBeGreaterThan(0);
    for (const r of view.rects) {
      expect(r.x).toBeGreaterThanOrEqual(QUIET_ZONE);
      expect(r.y).toBeGreaterThanOrEqual(QUIET_ZONE);
      expect(r.x + r.width).toBeLessThanOrEqual(view.size - QUIET_ZONE);
      expect(r.y).toBeLessThan(view.size - QUIET_ZONE);
    }
  });
  it("has the finder pattern's corner dark and labels the URL", () => {
    expect(view.rects).toContainEqual({ x: QUIET_ZONE, y: QUIET_ZONE, width: 7 });
    expect(view.label).toContain("https://countersign.example/approvals");
  });
  it("is deterministic", () => {
    expect(qrView(view.url)).toEqual(view);
  });
});

describe("manifest", () => {
  it("names the approvals app and carries no colours", () => {
    const m = manifest();
    expect(m).toMatchObject({
      name: "Countersign approvals",
      short_name: "Approvals",
      start_url: "/approvals",
      display: "standalone",
    });
    expect(m).not.toHaveProperty("theme_color");
    expect(m).not.toHaveProperty("background_color");
  });
});
