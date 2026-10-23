import { describe, expect, it } from "vitest";
import { APPROVAL_ROUTE_MESSAGES, APPROVER_COOKIE } from "../src/approval-routes";
import { DISPUTE_ROUTE_MESSAGES, disputesRoute, draftAgainRoute } from "../src/dispute-routes";
import { RESOLVE_UNREACHABLE } from "../src/resolve-routes";

// The console's dispute routes (ADR 0038): the approvals sign-in, checked with the gate, then
// Resolve's `GET /disputes` and `POST /disputes`. The gate and Resolve are one injected fetch.

const ORIGIN = "http://console.test";
const KEY = "approver-key-0123456789abcdefghijklmnop";
const env = { GATE_URL: "http://gate.test", RESOLVE_AGENT_URL: "http://resolve.test" };

const draft = {
  draft_id: `drf_${"a".repeat(32)}`,
  dispute_id: "PP-D-1",
  status: "failed",
  outcome: "gate_unavailable",
  drafted_by: null,
  model: "gemini-3.5-flash-lite",
  model_versions: [],
  agent_response_status: null,
  intent_id: null,
  dispute: {
    reason_words: "Item not received",
    amount: { minor: 24000, currency: "USD", display: "$240.00" },
  },
  queued_at: "2026-10-23T11:55:00.000Z",
  started_at: "2026-10-23T11:55:00.000Z",
  finished_at: "2026-10-23T11:55:01.000Z",
};

type Call = { url: string; init: RequestInit };
type Reply = { status: number; body: unknown } | "down";

// Answers each `host path` (method first for a POST) from `replies`; anything else is a 404.
function services(replies: Record<string, Reply>) {
  const calls: Call[] = [];
  const fetchFake = (async (url: URL | string, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const at = new URL(String(url));
    const method = init?.method ?? "GET";
    const reply = replies[`${method} ${at.host}${at.pathname}`];
    if (reply === "down") throw new TypeError("fetch failed");
    if (reply === undefined) return Response.json({ message: "Not here." }, { status: 404 });
    const text = typeof reply.body === "string" ? reply.body : JSON.stringify(reply.body);
    return new Response(text, {
      status: reply.status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return { calls, fetch: fetchFake };
}

const GATE_OK: Record<string, Reply> = {
  "GET gate.test/approvals": { status: 200, body: { open: [], recent: [] } },
};

const signedIn = `theme=dark; ${APPROVER_COOKIE}=${encodeURIComponent(KEY)}`;

function get(cookie: string | null = signedIn) {
  const headers = new Headers();
  if (cookie !== null) headers.set("cookie", cookie);
  return new Request(`${ORIGIN}/api/disputes`, { headers });
}

function post(body: unknown, cookie: string | null = signedIn) {
  const headers = new Headers({ "content-type": "application/json" });
  if (cookie !== null) headers.set("cookie", cookie);
  return new Request(`${ORIGIN}/api/disputes`, {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

const resolveCalls = (calls: Call[]) => calls.filter((c) => c.url.startsWith("http://resolve"));

const message = async (response: Response) => (await response.json()) as { message: string };

describe("the dispute routes' sign-in", () => {
  const ROUTES = [
    {
      name: "GET",
      run: (cookie: string | null, f: typeof fetch) =>
        disputesRoute(get(cookie), { env, fetch: f }),
    },
    {
      name: "POST",
      run: (cookie: string | null, f: typeof fetch) =>
        draftAgainRoute(post({ dispute_id: "PP-D-1" }, cookie), { env, fetch: f }),
    },
  ];

  for (const route of ROUTES) {
    it(`${route.name} answers 401 signed out without asking anyone`, async () => {
      const fake = services(GATE_OK);
      const response = await route.run(null, fake.fetch);
      expect(response.status).toBe(401);
      expect(await message(response)).toEqual({ message: APPROVAL_ROUTE_MESSAGES.signedOut });
      expect(fake.calls).toEqual([]);

      const malformed = await route.run(`${APPROVER_COOKIE}=short`, fake.fetch);
      expect(malformed.status).toBe(401);
      expect(await message(malformed)).toEqual({ message: APPROVAL_ROUTE_MESSAGES.signInAgain });
      expect(malformed.headers.get("set-cookie")).toContain("Max-Age=0");
      expect(fake.calls).toEqual([]);
    });

    it(`${route.name} checks the key with the gate and never sends it to Resolve`, async () => {
      const fake = services({
        "GET gate.test/approvals": { status: 401, body: { message: "Unauthorized." } },
      });
      const refused = await route.run(signedIn, fake.fetch);
      expect(refused.status).toBe(401);
      expect(await message(refused)).toEqual({ message: APPROVAL_ROUTE_MESSAGES.signInAgain });
      expect(refused.headers.get("set-cookie")).toContain("Max-Age=0");
      expect(fake.calls.map((c) => c.url)).toEqual(["http://gate.test/approvals"]);
      expect(new Headers(fake.calls[0]?.init.headers).get("authorization")).toBe(`Bearer ${KEY}`);

      for (const gate of [
        "down",
        { status: 200, body: { open: "nope" } },
        { status: 500, body: "oops" },
        { status: 503, body: "no sentence" },
      ] satisfies Reply[]) {
        const down = services({ "GET gate.test/approvals": gate });
        const response = await route.run(signedIn, down.fetch);
        expect(response.status).toBe(502);
        expect(await message(response)).toEqual({ message: APPROVAL_ROUTE_MESSAGES.unreachable });
        expect(resolveCalls(down.calls)).toEqual([]);
      }

      // The gate checks the key before its log, so its 503 sentence still signs the request in.
      const busy = services({
        "GET gate.test/approvals": {
          status: 503,
          body: { message: "The audit log isn't readable." },
        },
        "GET resolve.test/disputes": { status: 200, body: { drafts: [draft] } },
        "POST resolve.test/disputes": { status: 202, body: draft },
      });
      const response = await route.run(signedIn, busy.fetch);
      expect([200, 202]).toContain(response.status);
      const toResolve = resolveCalls(busy.calls);
      expect(toResolve).toHaveLength(1);
      expect(new Headers(toResolve[0]?.init.headers).get("authorization")).toBeNull();
      expect(JSON.stringify(toResolve)).not.toContain(KEY);
    });
  }
});

describe("GET /api/disputes", () => {
  it("answers Resolve's drafts as parsed", async () => {
    const fake = services({
      ...GATE_OK,
      "GET resolve.test/disputes": {
        status: 200,
        body: { drafts: [{ ...draft, facts_summary: { payer: "x" } }] },
      },
    });
    const response = await disputesRoute(get(), { env, fetch: fake.fetch });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ drafts: [draft] });
  });

  it("answers 502 when Resolve is down or answers junk", async () => {
    for (const reply of [
      "down",
      { status: 200, body: { drafts: [{ ...draft, status: "odd" }] } },
      { status: 200, body: "not json" },
      { status: 503, body: { message: "No database." } },
    ] satisfies Reply[]) {
      const fake = services({ ...GATE_OK, "GET resolve.test/disputes": reply });
      const response = await disputesRoute(get(), { env, fetch: fake.fetch });
      expect(response.status).toBe(502);
      expect(await message(response)).toEqual({ message: RESOLVE_UNREACHABLE });
    }
  });
});

describe("POST /api/disputes", () => {
  it("sends exactly { dispute_id } to Resolve and passes its draft on", async () => {
    const fake = services({
      ...GATE_OK,
      "POST resolve.test/disputes": { status: 202, body: draft },
    });
    const response = await draftAgainRoute(post({ dispute_id: "PP-D-1" }), {
      env,
      fetch: fake.fetch,
    });
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual(draft);
    const [sent] = resolveCalls(fake.calls);
    expect(sent?.init.method).toBe("POST");
    expect(JSON.parse(String(sent?.init.body))).toEqual({ dispute_id: "PP-D-1" });

    // A draft that's already live is answered as it is (200).
    const live = { ...draft, status: "running", outcome: null };
    const again = services({
      ...GATE_OK,
      "POST resolve.test/disputes": { status: 200, body: live },
    });
    const answer = await draftAgainRoute(post({ dispute_id: "PP-D-1" }), {
      env,
      fetch: again.fetch,
    });
    expect(answer.status).toBe(200);
    expect(await answer.json()).toEqual(live);
  });

  it("refuses a body that isn't exactly { dispute_id } before asking Resolve", async () => {
    for (const body of [
      "not json",
      {},
      { dispute_id: "" },
      { dispute_id: "PP D 1" },
      { dispute_id: "P".repeat(65) },
      { dispute_id: 12 },
      { dispute_id: "PP-D-1", mode: "baseline" },
    ]) {
      const fake = services({
        ...GATE_OK,
        "POST resolve.test/disputes": { status: 202, body: draft },
      });
      const response = await draftAgainRoute(post(body), { env, fetch: fake.fetch });
      expect(response.status).toBe(400);
      expect(await message(response)).toEqual({ message: DISPUTE_ROUTE_MESSAGES.badRequest });
      expect(resolveCalls(fake.calls)).toEqual([]);
    }
  });

  it("passes Resolve's refusal on, and answers 502 for anything else", async () => {
    const refused = services({
      ...GATE_OK,
      "POST resolve.test/disputes": { status: 400, body: { message: "Not a dispute ID." } },
    });
    const response = await draftAgainRoute(post({ dispute_id: "PP-D-1" }), {
      env,
      fetch: refused.fetch,
    });
    expect(response.status).toBe(400);
    expect(await message(response)).toEqual({ message: "Not a dispute ID." });

    for (const reply of [
      "down",
      { status: 202, body: { ...draft, dispute_id: "PP-D-2" } },
      { status: 202, body: { drafts: [] } },
      { status: 500, body: { message: "Resolve couldn't queue the draft. Try again." } },
      { status: 400, body: "junk" },
    ] satisfies Reply[]) {
      const fake = services({ ...GATE_OK, "POST resolve.test/disputes": reply });
      const answer = await draftAgainRoute(post({ dispute_id: "PP-D-1" }), {
        env,
        fetch: fake.fetch,
      });
      expect(answer.status).toBe(502);
      expect(await message(answer)).toEqual({ message: RESOLVE_UNREACHABLE });
    }
  });
});
