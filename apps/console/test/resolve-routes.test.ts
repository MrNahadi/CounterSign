import { describe, expect, it } from "vitest";
import { APPROVAL_ROUTE_MESSAGES, APPROVER_COOKIE } from "../src/approval-routes";
import {
  attachmentRoute,
  INBOX_SIGN_IN,
  inboxAccess,
  NO_PHOTO,
  NO_THREAD,
  RESOLVE_UNREACHABLE,
  resolveAgentUrl,
  threadRoute,
  threadsRoute,
} from "../src/resolve-routes";

// The console's server routes to Resolve, with Resolve played by an injected fetch.

const THREAD = `tkt_${"a".repeat(32)}`;
const PHOTO = `att_${"b".repeat(32)}`;

const summary = {
  thread_id: THREAD,
  channel: "email",
  sender_email: "payer@example.com",
  sender_phone: null,
  subject: "Stalled parcel",
  preview: "My parcel hasn't moved in 10 days.",
  latest_activity_at: "2026-10-20T08:00:00.000Z",
  latest_run: { run_id: "run_1", mode: "protected", status: "running", outcome: null },
};

const detail = {
  thread_id: THREAD,
  messages: [
    {
      ticket_id: THREAD,
      channel: "email",
      sender_email: "payer@example.com",
      sender_phone: null,
      subject: "Stalled parcel",
      body: "My parcel hasn't moved in 10 days.",
      attachments: [{ id: PHOTO, content_type: "image/jpeg" }],
      received_at: "2026-10-20T08:00:00.000Z",
      simulated: true,
    },
  ],
  runs: [
    {
      run_id: "run_1",
      ticket_id: THREAD,
      mode: "protected",
      model: "gemini-3.5-flash-lite",
      model_versions: [],
      status: "queued",
      outcome: null,
      reply: null,
      queued_at: "2026-10-20T08:00:00.000Z",
      started_at: null,
      finished_at: null,
      trace: null,
      executions: [],
      held: [],
    },
  ],
};

type Call = { url: string; init: RequestInit | undefined };

// Resolve is played by `answer`; the gate (`GATE_URL`) answers `gate` to the sign-in check, which
// is the only thing the console asks it. `calls` holds what reached Resolve, `gateCalls` the gate.
function resolveAt(
  answer: (url: string) => Response | Promise<Response>,
  gate: () => Response = () => Response.json({ open: [], recent: [] }),
) {
  const calls: Call[] = [];
  const gateCalls: Call[] = [];
  const fetchFake = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (new URL(url).host === "gate.test") {
      gateCalls.push({ url, init });
      return gate();
    }
    calls.push({ url, init });
    return answer(url);
  }) as typeof fetch;
  return { calls, gateCalls, fetch: fetchFake };
}

const KEY = "approver-key-0123456789abcdefghijklmnop";
const env = { RESOLVE_AGENT_URL: "http://resolve.test:9000", GATE_URL: "http://gate.test" };

const get = (cookie: string | null = `${APPROVER_COOKIE}=${encodeURIComponent(KEY)}`) =>
  new Request("http://console.test/api/resolve/threads", {
    headers: cookie === null ? {} : { cookie },
  });

async function bodyOf(response: Response) {
  return { status: response.status, body: await response.json() };
}

describe("RESOLVE_AGENT_URL", () => {
  it("defaults to port 8788 on loopback and refuses anything but http(s)", () => {
    expect(resolveAgentUrl({})?.href).toBe("http://127.0.0.1:8788/");
    expect(resolveAgentUrl({ RESOLVE_AGENT_URL: "" })?.href).toBe("http://127.0.0.1:8788/");
    expect(resolveAgentUrl(env)?.href).toBe("http://resolve.test:9000/");
    expect(resolveAgentUrl({ RESOLVE_AGENT_URL: "file:///etc/passwd" })).toBeNull();
    expect(resolveAgentUrl({ RESOLVE_AGENT_URL: "not a url" })).toBeNull();
  });
});

describe("the sign-in on every GET route to Resolve", () => {
  const routes: [
    string,
    (request: Request, deps: Parameters<typeof threadsRoute>[1]) => unknown,
  ][] = [
    ["threads", (request, deps) => threadsRoute(request, deps)],
    ["thread", (request, deps) => threadRoute(request, THREAD, deps)],
    ["attachment", (request, deps) => attachmentRoute(request, PHOTO, deps)],
  ];

  for (const [name, route] of routes) {
    it(`${name}: no cookie is 401 and Resolve and the gate hear nothing`, async () => {
      const resolve = resolveAt(() => Response.json(detail));
      const answer = (await route(get(null), { env, fetch: resolve.fetch })) as Response;
      expect(await bodyOf(answer)).toEqual({
        status: 401,
        body: { message: APPROVAL_ROUTE_MESSAGES.signedOut },
      });
      expect(resolve.calls).toEqual([]);
      expect(resolve.gateCalls).toEqual([]);
    });

    it(`${name}: a gate 401 is 401, clears the cookie and never reaches Resolve`, async () => {
      const resolve = resolveAt(
        () => Response.json(detail),
        () => Response.json({ message: "A valid approver key is required." }, { status: 401 }),
      );
      const answer = (await route(get(), { env, fetch: resolve.fetch })) as Response;
      expect(await bodyOf(answer)).toEqual({
        status: 401,
        body: { message: APPROVAL_ROUTE_MESSAGES.signInAgain },
      });
      expect(answer.headers.get("set-cookie")).toMatch(/^countersign_approver=; .*Max-Age=0/);
      expect(resolve.calls).toEqual([]);
    });

    it(`${name}: a gate that fails or answers junk is 502 and never reaches Resolve`, async () => {
      for (const gate of [
        () => Response.json({ open: "no" }),
        () => Response.json({ message: "oops" }, { status: 500 }),
      ]) {
        const resolve = resolveAt(() => Response.json(detail), gate);
        const answer = (await route(get(), { env, fetch: resolve.fetch })) as Response;
        expect(answer.status).toBe(502);
        expect(resolve.calls).toEqual([]);
      }
      const down = (async (input: string | URL | Request) => {
        if (new URL(String(input)).host === "gate.test") throw new TypeError("fetch failed");
        return Response.json(detail);
      }) as typeof fetch;
      const answer = (await route(get(), { env, fetch: down })) as Response;
      expect(await bodyOf(answer)).toEqual({
        status: 502,
        body: { message: APPROVAL_ROUTE_MESSAGES.unreachable },
      });
    });

    it(`${name}: the key goes to the gate as the bearer and never to Resolve`, async () => {
      const resolve = resolveAt(() => Response.json(detail));
      await route(get(), { env, fetch: resolve.fetch });
      expect(new Headers(resolve.gateCalls[0]?.init?.headers).get("authorization")).toBe(
        `Bearer ${KEY}`,
      );
      expect(resolve.calls.length).toBeGreaterThan(0);
      for (const call of resolve.calls) {
        expect(JSON.stringify([call.url, call.init])).not.toContain(KEY);
      }
    });
  }
});

describe("GET /api/resolve/threads", () => {
  it("passes on Resolve's parsed thread list", async () => {
    const resolve = resolveAt(() => Response.json({ threads: [summary], extra: "dropped" }));
    const answer = await bodyOf(await threadsRoute(get(), { env, fetch: resolve.fetch }));
    expect(answer).toEqual({ status: 200, body: { threads: [summary] } });
    expect(resolve.calls.map((call) => call.url)).toEqual(["http://resolve.test:9000/threads"]);
  });

  it("answers 502 with one sentence when Resolve is down, answers junk, or errs", async () => {
    const answers: (() => Response | Promise<Response>)[] = [
      () => Promise.reject(new TypeError("fetch failed")),
      () => new Response("<html>", { status: 200 }),
      () => Response.json({ threads: [{ ...summary, channel: "fax" }] }),
      () => Response.json({ message: "Resolve has no database." }, { status: 503 }),
      () => Response.json({ threads: [summary] }, { status: 500 }),
    ];
    for (const answer of answers) {
      const resolve = resolveAt(answer);
      expect(await bodyOf(await threadsRoute(get(), { env, fetch: resolve.fetch }))).toEqual({
        status: 502,
        body: { message: RESOLVE_UNREACHABLE },
      });
    }
    expect(RESOLVE_UNREACHABLE).toBe("Resolve isn't reachable. Start it, then try again.");
  });

  it("answers 502 without calling anything when the URL isn't usable", async () => {
    const resolve = resolveAt(() => Response.json({ threads: [] }));
    const answer = await threadsRoute(get(), {
      env: { RESOLVE_AGENT_URL: "ftp://x", GATE_URL: "http://gate.test" },
      fetch: resolve.fetch,
    });
    expect(answer.status).toBe(502);
    expect(resolve.calls).toEqual([]);
  });
});

describe("GET /api/resolve/threads/[id]", () => {
  it("passes on a parsed thread", async () => {
    const resolve = resolveAt(() => Response.json(detail));
    expect(await bodyOf(await threadRoute(get(), THREAD, { env, fetch: resolve.fetch }))).toEqual({
      status: 200,
      body: detail,
    });
    expect(resolve.calls[0]?.url).toBe(`http://resolve.test:9000/threads/${THREAD}`);
  });

  it("refuses a malformed ID before calling Resolve", async () => {
    const resolve = resolveAt(() => Response.json(detail));
    for (const id of ["../threads", `${THREAD}/x`, "tkt_ABC", undefined, 42]) {
      expect(await bodyOf(await threadRoute(get(), id, { env, fetch: resolve.fetch }))).toEqual({
        status: 404,
        body: { message: NO_THREAD },
      });
    }
    expect(resolve.calls).toEqual([]);
  });

  it("says there's no such thread when Resolve answers 404", async () => {
    const resolve = resolveAt(() =>
      Response.json({ message: "There's no thread with that ID." }, { status: 404 }),
    );
    expect((await threadRoute(get(), THREAD, { env, fetch: resolve.fetch })).status).toBe(404);
  });

  it("answers 502 for junk, a trace it can't read, or another thread", async () => {
    const junk = [
      { ...detail, runs: [{ ...detail.runs[0], status: "done" }] },
      { ...detail, runs: [{ ...detail.runs[0], trace: { mode: "protected", steps: [{}] } }] },
      { ...detail, runs: [{ ...detail.runs[0], executions: undefined }] },
      { ...detail, thread_id: `tkt_${"c".repeat(32)}` },
      { ...detail, messages: [] },
      { message: "There's no thread with that ID." },
    ];
    for (const body of junk) {
      const resolve = resolveAt(() => Response.json(body));
      expect(await bodyOf(await threadRoute(get(), THREAD, { env, fetch: resolve.fetch }))).toEqual(
        {
          status: 502,
          body: { message: RESOLVE_UNREACHABLE },
        },
      );
    }
    const raw = resolveAt(() => new Response("not found", { status: 404 }));
    expect((await threadRoute(get(), THREAD, { env, fetch: raw.fetch })).status).toBe(502);
  });
});

describe("GET /api/resolve/attachments/[id]", () => {
  const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 16]);

  it("passes on a photo's bytes with its type", async () => {
    const resolve = resolveAt(
      () => new Response(jpeg, { headers: { "content-type": "image/jpeg" } }),
    );
    const answer = await attachmentRoute(get(), PHOTO, { env, fetch: resolve.fetch });
    expect(answer.status).toBe(200);
    expect(answer.headers.get("content-type")).toBe("image/jpeg");
    expect(answer.headers.get("x-content-type-options")).toBe("nosniff");
    expect(new Uint8Array(await answer.arrayBuffer())).toEqual(jpeg);
    expect(resolve.calls[0]?.url).toBe(`http://resolve.test:9000/attachments/${PHOTO}`);
  });

  it("refuses a malformed ID, and says when there's no such photo", async () => {
    const resolve = resolveAt(() =>
      Response.json({ message: "There's no photo with that ID." }, { status: 404 }),
    );
    expect(
      await bodyOf(await attachmentRoute(get(), "att_../x", { env, fetch: resolve.fetch })),
    ).toEqual({
      status: 404,
      body: { message: NO_PHOTO },
    });
    expect(resolve.calls).toEqual([]);
    expect((await attachmentRoute(get(), PHOTO, { env, fetch: resolve.fetch })).status).toBe(404);
  });

  it("answers 502 for anything that isn't a photo", async () => {
    const answers = [
      () => new Response("<svg/>", { headers: { "content-type": "image/svg+xml" } }),
      () => new Response("", { headers: { "content-type": "image/png" } }),
      () => Promise.reject(new TypeError("fetch failed")),
      () => new Response(jpeg, { status: 500, headers: { "content-type": "image/jpeg" } }),
    ];
    for (const answer of answers) {
      const resolve = resolveAt(answer);
      expect(
        await bodyOf(await attachmentRoute(get(), PHOTO, { env, fetch: resolve.fetch })),
      ).toEqual({
        status: 502,
        body: { message: RESOLVE_UNREACHABLE },
      });
    }
  });
});

describe("inboxAccess", () => {
  it("has the inbox's sign-in title and line", () => {
    expect(INBOX_SIGN_IN).toEqual({
      title: "Inbox",
      line: "Sign in with the approver key to see the inbox.",
    });
  });

  it("is signed out, with no message, when there's no key, and asks the gate nothing", async () => {
    const resolve = resolveAt(() => Response.json({}));
    expect(await inboxAccess(null, { env, fetch: resolve.fetch })).toEqual({
      state: "signed-out",
      message: null,
    });
    expect(resolve.gateCalls).toEqual([]);
  });

  it("is open when the gate takes the key, and Resolve hears nothing", async () => {
    const resolve = resolveAt(() => Response.json({}));
    expect(await inboxAccess(KEY, { env, fetch: resolve.fetch })).toEqual({ state: "open" });
    expect(resolve.calls).toEqual([]);
  });

  it("says 'Sign in again.' after a gate 401", async () => {
    const resolve = resolveAt(
      () => Response.json({}),
      () => Response.json({ message: "A valid approver key is required." }, { status: 401 }),
    );
    expect(await inboxAccess(KEY, { env, fetch: resolve.fetch })).toEqual({
      state: "signed-out",
      message: APPROVAL_ROUTE_MESSAGES.signInAgain,
    });
  });

  it("gives the unreachable sentence when the gate fails or answers junk", async () => {
    for (const gate of [
      () => new Response("<html>", { status: 500 }),
      () => Response.json({ nope: true }),
    ]) {
      const resolve = resolveAt(() => Response.json({}), gate);
      expect(await inboxAccess(KEY, { env, fetch: resolve.fetch })).toEqual({
        state: "unreachable",
        message: APPROVAL_ROUTE_MESSAGES.unreachable,
      });
    }
  });
});
