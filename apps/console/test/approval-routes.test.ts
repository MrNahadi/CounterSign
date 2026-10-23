import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  APPROVAL_ROUTE_MESSAGES,
  APPROVER_COOKIE,
  answerRoute,
  approvalRoute,
  approvalsRoute,
  approverKeyFrom,
  documentRoute,
  gateUrl,
  MAX_DOCUMENT_BYTES,
  signInRoute,
  signOutRoute,
} from "../src/approval-routes";

// The console's approval routes and the approver login, with the gate played by an injected fetch.

const KEY = "approver-key-0123456789abcdefghijklmnop";
const OTHER = "someone-elses-key-0123456789abcdefghijk";
const HASH = "a".repeat(64);
const INTENT = `int_${"b".repeat(32)}`;
const ORIGIN = "http://localhost:3000";
const env = { GATE_URL: "http://gate.test:8787" };

const card = {
  step_up_id: 7,
  intent_id: INTENT,
  intent_hash: HASH,
  principal: "support-agent",
  action: "paypal.refund",
  action_words: "Refund",
  amount: { minor: 24000, currency: "USD", display: "$240.00" },
  target: { kind: "capture", id: "CAP-1037", order_id: "ORD-1037" },
  order_number: "1037",
  ticket: {
    id: `tkt_${"c".repeat(32)}`,
    channel: "email",
    sender: "payer@example.com",
    subject: "Broken mug",
    excerpt: "It arrived broken.",
    received_at: "2026-10-20T08:00:00.000Z",
    attachment_ids: [`att_${"d".repeat(32)}`],
    simulated: true,
  },
  claim: "damaged",
  reasons: [
    { code: "AMOUNT_OVER_CAP", words: "The amount is over the cap.", detail: "24000 > 5000" },
  ],
  checks: [
    {
      verifier: "capture.status",
      result: "pass",
      value: "COMPLETED",
      detail: "Completed.",
      records: [{ call: "GET /v2/payments/captures/CAP-1037", id: "CAP-1037" }],
    },
  ],
  claims: [],
  params: null,
  decided_at: "2026-10-20T08:01:00.000Z",
  expires_at: "2026-10-20T08:16:00.000Z",
  state: "open",
  answer: null,
  can_execute: true,
  cannot_execute: null,
};

const recent = {
  step_up_id: 5,
  intent_id: `int_${"e".repeat(32)}`,
  action: "paypal.invoice.send",
  action_words: "Send invoice",
  amount: { minor: 9900, currency: "USD", display: "$99.00" },
  order_number: null,
  outcome: "approved",
  at: "2026-10-20T07:00:00.000Z",
  channel: "cli",
  execution: {
    outcome: "executed",
    refund: null,
    invoice: { id: "INV2-1", status: "SENT" },
    dispute: null,
  },
};

const view = { open: [card], recent: [recent] };

const answered = {
  outcome: "approved",
  code: null,
  step_up_id: 7,
  intent_id: INTENT,
  approval_seq: 9,
  execution: {
    outcome: "executed",
    refund: { id: "4XJ1", status: "COMPLETED" },
    invoice: null,
    dispute: null,
    error: null,
  },
};

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

function request(
  path: string,
  init: { method?: string; cookie?: string; body?: string; origin?: string; proto?: string } = {},
) {
  const headers = new Headers();
  if (init.cookie !== undefined) headers.set("cookie", init.cookie);
  if (init.body !== undefined) headers.set("content-type", "application/json");
  if (init.proto !== undefined) headers.set("x-forwarded-proto", init.proto);
  return new Request(`${init.origin ?? ORIGIN}${path}`, {
    method: init.method ?? "GET",
    headers,
    ...(init.body === undefined ? {} : { body: init.body }),
  });
}

const DOC = `doc_${"0a".repeat(12)}`;
const pdfBytes = new TextEncoder().encode("%PDF-1.7\n%evidence\n");
const PDF_HEADERS = {
  "content-type": "application/pdf",
  "content-disposition": "attachment; filename=countersign-evidence-PP-D-123.pdf",
};

// The gate answering a document's bytes with the headers given.
function gateFile(bytes: Uint8Array, headers: Record<string, string>) {
  const calls: Call[] = [];
  const fetchFake = (async (url: URL | string, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(bytes.slice(), { status: 200, headers });
  }) as typeof fetch;
  return { calls, fetch: fetchFake };
}

const signedIn = `theme=dark; ${APPROVER_COOKIE}=${encodeURIComponent(KEY)}`;
const bearer = (call: Call) => new Headers(call.init.headers).get("authorization");

async function everything(response: Response): Promise<string> {
  return `${JSON.stringify([...response.headers])} ${await response.text()}`;
}

describe("signing in", () => {
  it("checks the key with GET /approvals on the gate, then sets the cookie", async () => {
    const fake = gate(200, view);
    const response = await signInRoute(
      request("/api/approvals/session", { method: "POST", body: JSON.stringify({ key: KEY }) }),
      { env, fetch: fake.fetch },
    );
    expect(response.status).toBe(200);
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]?.url).toBe("http://gate.test:8787/approvals");
    expect(fake.calls[0]?.init.method).toBe("GET");
    expect(fake.calls[0]?.init.redirect).toBe("error");
    expect(bearer(fake.calls[0] as Call)).toBe(`Bearer ${KEY}`);
    const cookie = response.headers.get("set-cookie") ?? "";
    expect(cookie).toBe(
      `${APPROVER_COOKIE}=${encodeURIComponent(KEY)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200`,
    );
    expect(await response.json()).toEqual({ signed_in: true });
  });

  it("marks the cookie Secure over HTTPS, directly or through the host's proxy", async () => {
    for (const init of [{ origin: "https://console.test" }, { proto: "https" }]) {
      const response = await signInRoute(
        request("/api/approvals/session", {
          method: "POST",
          body: JSON.stringify({ key: KEY }),
          ...init,
        }),
        { env, fetch: gate(200, view).fetch },
      );
      expect(response.headers.get("set-cookie")).toMatch(/; Secure$/);
    }
  });

  it("signs in when the gate took the key but can't read its log yet", async () => {
    const response = await signInRoute(
      request("/api/approvals/session", { method: "POST", body: JSON.stringify({ key: KEY }) }),
      { env, fetch: gate(503, { message: "The approvals can't be read right now." }).fetch },
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toContain(`${APPROVER_COOKIE}=`);
  });

  it("says a wrong key isn't right and sets nothing", async () => {
    const fake = gate(401, { message: "A valid approver key is required." });
    const response = await signInRoute(
      request("/api/approvals/session", { method: "POST", body: JSON.stringify({ key: OTHER }) }),
      { env, fetch: fake.fetch },
    );
    expect(response.status).toBe(401);
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(await response.json()).toEqual({ message: APPROVAL_ROUTE_MESSAGES.wrongKey });
  });

  it("refuses a key too short to be one without asking the gate", async () => {
    const fake = gate(200, view);
    const response = await signInRoute(
      request("/api/approvals/session", { method: "POST", body: JSON.stringify({ key: "short" }) }),
      { env, fetch: fake.fetch },
    );
    expect(response.status).toBe(401);
    expect(fake.calls).toHaveLength(0);
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  it("refuses a body that isn't { key } or is over 16 KB", async () => {
    for (const body of [
      "not json",
      JSON.stringify({ key: KEY, extra: 1 }),
      JSON.stringify({ key: KEY, pad: "x".repeat(17 * 1024) }),
    ]) {
      const fake = gate(200, view);
      const response = await signInRoute(
        request("/api/approvals/session", { method: "POST", body }),
        { env, fetch: fake.fetch },
      );
      expect(response.status).toBe(400);
      expect(fake.calls).toHaveLength(0);
      expect(await response.json()).toEqual({ message: APPROVAL_ROUTE_MESSAGES.badSignIn });
    }
  });

  it("answers 502 and sets nothing when the gate is down or answers junk", async () => {
    for (const fetchFake of [down, gate(200, { open: "nope" }).fetch, gate(500, "oops").fetch]) {
      const response = await signInRoute(
        request("/api/approvals/session", { method: "POST", body: JSON.stringify({ key: KEY }) }),
        { env, fetch: fetchFake },
      );
      expect(response.status).toBe(502);
      expect(response.headers.get("set-cookie")).toBeNull();
      expect(await response.json()).toEqual({ message: APPROVAL_ROUTE_MESSAGES.unreachable });
    }
  });

  it("signs out by clearing the cookie", async () => {
    const response = signOutRoute(
      request("/api/approvals/session", { method: "DELETE", cookie: signedIn }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toBe(
      `${APPROVER_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`,
    );
  });
});

describe("the approval routes", () => {
  it("lists the cards with the cookie's key as the bearer", async () => {
    const fake = gate(200, view);
    const response = await approvalsRoute(request("/api/approvals", { cookie: signedIn }), {
      env,
      fetch: fake.fetch,
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(view);
    expect(fake.calls[0]?.url).toBe("http://gate.test:8787/approvals");
    expect(bearer(fake.calls[0] as Call)).toBe(`Bearer ${KEY}`);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("reads one card", async () => {
    const fake = gate(200, card);
    const response = await approvalRoute(request("/api/approvals/7", { cookie: signedIn }), "7", {
      env,
      fetch: fake.fetch,
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(card);
    expect(fake.calls[0]?.url).toBe("http://gate.test:8787/approvals/7");
  });

  it("answers 404 for an ID that isn't a step-up ID, without asking the gate", async () => {
    const fake = gate(200, card);
    for (const id of ["0", "abc", "7/../x", "1".repeat(17)]) {
      const response = await approvalRoute(request("/api/approvals/x", { cookie: signedIn }), id, {
        env,
        fetch: fake.fetch,
      });
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ message: APPROVAL_ROUTE_MESSAGES.noStepUp });
    }
    expect(fake.calls).toHaveLength(0);
  });

  it("passes on the gate's 404 and 503 sentences", async () => {
    const missing = await approvalRoute(request("/api/approvals/8", { cookie: signedIn }), "8", {
      env,
      fetch: gate(404, { message: "There's no step-up with that ID." }).fetch,
    });
    expect(missing.status).toBe(404);
    const unreadable = "An audit-log entry can't be read, so nothing can be approved.";
    const blind = await approvalsRoute(request("/api/approvals", { cookie: signedIn }), {
      env,
      fetch: gate(503, { message: unreadable }).fetch,
    });
    expect(blind.status).toBe(503);
    expect(await blind.json()).toEqual({ message: unreadable });
  });

  it("sends the checked answer and passes on the gate's result", async () => {
    const fake = gate(200, answered);
    const response = await answerRoute(
      request("/api/approvals/7", {
        method: "POST",
        cookie: signedIn,
        body: JSON.stringify({ answer: "approve", intent_hash: HASH }),
      }),
      "7",
      { env, fetch: fake.fetch },
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(answered);
    expect(fake.calls[0]?.url).toBe("http://gate.test:8787/approvals/7");
    expect(fake.calls[0]?.init.method).toBe("POST");
    expect(fake.calls[0]?.init.body).toBe(JSON.stringify({ answer: "approve", intent_hash: HASH }));
    expect(bearer(fake.calls[0] as Call)).toBe(`Bearer ${KEY}`);
  });

  it("passes on a rejection as the 200 the gate gave", async () => {
    const rejected = { ...answered, outcome: "rejected", code: "HASH_MISMATCH", execution: null };
    const response = await answerRoute(
      request("/api/approvals/7", {
        method: "POST",
        cookie: signedIn,
        body: JSON.stringify({ answer: "approve", intent_hash: HASH }),
      }),
      "7",
      { env, fetch: gate(200, rejected).fetch },
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(rejected);
  });

  it("refuses a bad answer before it reaches the gate", async () => {
    for (const body of [
      JSON.stringify({ answer: "maybe", intent_hash: HASH }),
      JSON.stringify({ answer: "approve", intent_hash: "abc" }),
      JSON.stringify({ answer: "deny", intent_hash: HASH, amount: 1 }),
      JSON.stringify({ answer: "deny", intent_hash: HASH, pad: "x".repeat(17 * 1024) }),
      "{",
    ]) {
      const fake = gate(200, answered);
      const response = await answerRoute(
        request("/api/approvals/7", { method: "POST", cookie: signedIn, body }),
        "7",
        { env, fetch: fake.fetch },
      );
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ message: APPROVAL_ROUTE_MESSAGES.badAnswer });
      expect(fake.calls).toHaveLength(0);
    }
  });

  it("answers 401 without asking the gate when there's no cookie", async () => {
    const fake = gate(200, view);
    const response = await approvalsRoute(request("/api/approvals", { cookie: "theme=dark" }), {
      env,
      fetch: fake.fetch,
    });
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ message: APPROVAL_ROUTE_MESSAGES.signedOut });
    expect(fake.calls).toHaveLength(0);
    const post = await answerRoute(
      request("/api/approvals/7", {
        method: "POST",
        body: JSON.stringify({ answer: "approve", intent_hash: HASH }),
      }),
      "7",
      { env, fetch: fake.fetch },
    );
    expect(post.status).toBe(401);
    expect(fake.calls).toHaveLength(0);
  });

  it("clears a malformed cookie and asks to sign in again", async () => {
    const fake = gate(200, view);
    const response = await approvalsRoute(
      request("/api/approvals", { cookie: `${APPROVER_COOKIE}=short` }),
      { env, fetch: fake.fetch },
    );
    expect(response.status).toBe(401);
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
    expect(fake.calls).toHaveLength(0);
  });

  it("clears the cookie and answers 401 'Sign in again.' when the gate refuses the key", async () => {
    const calls = [
      () => approvalsRoute(request("/api/approvals", { cookie: signedIn }), { env, fetch: f }),
      () =>
        approvalRoute(request("/api/approvals/7", { cookie: signedIn }), "7", { env, fetch: f }),
      () =>
        answerRoute(
          request("/api/approvals/7", {
            method: "POST",
            cookie: signedIn,
            body: JSON.stringify({ answer: "deny", intent_hash: HASH }),
          }),
          "7",
          { env, fetch: f },
        ),
    ];
    const f = gate(401, { message: "A valid approver key is required." }).fetch;
    for (const run of calls) {
      const response = await run();
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ message: "Sign in again." });
      expect(response.headers.get("set-cookie")).toBe(
        `${APPROVER_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`,
      );
    }
  });

  it("answers 502 with the fixed sentence when the gate is down or answers junk", async () => {
    const junk = [
      down,
      gate(200, "<html>").fetch,
      gate(200, { open: [{ ...card, intent_hash: "nope" }], recent: [] }).fetch,
      gate(500, { message: "boom" }).fetch,
      gate(503, "<html>").fetch,
      gate(302, {}).fetch,
    ];
    for (const fetchFake of junk) {
      const response = await approvalsRoute(request("/api/approvals", { cookie: signedIn }), {
        env,
        fetch: fetchFake,
      });
      expect(response.status).toBe(502);
      expect(await response.json()).toEqual({
        message: "The gate isn't reachable. Start it, then try again.",
      });
    }
    const wrongCard = await approvalRoute(request("/api/approvals/8", { cookie: signedIn }), "8", {
      env,
      fetch: gate(200, card).fetch,
    });
    expect(wrongCard.status).toBe(502);
    const badResult = await answerRoute(
      request("/api/approvals/7", {
        method: "POST",
        cookie: signedIn,
        body: JSON.stringify({ answer: "approve", intent_hash: HASH }),
      }),
      "7",
      { env, fetch: gate(200, { ...answered, outcome: "maybe" }).fetch },
    );
    expect(badResult.status).toBe(502);
  });

  it("answers 502 when GATE_URL isn't an http(s) URL, and defaults to the local gate", async () => {
    expect(gateUrl({})?.href).toBe("http://127.0.0.1:8787/");
    expect(gateUrl({ GATE_URL: "ftp://gate" })).toBeNull();
    const response = await approvalsRoute(request("/api/approvals", { cookie: signedIn }), {
      env: { GATE_URL: "not a url" },
      fetch: gate(200, view).fetch,
    });
    expect(response.status).toBe(502);
  });
});

describe("the document route", () => {
  const path = `/api/approvals/documents/${DOC}`;

  it("passes the bytes on with the gate's content type and attachment header", async () => {
    const { calls, fetch: f } = gateFile(pdfBytes, PDF_HEADERS);
    const response = await documentRoute(request(path, { cookie: signedIn }), DOC, {
      env,
      fetch: f,
    });
    expect(response.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(`http://gate.test:8787/approvals/documents/${DOC}`);
    expect(bearer(calls[0] as Call)).toBe(`Bearer ${KEY}`);
    expect(calls[0]?.init.redirect).toBe("error");
    expect(response.headers.get("content-type")).toBe("application/pdf");
    expect(response.headers.get("content-disposition")).toBe(
      "attachment; filename=countersign-evidence-PP-D-123.pdf",
    );
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(pdfBytes);
  });

  it("passes the export JSON on as the gate typed it", async () => {
    const body = new TextEncoder().encode('{"format":"countersign-evidence-v1"}');
    const headers = {
      "content-type": "application/json; charset=utf-8",
      "content-disposition": 'attachment; filename="countersign-evidence-capture-9AB.json"',
    };
    const response = await documentRoute(request(path, { cookie: signedIn }), DOC, {
      env,
      fetch: gateFile(body, headers).fetch,
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(response.headers.get("content-disposition")).toBe(headers["content-disposition"]);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(body);
  });

  it("refuses a malformed document ID without asking the gate", async () => {
    for (const id of [
      "doc_1",
      `DOC_${"a".repeat(24)}`,
      `doc_${"a".repeat(24)}/x`,
      "../approvals",
    ]) {
      const { calls, fetch: f } = gateFile(pdfBytes, PDF_HEADERS);
      const response = await documentRoute(request(path, { cookie: signedIn }), id, {
        env,
        fetch: f,
      });
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ message: APPROVAL_ROUTE_MESSAGES.badDocument });
      expect(calls).toHaveLength(0);
    }
  });

  it("answers 401 without asking the gate when signed out, and clears a refused key", async () => {
    const { calls, fetch: f } = gateFile(pdfBytes, PDF_HEADERS);
    const out = await documentRoute(request(path), DOC, { env, fetch: f });
    expect(out.status).toBe(401);
    expect(await out.json()).toEqual({ message: APPROVAL_ROUTE_MESSAGES.signedOut });
    expect(calls).toHaveLength(0);
    const refused = await documentRoute(request(path, { cookie: signedIn }), DOC, {
      env,
      fetch: gate(401, { message: "A valid approver key is required." }).fetch,
    });
    expect(refused.status).toBe(401);
    expect(await refused.json()).toEqual({ message: APPROVAL_ROUTE_MESSAGES.signInAgain });
    expect(refused.headers.get("set-cookie")).toContain(`${APPROVER_COOKIE}=;`);
  });

  it("passes on the gate's 404 sentence", async () => {
    const response = await documentRoute(request(path, { cookie: signedIn }), DOC, {
      env,
      fetch: gate(404, { message: "There's no evidence document with that ID." }).fetch,
    });
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      message: "There's no evidence document with that ID.",
    });
  });

  it("answers 502 with the fixed sentence for a down gate or anything that isn't a document", async () => {
    const fakes = [
      down,
      gate(500, { message: "boom" }).fetch,
      gateFile(pdfBytes, { "content-disposition": PDF_HEADERS["content-disposition"] }).fetch,
      gateFile(pdfBytes, { ...PDF_HEADERS, "content-type": "text/html" }).fetch,
      gateFile(pdfBytes, { "content-type": "application/pdf" }).fetch,
      gateFile(pdfBytes, { ...PDF_HEADERS, "content-disposition": "inline; filename=x.pdf" }).fetch,
      gateFile(new Uint8Array(0), PDF_HEADERS).fetch,
      gateFile(new Uint8Array(MAX_DOCUMENT_BYTES + 1), PDF_HEADERS).fetch,
    ];
    for (const f of fakes) {
      const response = await documentRoute(request(path, { cookie: signedIn }), DOC, {
        env,
        fetch: f,
      });
      expect(response.status).toBe(502);
      expect(await response.json()).toEqual({ message: APPROVAL_ROUTE_MESSAGES.unreachable });
    }
  });
});

describe("the approver key stays secret", () => {
  it("never puts the key in an answer, except the sign-in cookie itself", async () => {
    const answers = [
      await approvalsRoute(request("/api/approvals", { cookie: signedIn }), { env, fetch: down }),
      await approvalsRoute(request("/api/approvals", { cookie: signedIn }), {
        env,
        fetch: gate(401, { message: KEY }).fetch,
      }),
      await approvalsRoute(request("/api/approvals", { cookie: signedIn }), {
        env,
        fetch: gate(200, view).fetch,
      }),
      await signInRoute(
        request("/api/approvals/session", { method: "POST", body: JSON.stringify({ key: KEY }) }),
        { env, fetch: gate(401, {}).fetch },
      ),
      await signInRoute(
        request("/api/approvals/session", { method: "POST", body: JSON.stringify({ key: KEY }) }),
        { env, fetch: down },
      ),
    ];
    for (const response of answers) {
      const text = await everything(response);
      expect(text).not.toContain(KEY);
      expect(text).not.toContain(encodeURIComponent(KEY));
    }
  });

  it("reads the key only from its own cookie", () => {
    expect(approverKeyFrom(request("/", { cookie: signedIn }))).toBe(KEY);
    expect(approverKeyFrom(request("/", { cookie: `x${APPROVER_COOKIE}=${KEY}` }))).toBeNull();
    expect(approverKeyFrom(request("/"))).toBeNull();
  });

  it("never puts the key in a document answer", async () => {
    const answers = [
      await documentRoute(request(`/api/approvals/documents/${DOC}`, { cookie: signedIn }), DOC, {
        env,
        fetch: gateFile(pdfBytes, PDF_HEADERS).fetch,
      }),
      await documentRoute(request(`/api/approvals/documents/${DOC}`, { cookie: signedIn }), DOC, {
        env,
        fetch: gate(401, { message: KEY }).fetch,
      }),
    ];
    for (const response of answers) {
      const text = await everything(response);
      expect(text).not.toContain(KEY);
      expect(text).not.toContain(encodeURIComponent(KEY));
    }
  });

  it("keeps the routes free of server-only imports and logging, so a client component can import them", () => {
    for (const path of ["../src/approval-routes.ts", "../src/approval-schemas.ts"]) {
      const source = readFileSync(new URL(path, import.meta.url), "utf8");
      const imports = [...source.matchAll(/from "([^"]+)"/g)].map((match) => match[1]);
      for (const name of imports)
        expect(["zod", "./approval-schemas", "./audit-schemas"]).toContain(name);
      expect(source).not.toMatch(/console\.|process\.env|server-only/);
    }
  });
});
