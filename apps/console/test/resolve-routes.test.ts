import { describe, expect, it } from "vitest";
import {
  attachmentRoute,
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

function resolveAt(answer: (url: string) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fetchFake = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    return answer(url);
  }) as typeof fetch;
  return { calls, fetch: fetchFake };
}

const env = { RESOLVE_AGENT_URL: "http://resolve.test:9000" };

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

describe("GET /api/resolve/threads", () => {
  it("passes on Resolve's parsed thread list", async () => {
    const resolve = resolveAt(() => Response.json({ threads: [summary], extra: "dropped" }));
    const answer = await bodyOf(await threadsRoute({ env, fetch: resolve.fetch }));
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
      expect(await bodyOf(await threadsRoute({ env, fetch: resolve.fetch }))).toEqual({
        status: 502,
        body: { message: RESOLVE_UNREACHABLE },
      });
    }
    expect(RESOLVE_UNREACHABLE).toBe("Resolve isn't reachable. Start it, then try again.");
  });

  it("answers 502 without calling anything when the URL isn't usable", async () => {
    const resolve = resolveAt(() => Response.json({ threads: [] }));
    const answer = await threadsRoute({
      env: { RESOLVE_AGENT_URL: "ftp://x" },
      fetch: resolve.fetch,
    });
    expect(answer.status).toBe(502);
    expect(resolve.calls).toEqual([]);
  });
});

describe("GET /api/resolve/threads/[id]", () => {
  it("passes on a parsed thread", async () => {
    const resolve = resolveAt(() => Response.json(detail));
    expect(await bodyOf(await threadRoute(THREAD, { env, fetch: resolve.fetch }))).toEqual({
      status: 200,
      body: detail,
    });
    expect(resolve.calls[0]?.url).toBe(`http://resolve.test:9000/threads/${THREAD}`);
  });

  it("refuses a malformed ID before calling Resolve", async () => {
    const resolve = resolveAt(() => Response.json(detail));
    for (const id of ["../threads", `${THREAD}/x`, "tkt_ABC", undefined, 42]) {
      expect(await bodyOf(await threadRoute(id, { env, fetch: resolve.fetch }))).toEqual({
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
    expect((await threadRoute(THREAD, { env, fetch: resolve.fetch })).status).toBe(404);
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
      expect(await bodyOf(await threadRoute(THREAD, { env, fetch: resolve.fetch }))).toEqual({
        status: 502,
        body: { message: RESOLVE_UNREACHABLE },
      });
    }
    const raw = resolveAt(() => new Response("not found", { status: 404 }));
    expect((await threadRoute(THREAD, { env, fetch: raw.fetch })).status).toBe(502);
  });
});

describe("GET /api/resolve/attachments/[id]", () => {
  const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 16]);

  it("passes on a photo's bytes with its type", async () => {
    const resolve = resolveAt(
      () => new Response(jpeg, { headers: { "content-type": "image/jpeg" } }),
    );
    const answer = await attachmentRoute(PHOTO, { env, fetch: resolve.fetch });
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
    expect(await bodyOf(await attachmentRoute("att_../x", { env, fetch: resolve.fetch }))).toEqual({
      status: 404,
      body: { message: NO_PHOTO },
    });
    expect(resolve.calls).toEqual([]);
    expect((await attachmentRoute(PHOTO, { env, fetch: resolve.fetch })).status).toBe(404);
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
      expect(await bodyOf(await attachmentRoute(PHOTO, { env, fetch: resolve.fetch }))).toEqual({
        status: 502,
        body: { message: RESOLVE_UNREACHABLE },
      });
    }
  });
});
