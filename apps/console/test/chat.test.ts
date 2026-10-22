import { describe, expect, it } from "vitest";
import {
  CHAT_CONTROLS,
  CHAT_NOTICE,
  CHAT_UNANSWERED,
  type ChatForm,
  chatRequest,
  chatView,
  emailProblem,
  loadChat,
  parseStoredChat,
} from "../src/chat";
import { toBase64 } from "../src/composer";
import { messagesRoute, RESOLVE_UNREACHABLE, threadRoute } from "../src/resolve-routes";
import type { Run, ThreadDetail, ThreadMessage } from "../src/resolve-schemas";

// The customer's simulated chat: what the form becomes, what the thread shows, and how it's
// read, through the console's existing Resolve routes with Resolve played by an injected fetch.

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
const id = (prefix: string, c: string) => `${prefix}_${c.repeat(32)}`;
const THREAD = id("tkt", "a");
const SECOND = id("tkt", "b");
const ATT = id("att", "c");
const env = { RESOLVE_AGENT_URL: "http://resolve.test:8788" };

const form: ChatForm = {
  email: " payer@example.com ",
  body: " The basket arrived crushed. ",
  photo: { name: "basket.jpg", type: "image/jpeg", size: JPEG.byteLength, bytes: JPEG },
  threadId: null,
};

const message = (ticketId: string, body: string, extra: Partial<ThreadMessage> = {}) =>
  ({
    ticket_id: ticketId,
    channel: "chat",
    sender_email: "payer@example.com",
    sender_phone: null,
    subject: null,
    body,
    attachments: [],
    received_at: "2026-10-21T09:00:00.000Z",
    simulated: true,
    ...extra,
  }) satisfies ThreadMessage;

const run = (runId: string, ticketId: string, extra: Partial<Run> = {}): Run => ({
  run_id: runId,
  ticket_id: ticketId,
  mode: "protected",
  model: "gemini-3.5-flash-lite",
  model_versions: ["gemini-3.5-flash-lite-001"],
  status: "replied",
  outcome: "replied",
  reply: "Your refund is on its way.",
  queued_at: "2026-10-21T09:00:00.000Z",
  started_at: "2026-10-21T09:00:01.000Z",
  finished_at: "2026-10-21T09:00:15.000Z",
  trace: {
    mode: "protected",
    steps: [
      {
        kind: "tool",
        step: 1,
        id: "call_1",
        name: "create_refund",
        args: { capture_id: "CAP-SECRET-TRACE" },
        result: { content: [{ type: "text", text: "allowed" }] },
        latencyMs: 40,
        local: false,
      },
    ],
  },
  executions: [
    { intent_id: "int_1", outcome: "executed", refund_id: "REF-1", refund_status: "COMPLETED" },
  ],
  held: [],
  ...extra,
});

describe("the chat's copy and controls", () => {
  it("labels the chat as simulated and the shop as illustrative", () => {
    expect(CHAT_NOTICE).toBe("Simulated chat. Kikapu Studio is an illustrative shop.");
    expect(CHAT_UNANSWERED).toBe("Resolve couldn't answer this one. The shop will reply soon.");
  });

  it("gives every control a hit target of at least 24px and the send button 40px", () => {
    const px = (classes: string) => {
      const sizes = [...classes.matchAll(/(?:^|\s)(?:size|h|min-h)-(\d+)(?=\s|$)/g)].map(
        (match) => Number(match[1]) * 4,
      );
      return Math.max(0, ...sizes);
    };
    for (const [name, classes] of Object.entries(CHAT_CONTROLS)) {
      expect(px(classes), name).toBeGreaterThanOrEqual(24);
    }
    expect(px(CHAT_CONTROLS.send)).toBe(40);
    expect(CHAT_CONTROLS.send).toMatch(/(?:^|\s)size-10(?:\s|$)/);
  });
});

describe("chatRequest", () => {
  it("turns the first message into a chat that starts a thread, in the chosen mode", () => {
    expect(chatRequest(form, "baseline")).toEqual({
      ok: true,
      request: {
        channel: "chat",
        sender_email: "payer@example.com",
        body: "The basket arrived crushed.",
        attachments: [{ content_type: "image/jpeg", data: toBase64(JPEG) }],
        mode: "baseline",
      },
    });
  });

  it("sends later messages as follow-ups in the same thread", () => {
    const result = chatRequest({ ...form, photo: null, threadId: THREAD }, "protected");
    expect(result).toEqual({
      ok: true,
      request: {
        channel: "chat",
        thread_id: THREAD,
        sender_email: "payer@example.com",
        body: "The basket arrived crushed.",
        attachments: [],
        mode: "protected",
      },
    });
  });

  it("asks for an email address and a message, in one sentence each", () => {
    expect(chatRequest({ ...form, email: "" }, "protected")).toEqual({
      ok: false,
      field: "email",
      problem: "Add your email address.",
    });
    expect(chatRequest({ ...form, email: "nope" }, "protected")).toEqual({
      ok: false,
      field: "email",
      problem: "Use an email address like name@example.com.",
    });
    expect(emailProblem(" a@example.com ")).toBeNull();
    expect(emailProblem("a@")).toBe("Use an email address like name@example.com.");
    expect(chatRequest({ ...form, body: " " }, "protected")).toEqual({
      ok: false,
      field: "body",
      problem: "Write a message.",
    });
    const gif = { ...form, photo: { ...form.photo, name: "a.gif", type: "image/gif" } } as ChatForm;
    expect(chatRequest(gif, "protected")).toEqual({
      ok: false,
      field: "photo",
      problem: "a.gif isn't a JPEG, PNG or WebP image.",
    });
    expect(chatRequest({ ...form, threadId: "tkt_nope" }, "protected").ok).toBe(false);
  });

  it("passes through the console's route to Resolve with the thread ID", async () => {
    const result = chatRequest({ ...form, threadId: THREAD }, "protected");
    if (!result.ok) throw new Error("fixture");
    const sent: unknown[] = [];
    const resolve = (async (_url: string | URL | Request, init?: RequestInit) => {
      sent.push(JSON.parse(String(init?.body)));
      return Response.json(
        { ticket_id: SECOND, thread_id: THREAD, run_id: id("run", "d") },
        { status: 202 },
      );
    }) as typeof fetch;
    const answer = await messagesRoute(
      new Request("http://console.test/api/resolve/messages", {
        method: "POST",
        body: JSON.stringify(result.request),
      }),
      { env, fetch: resolve },
    );
    expect(answer.status).toBe(202);
    expect(sent).toEqual([result.request]);
  });
});

describe("chatView", () => {
  const thread = (messages: ThreadMessage[], runs: Run[]): ThreadDetail => ({
    thread_id: THREAD,
    messages: messages as ThreadDetail["messages"],
    runs,
  });

  it("shows each message, then its reply, in order, with photos from the console's route", () => {
    const view = chatView(
      thread(
        [
          message(THREAD, "Where is KIK-1035?", {
            attachments: [{ id: ATT, content_type: "image/jpeg" }],
          }),
          message(SECOND, "Thanks."),
        ],
        [run("run_1", THREAD), run("run_2", SECOND, { reply: "You're welcome." })],
      ),
    );
    expect(view).toEqual({
      threadId: THREAD,
      email: "payer@example.com",
      working: false,
      entries: [
        {
          kind: "customer",
          key: THREAD,
          body: "Where is KIK-1035?",
          photos: [{ id: ATT, src: `/api/resolve/attachments/${ATT}` }],
        },
        { kind: "reply", key: "run_1", text: "Your refund is on its way." },
        { kind: "customer", key: SECOND, body: "Thanks.", photos: [] },
        { kind: "reply", key: "run_2", text: "You're welcome." },
      ],
    });
  });

  it("never shows the trace, tool calls or decisions", () => {
    const shown = JSON.stringify(chatView(thread([message(THREAD, "Hi")], [run("run_1", THREAD)])));
    for (const hidden of ["create_refund", "CAP-SECRET-TRACE", "allowed", "REF-1", "int_1"]) {
      expect(shown).not.toContain(hidden);
    }
  });

  it("shows a working state while a run is queued or running", () => {
    for (const status of ["queued", "running"] as const) {
      const view = chatView(
        thread(
          [message(THREAD, "Hi")],
          [run("run_1", THREAD, { status, outcome: null, reply: null })],
        ),
      );
      expect(view?.working).toBe(true);
      expect(view?.entries.at(-1)).toEqual({ kind: "working", key: "run_1" });
    }
    const noRunYet = chatView(thread([message(THREAD, "Hi")], []));
    expect(noRunYet?.working).toBe(true);
    expect(noRunYet?.entries.at(-1)).toEqual({ kind: "working", key: `${THREAD}-working` });
  });

  it("says Resolve couldn't answer for a stopped, failed or not-run run", () => {
    for (const [status, outcome] of [
      ["stopped", "step_cap"],
      ["failed", "gate_unavailable"],
      ["not_run", "daily_cap"],
    ] as const) {
      const view = chatView(
        thread([message(THREAD, "Hi")], [run("run_1", THREAD, { status, outcome, reply: null })]),
      );
      expect(view?.entries.at(-1)).toEqual({
        kind: "unanswered",
        key: "run_1",
        text: CHAT_UNANSWERED,
      });
      expect(JSON.stringify(view)).not.toContain(outcome);
    }
    const blank = chatView(thread([message(THREAD, "Hi")], [run("run_1", THREAD, { reply: " " })]));
    expect(blank?.entries.at(-1)?.kind).toBe("unanswered");
  });

  it("shows only the latest run of a message, so a fallback rerun replaces a failed one", () => {
    const view = chatView(
      thread(
        [message(THREAD, "Hi")],
        [
          run("run_1", THREAD, { status: "failed", outcome: "model_unavailable", reply: null }),
          run("run_2", THREAD, { reply: "Hello." }),
        ],
      ),
    );
    expect(view?.entries.slice(1)).toEqual([{ kind: "reply", key: "run_2", text: "Hello." }]);
  });

  it("refuses a thread that isn't a chat", () => {
    expect(
      chatView(thread([message(THREAD, "Hi", { channel: "email", subject: "Hi" })], [])),
    ).toBeNull();
  });
});

describe("loadChat", () => {
  const detail = thread();
  function thread(): ThreadDetail {
    return {
      thread_id: THREAD,
      messages: [message(THREAD, "Hi")],
      runs: [run("run_1", THREAD)],
    };
  }

  const throughRoute = (resolveAnswer: () => Response | Promise<Response>) => {
    const urls: string[] = [];
    const resolve = (async () => resolveAnswer()) as typeof fetch;
    const browser = (async (input: string | URL | Request) => {
      const url = String(input);
      urls.push(url);
      const threadId = decodeURIComponent(url.split("/").at(-1) ?? "");
      return threadRoute(threadId, { env, fetch: resolve });
    }) as typeof fetch;
    return { urls, fetch: browser };
  };

  it("reads the thread through the console's route", async () => {
    const route = throughRoute(() => Response.json(detail));
    const result = await loadChat(THREAD, { fetch: route.fetch });
    expect(route.urls).toEqual([`/api/resolve/threads/${THREAD}`]);
    expect(result).toEqual({ ok: true, view: chatView(detail) });
  });

  it("says the chat is gone on a 404, and Resolve is unreachable for anything else", async () => {
    const gone = throughRoute(() =>
      Response.json({ message: "There's no thread with that ID." }, { status: 404 }),
    );
    expect(await loadChat(THREAD, { fetch: gone.fetch })).toEqual({
      ok: false,
      missing: true,
      message: "This chat has ended. Start a new one.",
    });
    for (const answer of [
      () => new Response("<html>", { status: 500 }),
      () => Response.json({ thread_id: THREAD }),
      () => Promise.reject(new TypeError("fetch failed")),
    ]) {
      expect(await loadChat(THREAD, { fetch: throughRoute(answer).fetch })).toEqual({
        ok: false,
        missing: false,
        message: RESOLVE_UNREACHABLE,
      });
    }
    const failing = (async () => {
      throw new TypeError("Failed to fetch");
    }) as typeof fetch;
    expect((await loadChat(THREAD, { fetch: failing })).ok).toBe(false);
  });

  it("treats an email thread as gone", async () => {
    const email = { ...detail, messages: [message(THREAD, "Hi", { channel: "email" })] };
    const route = throughRoute(() => Response.json(email));
    expect(await loadChat(THREAD, { fetch: route.fetch })).toMatchObject({
      ok: false,
      missing: true,
    });
  });
});

describe("parseStoredChat", () => {
  it("keeps a valid email and thread, and drops anything else", () => {
    expect(parseStoredChat(JSON.stringify({ email: "a@example.com", threadId: THREAD }))).toEqual({
      email: "a@example.com",
      threadId: THREAD,
    });
    expect(parseStoredChat(JSON.stringify({ email: "a@example.com", threadId: null }))).toEqual({
      email: "a@example.com",
      threadId: null,
    });
    for (const raw of [null, "", "{", JSON.stringify({ email: "x", threadId: THREAD })]) {
      expect(parseStoredChat(raw)).toBeNull();
    }
  });
});
