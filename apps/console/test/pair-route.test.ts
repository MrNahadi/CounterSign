import { describe, expect, it } from "vitest";
import {
  APPROVAL_ROUTE_MESSAGES,
  APPROVER_COOKIE,
  callGate,
  pairRoute,
} from "../src/approval-routes";
import { SESSION_COOKIE } from "../src/session-limits";

// The console's pairing route (ADR 0044): a phone trades a pairing code with the gate, which
// answers the approver key; the console keeps it in the cookie and never answers it.

const KEY = "approver-key-0123456789abcdefghijklmnop";
const CODE = "AbCdEfGhIjKlMnOpQrStUv";
const REFUSED = "That code has expired or was used. Sign in with the approver key.";
const env = { GATE_URL: "http://gate.test:8787" };

type Call = { url: string; init: RequestInit };

function gate(status: number, body: unknown) {
  const calls: Call[] = [];
  const fetchFake = (async (url: URL | string, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return typeof body === "string"
      ? new Response(body, { status })
      : Response.json(body, { status });
  }) as typeof fetch;
  return { calls, fetch: fetchFake };
}

const down = (async () => {
  throw new TypeError("fetch failed");
}) as typeof fetch;

function pair(body: string, origin = "http://localhost:3000") {
  return new Request(`${origin}/api/approvals/pair`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
}

const headersOf = (call: Call | undefined) => new Headers(call?.init.headers);

describe("pairRoute", () => {
  it("trades the code with the gate, with no key, and sets the key and session cookies", async () => {
    const fake = gate(200, { approver_key: KEY });
    const response = await pairRoute(pair(JSON.stringify({ code: CODE })), {
      env,
      fetch: fake.fetch,
    });
    expect(response.status).toBe(200);
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]?.url).toBe("http://gate.test:8787/approvals/pair");
    expect(fake.calls[0]?.init.method).toBe("POST");
    expect(fake.calls[0]?.init.redirect).toBe("error");
    expect(headersOf(fake.calls[0]).has("authorization")).toBe(false);
    expect(JSON.parse(String(fake.calls[0]?.init.body))).toEqual({ code: CODE });

    const [key, session] = response.headers.getSetCookie();
    expect(key).toBe(
      `${APPROVER_COOKIE}=${encodeURIComponent(KEY)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200`,
    );
    expect(session).toMatch(
      new RegExp(
        `^${SESSION_COOKIE}=[A-Za-z0-9_-]{22}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200$`,
      ),
    );
    expect(response.headers.get("cache-control")).toBe("no-store");
    const text = await response.text();
    expect(JSON.parse(text)).toEqual({ ok: true });
    expect(text).not.toContain(KEY);
  });

  it("marks both cookies Secure over HTTPS", async () => {
    const response = await pairRoute(pair(JSON.stringify({ code: CODE }), "https://console.test"), {
      env,
      fetch: gate(200, { approver_key: KEY }).fetch,
    });
    const cookies = response.headers.getSetCookie();
    expect(cookies).toHaveLength(2);
    for (const cookie of cookies) expect(cookie).toMatch(/; Secure$/);
  });

  it("passes the gate's 401 sentence and sets no cookie", async () => {
    const response = await pairRoute(pair(JSON.stringify({ code: CODE })), {
      env,
      fetch: gate(401, { message: REFUSED }).fetch,
    });
    expect(response.status).toBe(401);
    expect(response.headers.getSetCookie()).toEqual([]);
    expect(await response.json()).toEqual({ message: REFUSED });
  });

  it("answers 502 when the gate is down, answers junk or another status", async () => {
    for (const fetchFake of [
      down,
      gate(200, { approver_key: "short" }).fetch,
      gate(200, "oops").fetch,
      gate(401, "oops").fetch,
      gate(500, { message: "Broken." }).fetch,
      gate(404, { message: "Not here." }).fetch,
    ]) {
      const response = await pairRoute(pair(JSON.stringify({ code: CODE })), {
        env,
        fetch: fetchFake,
      });
      expect(response.status).toBe(502);
      expect(response.headers.getSetCookie()).toEqual([]);
      expect(await response.json()).toEqual({ message: APPROVAL_ROUTE_MESSAGES.unreachable });
    }
  });

  it("answers 502 when GATE_URL isn't an http(s) URL", async () => {
    const fake = gate(200, { approver_key: KEY });
    const response = await pairRoute(pair(JSON.stringify({ code: CODE })), {
      env: { GATE_URL: "ftp://gate.test" },
      fetch: fake.fetch,
    });
    expect(response.status).toBe(502);
    expect(fake.calls).toHaveLength(0);
  });

  it("refuses a body that isn't { code } or is over 1 KB without asking the gate", async () => {
    for (const body of [
      "not json",
      "{}",
      JSON.stringify({ code: 7 }),
      JSON.stringify({ code: CODE, extra: 1 }),
      JSON.stringify({ code: CODE, pad: "x".repeat(1100) }),
    ]) {
      const fake = gate(200, { approver_key: KEY });
      const response = await pairRoute(pair(body), { env, fetch: fake.fetch });
      expect(response.status).toBe(400);
      expect(fake.calls).toHaveLength(0);
      expect(response.headers.getSetCookie()).toEqual([]);
      expect(await response.json()).toEqual({ message: APPROVAL_ROUTE_MESSAGES.badPair });
    }
  });
});

describe("callGate", () => {
  it("sends no authorization header with a null key, and the bearer with a key", async () => {
    const fake = gate(200, {});
    await callGate({ env, fetch: fake.fetch }, null, "/approvals/pair", { json: "{}" });
    await callGate({ env, fetch: fake.fetch }, KEY, "/approvals");
    expect(headersOf(fake.calls[0]).has("authorization")).toBe(false);
    expect(headersOf(fake.calls[1]).get("authorization")).toBe(`Bearer ${KEY}`);
  });
});
