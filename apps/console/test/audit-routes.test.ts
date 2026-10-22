import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { APPROVAL_ROUTE_MESSAGES, APPROVER_COOKIE } from "../src/approval-routes";
import {
  AUDIT_ROUTE_MESSAGES,
  auditDecisionRoute,
  auditDecisionsRoute,
  auditEntriesRoute,
  auditExportRoute,
  auditIntentRoute,
  auditVerifyRoute,
  loadDecision,
  loadDecisions,
  loadEntries,
  loadExport,
  loadIntentDecision,
  loadVerify,
} from "../src/audit-routes";

// The console's audit routes (ADR 0034), with the gate played by an injected fetch.

const KEY = "approver-key-0123456789abcdefghijklmnop";
const INTENT = `int_${"b".repeat(24)}`;
const HASH = "a".repeat(64);
const ORIGIN = "http://localhost:3000";
const env = { GATE_URL: "http://gate.test:8787" };

const amount = { minor: 24000, currency: "USD", display: "$240.00" };

const row = {
  readable: true,
  seq: 12,
  at: "2026-10-20T08:01:00.000Z",
  principal: "support-agent",
  intent_id: INTENT,
  action: "paypal.refund",
  action_words: "Refund",
  amount,
  target: { kind: "capture", id: "CAP-1037", order_id: "ORD-1037" },
  order_number: "KIK-1037",
  sender: "payer@example.com",
  claim: "damaged",
  claim_words: "Says the item arrived damaged",
  decision: "allow",
  reasons: [],
  matched_rules: ["refund-damaged"],
  status: {
    kind: "executed",
    execution: { outcome: "executed", refund: { id: "4XJ1", status: "COMPLETED" }, invoice: null },
  },
};

const rowsPage = {
  rows: [
    row,
    { readable: false, seq: 11, at: "2026-10-20T08:00:00.000Z", problem: "It isn't JSON." },
  ],
  counts: { all: 2, allowed: 1, stepped_up: 0, denied: 0 },
  next_before: null,
};

const detail = {
  ...row,
  intent_hash: HASH,
  intent_canonical: '{"action":"paypal.refund"}',
  mandate: { id: "kikapu-studio", version: 3, hash: "c".repeat(64), seq: 1 },
  usage: { known: true, date: "2026-10-20", per_currency: [] },
  safe_reply_hint: null,
  expires_at: null,
  claims: [
    {
      check: "evidence.photo_present",
      claim: { text: "1 photo attached", quote: null, simulated: true },
      record: {
        words: "Photo of the damage",
        detail: "1 photo.",
        value: "1",
        sources: [{ words: "Ticket store", call: "tickets.read", id: "tkt_1" }],
      },
      verdict: "matches",
    },
  ],
  trace: [
    {
      verifier: "evidence.photo_present",
      words: "Photo of the damage",
      result: "pass",
      value: "1",
      detail: "1 photo.",
      records: [{ words: "Ticket store", call: "tickets.read", id: "tkt_1" }],
    },
  ],
  ticket: null,
  proposal: "{}",
  proposal_truncated: false,
  entry: {
    seq: 12,
    at: "2026-10-20T08:01:00.000Z",
    hash: "d".repeat(64),
    prev_hash: "e".repeat(64),
  },
  trail: [
    {
      seq: 12,
      type: "decision",
      at: "2026-10-20T08:01:00.000Z",
      hash: "d".repeat(64),
      readable: true,
      parts: { kind: "decision", decision: "allow" },
    },
    {
      seq: 13,
      type: "execution.result",
      at: "x",
      hash: "f".repeat(64),
      readable: false,
      problem: "Bad.",
    },
  ],
};

const entries = {
  entries: [
    {
      seq: 13,
      type: "execution.result",
      ref: INTENT,
      at: "2026-10-20T08:02:00.000Z",
      hash: "f".repeat(64),
      prev_hash: "d".repeat(64),
      summary: "PayPal refunded it: 4XJ1 completed.",
      readable: true,
      problem: null,
    },
  ],
  total: 13,
  next_before: null,
};

const verdict = {
  intact: true,
  entry_count: 13,
  head: { seq: 13, hash: "f".repeat(64) },
  problems: [],
};

const evidence = `${JSON.stringify(
  {
    format: "countersign-evidence-v1",
    exported_at: "2026-10-20T09:00:00.000Z",
    scope: { kind: "intent", id: INTENT },
    chain: {
      intact: true,
      entry_count: 13,
      head: { seq: 13, hash: "f".repeat(64) },
      problem_count: 0,
    },
    entries: [],
    check: "Each entry's hash can be recomputed from its fields.",
  },
  null,
  2,
)}\n`;

type Call = { url: string; init: RequestInit };
type Reply = { status: number; body: unknown; headers?: Record<string, string> };

// A gate that answers each path (without its query) from `replies`, and 404 otherwise.
function gate(replies: Record<string, Reply>) {
  const calls: Call[] = [];
  const fetchFake = (async (url: URL | string, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const reply = replies[new URL(String(url)).pathname];
    if (reply === undefined) return Response.json({ message: "Not here." }, { status: 404 });
    const text = typeof reply.body === "string" ? reply.body : JSON.stringify(reply.body);
    return new Response(text, {
      status: reply.status,
      headers: { "content-type": "application/json", ...reply.headers },
    });
  }) as typeof fetch;
  return { calls, fetch: fetchFake };
}

const okGate = () =>
  gate({
    "/audit/decisions": { status: 200, body: { ...rowsPage, key: KEY } },
    "/audit/decisions/12": { status: 200, body: { ...detail, bearer: KEY } },
    "/audit/intents/int_bbbbbbbbbbbbbbbbbbbbbbbb": { status: 200, body: { decision_seq: 12 } },
    "/audit/entries": { status: 200, body: entries },
    "/audit/verify": { status: 200, body: verdict },
    "/audit/export": {
      status: 200,
      body: evidence,
      headers: {
        "content-disposition": `attachment; filename="countersign-evidence-intent-${INTENT}.json"`,
      },
    },
  });

const down = (async () => {
  throw new TypeError("fetch failed");
}) as typeof fetch;

const signedIn = `theme=dark; ${APPROVER_COOKIE}=${encodeURIComponent(KEY)}`;

function request(path: string, cookie: string | null = signedIn) {
  const headers = new Headers();
  if (cookie !== null) headers.set("cookie", cookie);
  return new Request(`${ORIGIN}${path}`, { headers });
}

const bearer = (call: Call | undefined) => new Headers(call?.init.headers).get("authorization");

type Deps = { env: typeof env; fetch: typeof fetch };

// Every route, called the way its Next file calls it.
const ROUTES: { name: string; path: string; run: (r: Request, deps: Deps) => unknown }[] = [
  { name: "decisions", path: "/api/audit/decisions", run: (r, d) => auditDecisionsRoute(r, d) },
  {
    name: "a decision",
    path: "/api/audit/decisions/12",
    run: (r, d) => auditDecisionRoute(r, "12", d),
  },
  {
    name: "by intent",
    path: `/api/audit/intents/${INTENT}`,
    run: (r, d) => auditIntentRoute(r, INTENT, d),
  },
  { name: "entries", path: "/api/audit/entries", run: (r, d) => auditEntriesRoute(r, d) },
  { name: "verify", path: "/api/audit/verify", run: (r, d) => auditVerifyRoute(r, d) },
  {
    name: "export",
    path: `/api/audit/export?intent=${INTENT}`,
    run: (r, d) => auditExportRoute(r, d),
  },
];

const call = (route: (typeof ROUTES)[number], deps: Deps, cookie?: string | null) =>
  route.run(request(route.path, cookie), deps) as Promise<Response>;

async function everything(response: Response): Promise<string> {
  return `${JSON.stringify([...response.headers])} ${await response.text()}`;
}

describe("the audit routes", () => {
  it("call the gate's audit API with the cookie's key as the bearer, never following a redirect", async () => {
    for (const route of ROUTES) {
      const fake = okGate();
      const response = await call(route, { env, fetch: fake.fetch });
      expect(response.status, route.name).toBe(200);
      expect(fake.calls).toHaveLength(1);
      expect(fake.calls[0]?.init.method).toBe("GET");
      expect(fake.calls[0]?.init.redirect).toBe("error");
      expect(bearer(fake.calls[0])).toBe(`Bearer ${KEY}`);
      expect(response.headers.get("cache-control")).toBe("no-store");
    }
  });

  it("pass on only what the schemas allow", async () => {
    const list = await auditDecisionsRoute(request("/api/audit/decisions"), {
      env,
      fetch: okGate().fetch,
    });
    expect(await list.json()).toEqual(rowsPage);
    const one = await auditDecisionRoute(request("/api/audit/decisions/12"), "12", {
      env,
      fetch: okGate().fetch,
    });
    expect(await one.json()).toEqual(detail);
  });

  it("forward checked filters to the gate", async () => {
    const fake = okGate();
    await auditDecisionsRoute(
      request("/api/audit/decisions?decision=deny&q=KIK%201039&before=40&limit=20"),
      { env, fetch: fake.fetch },
    );
    const url = new URL(fake.calls[0]?.url ?? "");
    expect(url.origin + url.pathname).toBe("http://gate.test:8787/audit/decisions");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      decision: "deny",
      q: "KIK 1039",
      before: "40",
      limit: "20",
    });
    const entriesFake = okGate();
    await auditEntriesRoute(request("/api/audit/entries?before=9"), {
      env,
      fetch: entriesFake.fetch,
    });
    expect(entriesFake.calls[0]?.url).toBe("http://gate.test:8787/audit/entries?before=9");
  });

  it("refuse a bad request with one sentence before it reaches the gate", async () => {
    const cases: [() => unknown, string][] = [
      [() => auditDecisionsRoute(request("/api/audit/decisions?who=me"), deps), "badQuery"],
      [() => auditDecisionsRoute(request("/api/audit/decisions?decision=maybe"), deps), "badQuery"],
      [() => auditDecisionsRoute(request("/api/audit/decisions?limit=201"), deps), "badQuery"],
      [() => auditDecisionsRoute(request("/api/audit/decisions?limit=0"), deps), "badQuery"],
      [() => auditDecisionsRoute(request("/api/audit/decisions?before=-1"), deps), "badQuery"],
      [
        () =>
          auditDecisionsRoute(request("/api/audit/decisions?decision=deny&decision=allow"), deps),
        "badQuery",
      ],
      [() => auditEntriesRoute(request("/api/audit/entries?q=x"), deps), "badQuery"],
      [() => auditVerifyRoute(request("/api/audit/verify?full=1"), deps), "badQuery"],
      [() => auditDecisionRoute(request("/api/audit/decisions/12?x=1"), "12", deps), "badQuery"],
      [() => auditDecisionRoute(request("/api/audit/decisions/0"), "0", deps), "badSeq"],
      [() => auditDecisionRoute(request("/api/audit/decisions/a"), "../verify", deps), "badSeq"],
      [() => auditIntentRoute(request("/api/audit/intents/x"), "int_ZZ", deps), "badIntent"],
      [() => auditExportRoute(request("/api/audit/export"), deps), "badExport"],
      [
        () => auditExportRoute(request(`/api/audit/export?intent=${INTENT}&capture=CAP-1`), deps),
        "badExport",
      ],
      [() => auditExportRoute(request("/api/audit/export?capture=CAP%2F1"), deps), "badExport"],
    ];
    const fake = okGate();
    const deps = { env, fetch: fake.fetch };
    for (const [run, sentence] of cases) {
      const response = (await run()) as Response;
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        message: AUDIT_ROUTE_MESSAGES[sentence as keyof typeof AUDIT_ROUTE_MESSAGES],
      });
    }
    expect(fake.calls).toHaveLength(0);
  });

  it("pass the evidence file through as the gate wrote it, as an attachment", async () => {
    const response = await auditExportRoute(request(`/api/audit/export?intent=${INTENT}`), {
      env,
      fetch: okGate().fetch,
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-disposition")).toBe(
      `attachment; filename="countersign-evidence-intent-${INTENT}.json"`,
    );
    expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(await response.text()).toBe(evidence);
  });

  it("asks for a capture's evidence by capture ID", async () => {
    const file = evidence.replace(
      `"kind": "intent",\n    "id": "${INTENT}"`,
      '"kind": "capture",\n    "id": "CAP-1037"',
    );
    const fake = gate({ "/audit/export": { status: 200, body: file } });
    const response = await auditExportRoute(request("/api/audit/export?capture=CAP-1037"), {
      env,
      fetch: fake.fetch,
    });
    expect(fake.calls[0]?.url).toBe("http://gate.test:8787/audit/export?capture=CAP-1037");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-disposition")).toBe(
      'attachment; filename="countersign-evidence-capture-CAP-1037.json"',
    );
  });

  it("refuse an evidence file in another format or for another scope", async () => {
    for (const body of [
      evidence.replace("countersign-evidence-v1", "countersign-evidence-v2"),
      evidence.replace(INTENT, `int_${"c".repeat(24)}`),
      "not json",
      JSON.stringify({ format: "countersign-evidence-v1" }),
    ]) {
      const response = await auditExportRoute(request(`/api/audit/export?intent=${INTENT}`), {
        env,
        fetch: gate({ "/audit/export": { status: 200, body } }).fetch,
      });
      expect(response.status).toBe(502);
      expect(response.headers.get("content-disposition")).toBeNull();
      expect(await response.json()).toEqual({ message: APPROVAL_ROUTE_MESSAGES.unreachable });
    }
  });
});

describe("signed out, refused, unreachable and junk", () => {
  it("answer 401 without asking the gate when there's no cookie", async () => {
    for (const route of ROUTES) {
      const fake = okGate();
      const response = await call(route, { env, fetch: fake.fetch }, "theme=dark");
      expect(response.status).toBe(401);
      expect(response.headers.get("set-cookie")).toBeNull();
      expect(await response.json()).toEqual({ message: APPROVAL_ROUTE_MESSAGES.signedOut });
      expect(fake.calls).toHaveLength(0);
    }
  });

  it("clear a malformed cookie and ask to sign in again", async () => {
    for (const route of ROUTES) {
      const fake = okGate();
      const response = await call(route, { env, fetch: fake.fetch }, `${APPROVER_COOKIE}=short`);
      expect(response.status).toBe(401);
      expect(response.headers.get("set-cookie")).toMatch(/Max-Age=0/);
      expect(await response.json()).toEqual({ message: APPROVAL_ROUTE_MESSAGES.signInAgain });
      expect(fake.calls).toHaveLength(0);
    }
  });

  it("clear the cookie and answer 'Sign in again.' when the gate refuses the key", async () => {
    for (const route of ROUTES) {
      const refused = gate(
        Object.fromEntries(
          [
            "/audit/decisions",
            "/audit/decisions/12",
            `/audit/intents/${INTENT}`,
            "/audit/entries",
            "/audit/verify",
            "/audit/export",
          ].map((path) => [
            path,
            { status: 401, body: { message: "A valid approver key is required." } },
          ]),
        ),
      );
      const response = await call(route, { env, fetch: refused.fetch });
      expect(response.status).toBe(401);
      expect(response.headers.get("set-cookie")).toBe(
        `${APPROVER_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`,
      );
      expect(await response.json()).toEqual({ message: APPROVAL_ROUTE_MESSAGES.signInAgain });
    }
  });

  it("pass on the gate's 400, 404 and 503 sentences with their status", async () => {
    for (const status of [400, 404, 503]) {
      const sentence = `Sentence for ${status}.`;
      const response = await auditDecisionRoute(request("/api/audit/decisions/12"), "12", {
        env,
        fetch: gate({ "/audit/decisions/12": { status, body: { message: sentence } } }).fetch,
      });
      expect(response.status).toBe(status);
      expect(await response.json()).toEqual({ message: sentence });
    }
    const missing = await auditIntentRoute(request(`/api/audit/intents/${INTENT}`), INTENT, {
      env,
      fetch: gate({}).fetch,
    });
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ message: "Not here." });
  });

  it("answer 502 with the fixed sentence when the gate is down or answers junk", async () => {
    const junk: Reply[] = [
      { status: 200, body: "not json" },
      { status: 200, body: { rows: "nope" } },
      { status: 500, body: { message: "Boom." } },
      { status: 404, body: "not json" },
      { status: 302, body: {} },
    ];
    for (const route of ROUTES) {
      const fetches = [
        down,
        ...junk.map(
          (reply) =>
            gate(
              Object.fromEntries(
                [
                  "/audit/decisions",
                  "/audit/decisions/12",
                  `/audit/intents/${INTENT}`,
                  "/audit/entries",
                  "/audit/verify",
                  "/audit/export",
                ].map((path) => [path, reply]),
              ),
            ).fetch,
        ),
      ];
      for (const fetchImpl of fetches) {
        const response = await call(route, { env, fetch: fetchImpl });
        expect(response.status, route.name).toBe(502);
        expect(response.headers.get("set-cookie")).toBeNull();
        expect(await response.json()).toEqual({ message: APPROVAL_ROUTE_MESSAGES.unreachable });
      }
    }
  });

  it("refuse a decision answer for another entry", async () => {
    const response = await auditDecisionRoute(request("/api/audit/decisions/12"), "12", {
      env,
      fetch: gate({ "/audit/decisions/12": { status: 200, body: { ...detail, seq: 13 } } }).fetch,
    });
    expect(response.status).toBe(502);
  });

  it("answer 502 when GATE_URL isn't an http(s) URL", async () => {
    const fake = okGate();
    const response = await auditVerifyRoute(request("/api/audit/verify"), {
      env: { GATE_URL: "file:///etc/passwd" },
      fetch: fake.fetch,
    });
    expect(response.status).toBe(502);
    expect(fake.calls).toHaveLength(0);
  });
});

describe("the loaders, for server pages", () => {
  it("answer the parsed values with the key they're given", async () => {
    const deps = { env, fetch: okGate().fetch };
    expect(await loadDecisions(KEY, {}, deps)).toEqual({ ok: true, value: rowsPage });
    expect(await loadDecision(KEY, "12", deps)).toEqual({ ok: true, value: detail });
    expect(await loadIntentDecision(KEY, INTENT, deps)).toEqual({
      ok: true,
      value: { decision_seq: 12 },
    });
    expect(await loadEntries(KEY, {}, deps)).toEqual({ ok: true, value: entries });
    expect(await loadVerify(KEY, deps)).toEqual({ ok: true, value: verdict });
    expect(await loadExport(KEY, { intent: INTENT }, deps)).toEqual({
      ok: true,
      value: { filename: `countersign-evidence-intent-${INTENT}.json`, body: evidence },
    });
  });

  it("read an unreadable decision as unreadable", async () => {
    const unreadable = {
      readable: false,
      seq: 11,
      at: "2026-10-20T08:00:00.000Z",
      hash: "1".repeat(64),
      prev_hash: "2".repeat(64),
      problem: "It isn't JSON.",
      payload: "{not json",
    };
    const answer = await loadDecision(KEY, "11", {
      env,
      fetch: gate({ "/audit/decisions/11": { status: 200, body: unreadable } }).fetch,
    });
    expect(answer).toEqual({ ok: true, value: unreadable });
  });

  it("refuse a gate 401 with 'Sign in again.', for the page to show the sign-in", async () => {
    const answer = await loadDecisions(
      KEY,
      {},
      {
        env,
        fetch: gate({ "/audit/decisions": { status: 401, body: { message: "No." } } }).fetch,
      },
    );
    expect(answer).toEqual({
      ok: false,
      status: 401,
      message: APPROVAL_ROUTE_MESSAGES.signInAgain,
    });
  });
});

describe("keys stay secret", () => {
  it("never puts the key in an answer", async () => {
    for (const route of ROUTES) {
      for (const fetchImpl of [okGate().fetch, down]) {
        const response = await call(route, { env, fetch: fetchImpl });
        expect(await everything(response)).not.toContain(KEY);
      }
    }
  });

  it("keeps the audit modules client-safe: no mandate, no server-only imports, no env, no logging", () => {
    const allowed: Record<string, string[]> = {
      "../src/audit-routes.ts": ["zod", "./approval-routes", "./audit-schemas"],
      "../src/audit-schemas.ts": ["zod"],
      "../app/sign-in.tsx": [
        "lucide-react",
        "next/navigation",
        "react",
        "../src/approvals-view",
        "./ui",
      ],
    };
    for (const [path, names] of Object.entries(allowed)) {
      const source = readFileSync(new URL(path, import.meta.url), "utf8");
      const imports = [...source.matchAll(/from "([^"]+)"/g)].map((match) => match[1]);
      for (const name of imports) expect(names, path).toContain(name);
      expect(source).not.toMatch(/console\.|process\.env|server-only|@countersign\/mandate/);
      expect(source).not.toContain("document.cookie");
    }
  });
});
