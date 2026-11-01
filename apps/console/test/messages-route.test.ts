import { describe, expect, it } from "vitest";
import { APPROVAL_ROUTE_MESSAGES, APPROVER_COOKIE } from "../src/approval-routes";
import {
  BAD_MESSAGE,
  MAX_MESSAGE_BYTES,
  messagesRoute,
  RESOLVE_UNREACHABLE,
} from "../src/resolve-routes";

// `POST /api/resolve/messages`, with Resolve played by an injected fetch.

const env = { RESOLVE_AGENT_URL: "http://resolve.test:9000", GATE_URL: "http://gate.test" };
const JPEG_BASE64 = Buffer.from([0xff, 0xd8, 0xff, 0xe0]).toString("base64");

const message = {
  channel: "email",
  sender_email: "payer@example.com",
  subject: "Stalled parcel",
  body: "My parcel hasn't moved in 10 days.",
  attachments: [{ content_type: "image/jpeg", data: JPEG_BASE64 }],
  mode: "protected",
};

const accepted = {
  ticket_id: `tkt_${"a".repeat(32)}`,
  thread_id: `tkt_${"a".repeat(32)}`,
  run_id: `run_${"b".repeat(32)}`,
};

// Resolve is played by `answer`; the gate answers `gate` to the sign-in check. `calls` holds only
// what reached Resolve.
function resolveAt(
  answer: () => Response | Promise<Response>,
  gate: () => Response = () => Response.json({ open: [], recent: [] }),
) {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const gateCalls: { url: string; init: RequestInit | undefined }[] = [];
  const fetchFake = (async (input: string | URL | Request, init?: RequestInit) => {
    if (new URL(String(input)).host === "gate.test") {
      gateCalls.push({ url: String(input), init });
      return gate();
    }
    calls.push({ url: String(input), init });
    return answer();
  }) as typeof fetch;
  return { calls, gateCalls, fetch: fetchFake };
}

const KEY = "approver-key-0123456789abcdefghijklmnop";
const SIGNED_IN = `${APPROVER_COOKIE}=${encodeURIComponent(KEY)}`;

const post = (body: string, cookie: string | null = SIGNED_IN) =>
  new Request("http://console.test/api/resolve/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(cookie === null ? {} : { cookie }),
    },
    body,
  });

async function bodyOf(response: Response) {
  return { status: response.status, body: await response.json() };
}

describe("POST /api/resolve/messages: the sign-in", () => {
  const body = JSON.stringify(message);

  it("with no cookie answers 401 without calling the gate or Resolve", async () => {
    const resolve = resolveAt(() => Response.json(accepted, { status: 202 }));
    expect(
      await bodyOf(await messagesRoute(post(body, null), { env, fetch: resolve.fetch })),
    ).toEqual({
      status: 401,
      body: { message: APPROVAL_ROUTE_MESSAGES.signedOut },
    });
    expect(resolve.calls).toEqual([]);
    expect(resolve.gateCalls).toEqual([]);
  });

  it("answers 401 and clears the cookie when the gate refuses the key", async () => {
    const resolve = resolveAt(
      () => Response.json(accepted, { status: 202 }),
      () => Response.json({ message: "A valid approver key is required." }, { status: 401 }),
    );
    const answer = await messagesRoute(post(body), { env, fetch: resolve.fetch });
    expect(await bodyOf(answer)).toEqual({
      status: 401,
      body: { message: APPROVAL_ROUTE_MESSAGES.signInAgain },
    });
    expect(answer.headers.get("set-cookie")).toMatch(/^countersign_approver=; .*Max-Age=0/);
    expect(resolve.calls).toEqual([]);
  });

  it("answers 502 when the gate fails, and never sends the key to Resolve", async () => {
    const failing = resolveAt(
      () => Response.json(accepted, { status: 202 }),
      () => Response.json({ message: "oops" }, { status: 500 }),
    );
    expect((await messagesRoute(post(body), { env, fetch: failing.fetch })).status).toBe(502);
    expect(failing.calls).toEqual([]);

    const resolve = resolveAt(() => Response.json(accepted, { status: 202 }));
    await messagesRoute(post(body), { env, fetch: resolve.fetch });
    expect(new Headers(resolve.gateCalls[0]?.init?.headers).get("authorization")).toBe(
      `Bearer ${KEY}`,
    );
    expect(resolve.calls).toHaveLength(1);
    expect(JSON.stringify(resolve.calls)).not.toContain(KEY);
  });
});

describe("POST /api/resolve/messages", () => {
  it("passes the checked message to Resolve and answers 202 with the new thread", async () => {
    const resolve = resolveAt(() =>
      Response.json({ ...accepted, extra: "dropped" }, { status: 202 }),
    );
    const answer = await messagesRoute(post(JSON.stringify(message)), {
      env,
      fetch: resolve.fetch,
    });
    expect(await bodyOf(answer)).toEqual({ status: 202, body: accepted });
    expect(resolve.calls).toHaveLength(1);
    const [call] = resolve.calls;
    expect(call?.url).toBe("http://resolve.test:9000/messages");
    expect(call?.init?.method).toBe("POST");
    expect(new Headers(call?.init?.headers).get("content-type")).toBe("application/json");
    expect(JSON.parse(String(call?.init?.body))).toEqual(message);
  });

  it("passes on Resolve's 400 sentence", async () => {
    const sentence = "The first photo isn't the JPEG image its type says.";
    const resolve = resolveAt(() => Response.json({ message: sentence }, { status: 400 }));
    expect(
      await bodyOf(
        await messagesRoute(post(JSON.stringify(message)), { env, fetch: resolve.fetch }),
      ),
    ).toEqual({ status: 400, body: { message: sentence } });
  });

  it("refuses a request that isn't a valid message before it reaches Resolve", async () => {
    const bodies = [
      "{",
      "[]",
      JSON.stringify({ ...message, extra: true }),
      JSON.stringify({ ...message, mode: "turbo" }),
      JSON.stringify({ ...message, attachments: [{ content_type: "image/gif", data: "R0lG" }] }),
      JSON.stringify({ ...message, attachments: [{ content_type: "image/jpeg", data: "%%%" }] }),
      JSON.stringify({ ...message, attachments: Array(4).fill(message.attachments[0]) }),
      JSON.stringify({ ...message, body: " " }),
      JSON.stringify({ ...message, thread_id: "../threads" }),
    ];
    for (const body of bodies) {
      const resolve = resolveAt(() => Response.json(accepted, { status: 202 }));
      expect(await bodyOf(await messagesRoute(post(body), { env, fetch: resolve.fetch }))).toEqual({
        status: 400,
        body: { message: BAD_MESSAGE },
      });
      expect(resolve.calls).toEqual([]);
    }
  });

  it("refuses a body over 10 MB without reading it into Resolve", async () => {
    const resolve = resolveAt(() => Response.json(accepted, { status: 202 }));
    const big = post(JSON.stringify({ ...message, body: "x".repeat(MAX_MESSAGE_BYTES) }));
    const answer = await bodyOf(await messagesRoute(big, { env, fetch: resolve.fetch }));
    expect(answer.status).toBe(400);
    expect(answer.body.message).toMatch(/10 MB\.$/);
    expect(resolve.calls).toEqual([]);
  });

  it("answers 502 with one sentence when Resolve is down or answers junk", async () => {
    const answers: (() => Response | Promise<Response>)[] = [
      () => Promise.reject(new TypeError("fetch failed")),
      () => new Response("<html>", { status: 202 }),
      () => Response.json({ ...accepted, thread_id: "nope" }, { status: 202 }),
      () => Response.json({ message: "Resolve has no database." }, { status: 503 }),
      () => Response.json({ oops: true }, { status: 400 }),
      () => Response.json(accepted, { status: 200 }),
    ];
    for (const answer of answers) {
      const resolve = resolveAt(answer);
      expect(
        await bodyOf(
          await messagesRoute(post(JSON.stringify(message)), { env, fetch: resolve.fetch }),
        ),
      ).toEqual({ status: 502, body: { message: RESOLVE_UNREACHABLE } });
    }
    const nowhere = resolveAt(() => Response.json(accepted, { status: 202 }));
    expect(
      (
        await messagesRoute(post(JSON.stringify(message)), {
          env: { RESOLVE_AGENT_URL: "file:///x", GATE_URL: "http://gate.test" },
          fetch: nowhere.fetch,
        })
      ).status,
    ).toBe(502);
    expect(nowhere.calls).toEqual([]);
  });
});
