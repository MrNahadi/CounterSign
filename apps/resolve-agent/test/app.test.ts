import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createTestDatabase,
  type DatabaseHandle,
  finishDraft,
  finishRun,
  listThreads,
  openPgliteDirectory,
  queueDraft,
  readDraft,
  readRun,
  readThread,
  startDraft,
  startRun,
  ticketAttachments,
} from "@countersign/db";
import type { GenerateContentParameters, GenerateContentResponse } from "@google/genai";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import type { TransportFactory } from "../src/baseline";
import { MAX_ATTACHMENT_BYTES } from "../src/messages";
import { createModeRunner, createRunQueue, type ModeRunner, type RunQueue } from "../src/queue";
import { DEFAULT_PORT, parsePort, serve } from "../src/serve";

// Resolve's HTTP API on 127.0.0.1 port 0, with PGlite and an injected mode runner. The people
// are illustrative and every message is simulated.

const MODEL = "gemini-3.5-flash-lite";
const NOW = new Date("2026-10-20T08:00:00Z");
const BUYER = "amina.k@example.com";

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 16]);
const WEBP = Uint8Array.from([0x52, 0x49, 0x46, 0x46, 4, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);
const GIF = Uint8Array.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]);
const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");

const EMAIL = {
  channel: "email",
  sender_email: BUYER,
  subject: "Coaster set KIK-1035",
  body: "My coaster set hasn't arrived.\nThe tracking hasn't moved in ten days.",
};

let handle: DatabaseHandle;
let servers: HttpServer[];
let temps: string[];
let started: string[];
let active: number;
let most: number;
let queue: RunQueue;

// Finishes each run as replied after a short wait, recording the order and the concurrency.
const fakeRunner: ModeRunner = async (runId) => {
  active++;
  most = Math.max(most, active);
  started.push(runId);
  await startRun(handle.db, runId, NOW.toISOString());
  await new Promise((resolve) => setTimeout(resolve, 20));
  await finishRun(handle.db, runId, {
    status: "replied",
    outcome: "replied",
    reply: `Reply to ${runId}.`,
    modelVersions: ["gemini-3.5-flash-lite-001"],
    trace: { mode: "protected", tools: [], rewrites: [], steps: [] },
    finishedAt: NOW.toISOString(),
  });
  active--;
};

// The fake drafter: proposes each draft after a short wait, sharing the counters with runs. A
// dispute listed in `failing` ends its draft failed instead.
let failing: Set<string>;
const fakeDrafter = async (draftId: string) => {
  active++;
  most = Math.max(most, active);
  started.push(draftId);
  await startDraft(handle.db, draftId, NOW.toISOString());
  await new Promise((resolve) => setTimeout(resolve, 20));
  const fails = failing.has((await readDraft(handle.db, draftId))?.disputeId ?? "");
  await finishDraft(handle.db, draftId, {
    status: fails ? "failed" : "proposed",
    outcome: fails ? "gate_unavailable" : "proposed",
    finishedAt: NOW.toISOString(),
    ...(fails
      ? {}
      : {
          draftedBy: "template",
          notes: ["Order KIK-1042, paid $240.00. Records attached."],
          factsSummary: { dispute_id: "PP-D-1" },
          agentResponse: { decision: "pending_approval", intent_id: "int_1" },
          intentId: "int_1",
        }),
  });
  active--;
};

// Runs messages with the fake runner and drafts with the fake drafter, on one queue.
const sharedRunner: ModeRunner = async (id) =>
  id.startsWith("drf_") ? fakeDrafter(id) : fakeRunner(id);

let tick = 0;
const clock = () => new Date(NOW.getTime() + 1000 * tick++);

async function listen(runner: ModeRunner = sharedRunner, dailyCap?: number): Promise<string> {
  queue = createRunQueue(runner);
  const server = createApp({
    db: handle.db,
    model: MODEL,
    queue,
    clock,
    ...(dailyCap === undefined ? {} : { dailyCap }),
  }).listen(0, "127.0.0.1");
  servers.push(server);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

const post = (base: string, body: unknown) =>
  fetch(`${base}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

beforeEach(async () => {
  handle = await createTestDatabase();
  servers = [];
  temps = [];
  started = [];
  active = 0;
  most = 0;
  tick = 0;
  failing = new Set();
});

afterEach(async () => {
  for (const server of servers) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  await queue?.idle();
  await handle.close();
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

describe("POST /messages refusals", () => {
  const big = new Uint8Array(MAX_ATTACHMENT_BYTES + 1);
  big.set(PNG);
  const cases: [string, unknown, RegExp][] = [
    ["an unknown key", { ...EMAIL, priority: "high" }, /field Resolve doesn't take/],
    [
      "an unknown photo key",
      { ...EMAIL, attachments: [{ content_type: "image/png", data: b64(PNG), name: "a" }] },
      /photo has a field/,
    ],
    ["a bad channel", { ...EMAIL, channel: "sms" }, /channel must be email or chat/],
    ["an email with no sender", { ...EMAIL, sender_email: undefined }, /sender's email address/],
    [
      "a bad email address",
      { ...EMAIL, sender_email: "not-an-address" },
      /email address isn't valid/,
    ],
    ["an email with no subject", { ...EMAIL, subject: undefined }, /needs a subject/],
    ["an email with a phone", { ...EMAIL, sender_phone: "+254700000000" }, /Only a chat/],
    [
      "a subject over 200 characters",
      { ...EMAIL, subject: "a".repeat(201) },
      /subject must be 1 to 200/,
    ],
    ["an empty body", { ...EMAIL, body: "" }, /1 to 4,000 characters/],
    ["a blank body", { ...EMAIL, body: "   " }, /1 to 4,000 characters/],
    ["a body over 4,000 characters", { ...EMAIL, body: "a".repeat(4001) }, /1 to 4,000 characters/],
    [
      "a chat with a subject",
      { channel: "chat", sender_email: BUYER, subject: "Hi", body: "Hi" },
      /Only an email/,
    ],
    ["a chat with no sender", { channel: "chat", body: "Hi" }, /email address or phone number/],
    ["a bad mode", { ...EMAIL, mode: "unchecked" }, /protected or baseline/],
    [
      "four photos",
      {
        ...EMAIL,
        attachments: [1, 2, 3, 4].map(() => ({ content_type: "image/png", data: b64(PNG) })),
      },
      /up to 3 photos/,
    ],
    [
      "a GIF",
      { ...EMAIL, attachments: [{ content_type: "image/gif", data: b64(GIF) }] },
      /first photo must be a JPEG, PNG or WebP/,
    ],
    [
      "GIF bytes called PNG",
      { ...EMAIL, attachments: [{ content_type: "image/png", data: b64(GIF) }] },
      /first photo isn't the PNG image/,
    ],
    [
      "PNG bytes called JPEG",
      {
        ...EMAIL,
        attachments: [
          { content_type: "image/png", data: b64(PNG) },
          { content_type: "image/jpeg", data: b64(PNG) },
        ],
      },
      /second photo isn't the JPEG image/,
    ],
    [
      "bad base64",
      { ...EMAIL, attachments: [{ content_type: "image/png", data: "%%%%" }] },
      /isn't valid base64/,
    ],
    [
      "a photo over 2 MB",
      { ...EMAIL, attachments: [{ content_type: "image/png", data: b64(big) }] },
      /larger than 2 MB/,
    ],
    ["an unknown thread", { ...EMAIL, thread_id: "tkt_nope" }, /no thread with that ID/],
    ["a JSON array", [EMAIL], /must be a JSON object/],
    ["unreadable JSON", "{ not json", /must be a JSON object/],
  ];

  it.each(cases)(
    "refuses %s with one sentence and stores nothing",
    async (_name, body, sentence) => {
      const base = await listen();
      const res = await post(base, body);
      expect(res.status).toBe(400);
      const answer = (await res.json()) as { message: string };
      expect(Object.keys(answer)).toEqual(["message"]);
      expect(answer.message).toMatch(sentence);
      expect(answer.message).toMatch(/^[^.]+\.$/);
      expect(await listThreads(handle.db)).toEqual([]);
      expect(await handle.db.select().from(ticketAttachments)).toEqual([]);
      expect(started).toEqual([]);
    },
  );

  it("refuses a follow-up whose channel or sender differs from the thread's", async () => {
    const base = await listen();
    const first = (await (await post(base, EMAIL)).json()) as { thread_id: string };
    await queue.idle();
    for (const body of [
      { ...EMAIL, thread_id: first.thread_id, sender_email: "grace.w@example.com" },
      { channel: "chat", sender_email: BUYER, body: "Any news?", thread_id: first.thread_id },
    ]) {
      const res = await post(base, body);
      expect(res.status).toBe(400);
      expect(((await res.json()) as { message: string }).message).toBe(
        "That thread has another channel or sender.",
      );
    }
    expect(await readThread(handle.db, first.thread_id)).toHaveLength(1);
  });
});

describe("POST /messages", () => {
  it("stores the photos, a simulated ticket and a queued run, and answers 202", async () => {
    const base = await listen(async () => {});
    const res = await post(base, {
      ...EMAIL,
      attachments: [
        { content_type: "image/png", data: b64(PNG) },
        { content_type: "image/jpeg", data: b64(JPEG) },
        { content_type: "image/webp", data: b64(WEBP) },
      ],
    });
    expect(res.status).toBe(202);
    const ids = (await res.json()) as { ticket_id: string; thread_id: string; run_id: string };
    expect(Object.keys(ids).sort()).toEqual(["run_id", "thread_id", "ticket_id"]);
    expect(ids.ticket_id).toMatch(/^tkt_[0-9a-f]{32}$/);
    expect(ids.thread_id).toBe(ids.ticket_id);
    expect(ids.run_id).toMatch(/^run_[0-9a-f]{32}$/);

    const [ticket] = await readThread(handle.db, ids.thread_id);
    expect(ticket).toMatchObject({
      id: ids.ticket_id,
      channel: "email",
      senderEmail: BUYER,
      senderPhone: null,
      subject: EMAIL.subject,
      body: EMAIL.body,
      simulated: true,
      receivedAt: NOW.toISOString(),
    });
    expect(ticket?.attachments.map((a) => a.contentType)).toEqual([
      "image/png",
      "image/jpeg",
      "image/webp",
    ]);
    expect(await readRun(handle.db, ids.run_id)).toMatchObject({
      status: "queued",
      mode: "protected",
      model: MODEL,
      ticketId: ids.ticket_id,
      threadId: ids.thread_id,
    });

    const [png, jpeg] = ticket?.attachments ?? [];
    for (const [attachment, bytes] of [
      [png, PNG],
      [jpeg, JPEG],
    ] as const) {
      const photo = await fetch(`${base}/attachments/${attachment?.id}`);
      expect(photo.status).toBe(200);
      expect(photo.headers.get("content-type")).toBe(attachment?.contentType);
      expect(new Uint8Array(await photo.arrayBuffer())).toEqual(bytes);
    }
    expect((await fetch(`${base}/attachments/att_${"0".repeat(32)}`)).status).toBe(404);
    expect((await fetch(`${base}/attachments/nope`)).status).toBe(404);
  });

  it("takes a chat with only a phone, in baseline mode, and a follow-up in its thread", async () => {
    const base = await listen(async () => {});
    const chat = { channel: "chat", sender_phone: "+254 700 000 000", body: "Hello" };
    const first = (await (await post(base, { ...chat, mode: "baseline" })).json()) as {
      thread_id: string;
      run_id: string;
    };
    expect(await readRun(handle.db, first.run_id)).toMatchObject({ mode: "baseline" });
    const res = await post(base, { ...chat, body: "Any news?", thread_id: first.thread_id });
    expect(res.status).toBe(202);
    const second = (await res.json()) as { ticket_id: string; thread_id: string };
    expect(second.thread_id).toBe(first.thread_id);
    expect(second.ticket_id).not.toBe(first.thread_id);
    expect((await readThread(handle.db, first.thread_id)).map((t) => t.body)).toEqual([
      "Hello",
      "Any news?",
    ]);
  });
});

describe("the run queue and thread readers", () => {
  it("runs one at a time in the order queued, and reads threads back with replies", async () => {
    const base = await listen();
    const answers = [];
    for (const n of [1, 2, 3]) {
      const res = await post(base, {
        ...EMAIL,
        subject: `Order ${n}`,
        sender_email: `b${n}@example.com`,
      });
      answers.push((await res.json()) as { thread_id: string; run_id: string });
    }
    await queue.idle();
    expect(started).toEqual(answers.map((a) => a.run_id));
    expect(most).toBe(1);

    const list = (await (await fetch(`${base}/threads`)).json()) as {
      threads: { thread_id: string; preview: string; latest_run: { status: string } }[];
    };
    expect(list.threads.map((t) => t.thread_id)).toEqual(answers.map((a) => a.thread_id).reverse());
    expect(list.threads[0]).toMatchObject({
      channel: "email",
      sender_email: "b3@example.com",
      subject: "Order 3",
      preview: "My coaster set hasn't arrived.",
      latest_run: {
        run_id: answers[2]?.run_id,
        mode: "protected",
        status: "replied",
        outcome: "replied",
      },
    });

    const res = await fetch(`${base}/threads/${answers[0]?.thread_id}`);
    expect(res.status).toBe(200);
    const thread = (await res.json()) as Record<string, unknown>;
    expect(thread).toMatchObject({
      thread_id: answers[0]?.thread_id,
      messages: [
        { ticket_id: answers[0]?.thread_id, subject: "Order 1", simulated: true, attachments: [] },
      ],
      runs: [
        {
          run_id: answers[0]?.run_id,
          status: "replied",
          reply: `Reply to ${answers[0]?.run_id}.`,
          model_versions: ["gemini-3.5-flash-lite-001"],
          trace: { mode: "protected", steps: [] },
        },
      ],
    });
    expect((await fetch(`${base}/threads/tkt_nope`)).status).toBe(404);
  });

  it("keeps going after a run throws", async () => {
    let calls = 0;
    const base = await listen(async (runId) => {
      calls++;
      if (calls === 1) throw new Error("boom");
      await fakeRunner(runId);
    });
    await post(base, EMAIL);
    const second = (await (
      await post(base, { ...EMAIL, sender_email: "b@example.com" })
    ).json()) as {
      run_id: string;
    };
    await queue.idle();
    expect(started).toEqual([second.run_id]);
  });

  it("runs a stored message with the scripted model and reads back Resolve's reply", async () => {
    const requests: GenerateContentParameters[] = [];
    const generateContent = async (request: GenerateContentParameters) => {
      requests.push(request);
      return {
        candidates: [
          {
            content: {
              role: "model",
              parts: [{ text: "Sorry about the wait. I'm looking into it." }],
            },
            finishReason: "STOP",
          },
        ],
        modelVersion: "gemini-3.5-flash-lite-001",
        responseId: "resp",
      } as unknown as GenerateContentResponse;
    };
    const transport: TransportFactory = () => {
      const mcp = new Server({ name: "paypal", version: "1.8.1" }, { capabilities: { tools: {} } });
      mcp.setRequestHandler(ListToolsRequestSchema, () => ({ tools: [] }));
      const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
      void mcp.connect(serverSide);
      return clientSide;
    };
    const base = await listen(
      createModeRunner({
        db: handle.db,
        generateContent,
        protectedEnv: { gateUrl: null, key: null },
        issueToken: async () => ({ accessToken: "illustrative-token", expiresAt: 0 }),
        createTransport: transport,
        clock,
      }),
    );
    const ids = (await (
      await post(base, {
        ...EMAIL,
        mode: "baseline",
        attachments: [{ content_type: "image/png", data: b64(PNG) }],
      })
    ).json()) as { thread_id: string };
    await queue.idle();
    expect(requests).toHaveLength(1);
    const thread = (await (await fetch(`${base}/threads/${ids.thread_id}`)).json()) as {
      runs: { status: string; outcome: string; reply: string; mode: string }[];
    };
    expect(thread.runs).toMatchObject([
      {
        mode: "baseline",
        status: "replied",
        outcome: "replied",
        reply: "Sorry about the wait. I'm looking into it.",
      },
    ]);
    expect(JSON.stringify(thread)).not.toContain("illustrative-token");
  });

  it("ends runs not_configured when there's no model", async () => {
    const base = await listen(
      createModeRunner({
        db: handle.db,
        generateContent: null,
        protectedEnv: { gateUrl: null, key: null },
        issueToken: async () => {
          throw new Error("unused");
        },
        clock,
      }),
    );
    const ids = (await (await post(base, EMAIL)).json()) as { run_id: string };
    await queue.idle();
    expect(await readRun(handle.db, ids.run_id)).toMatchObject({
      status: "not_run",
      outcome: "not_configured",
      reply: null,
    });
  });
});

type DraftView = {
  draft_id: string;
  dispute_id: string;
  status: string;
  outcome: string | null;
  drafted_by: string | null;
  model: string;
  agent_response_status: string | null;
  intent_id: string | null;
};

const postDispute = (base: string, body: unknown) =>
  fetch(`${base}/disputes`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

const listDrafts = async (base: string) =>
  ((await (await fetch(`${base}/disputes`)).json()) as { drafts: DraftView[] }).drafts;

describe("POST /disputes and the draft readers", () => {
  it("refuses a body that isn't exactly { dispute_id }", async () => {
    const base = await listen();
    for (const body of [
      "not json",
      {},
      { dispute_id: "" },
      { dispute_id: "PP D 1" },
      { dispute_id: "P".repeat(65) },
      { dispute_id: 12 },
      { dispute_id: "PP-D-1", mode: "baseline" },
    ]) {
      const res = await postDispute(base, body);
      expect(res.status).toBe(400);
      expect(((await res.json()) as { message: string }).message).toMatch(/\.$/);
    }
    await queue.idle();
    expect(started).toEqual([]);
    expect(await listDrafts(base)).toEqual([]);
  });

  it("queues one draft per dispute, and answers the existing one unless it failed", async () => {
    const base = await listen();
    const first = await postDispute(base, { dispute_id: "PP-D-1" });
    expect(first.status).toBe(202);
    const queued = (await first.json()) as DraftView;
    expect(queued).toMatchObject({
      dispute_id: "PP-D-1",
      status: "queued",
      outcome: null,
      drafted_by: null,
      model: MODEL,
      model_versions: [],
      agent_response_status: null,
      intent_id: null,
      queued_at: NOW.toISOString(),
      started_at: null,
      finished_at: null,
    });
    expect(queued.draft_id).toMatch(/^drf_[0-9a-f]{32}$/);

    // Queued, then proposed: the same draft both times, and nothing more is queued.
    const again = await postDispute(base, { dispute_id: "PP-D-1" });
    expect(again.status).toBe(200);
    expect(((await again.json()) as DraftView).draft_id).toBe(queued.draft_id);
    await queue.idle();
    const proposed = await postDispute(base, { dispute_id: "PP-D-1" });
    expect(proposed.status).toBe(200);
    expect(await proposed.json()).toMatchObject({
      draft_id: queued.draft_id,
      status: "proposed",
      drafted_by: "template",
      agent_response_status: "pending_approval",
      intent_id: "int_1",
    });
    await queue.idle();
    expect(started).toEqual([queued.draft_id]);

    // A failed draft is drafted again as a new draft; the list shows the latest per dispute.
    failing.add("PP-D-2");
    const failed = (await (await postDispute(base, { dispute_id: "PP-D-2" })).json()) as DraftView;
    await queue.idle();
    failing.clear();
    const retry = await postDispute(base, { dispute_id: "PP-D-2" });
    expect(retry.status).toBe(202);
    const redraft = (await retry.json()) as DraftView;
    expect(redraft.draft_id).not.toBe(failed.draft_id);
    await queue.idle();
    expect(started).toEqual([queued.draft_id, failed.draft_id, redraft.draft_id]);
    expect((await listDrafts(base)).map((d) => [d.dispute_id, d.draft_id, d.status])).toEqual([
      ["PP-D-2", redraft.draft_id, "proposed"],
      ["PP-D-1", queued.draft_id, "proposed"],
    ]);
  });

  it("answers one dispute's latest draft with its facts summary, notes and agent response", async () => {
    const base = await listen();
    const posted = (await (await postDispute(base, { dispute_id: "PP-D-1" })).json()) as DraftView;
    await queue.idle();
    const res = await fetch(`${base}/disputes/PP-D-1`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      draft_id: posted.draft_id,
      dispute_id: "PP-D-1",
      status: "proposed",
      outcome: "proposed",
      drafted_by: "template",
      model: MODEL,
      model_versions: [],
      agent_response_status: "pending_approval",
      intent_id: "int_1",
      queued_at: NOW.toISOString(),
      started_at: NOW.toISOString(),
      finished_at: NOW.toISOString(),
      facts_summary: { dispute_id: "PP-D-1" },
      notes: ["Order KIK-1042, paid $240.00. Records attached."],
      agent_response: { decision: "pending_approval", intent_id: "int_1" },
    });
    for (const id of ["PP-D-404", "PP%20D", "x".repeat(65)]) {
      const missing = await fetch(`${base}/disputes/${id}`);
      expect(missing.status).toBe(404);
      expect(((await missing.json()) as { message: string }).message).toBe(
        "There's no draft for that dispute.",
      );
    }
  });

  it("runs drafts one at a time on the message queue, in the order queued", async () => {
    const base = await listen();
    const message = (await (await post(base, EMAIL)).json()) as { run_id: string };
    const draft = (await (await postDispute(base, { dispute_id: "PP-D-1" })).json()) as DraftView;
    const later = (await (
      await post(base, { ...EMAIL, sender_email: "b@example.com" })
    ).json()) as { run_id: string };
    await queue.idle();
    expect(started).toEqual([message.run_id, draft.draft_id, later.run_id]);
    expect(most).toBe(1);
  });

  it("counts drafts and message runs against one daily cap; over it a draft is not_run", async () => {
    const base = await listen(sharedRunner, 2);
    await post(base, EMAIL);
    expect((await postDispute(base, { dispute_id: "PP-D-1" })).status).toBe(202);
    const capped = await postDispute(base, { dispute_id: "PP-D-2" });
    expect(capped.status).toBe(202);
    expect(await capped.json()).toMatchObject({
      dispute_id: "PP-D-2",
      status: "not_run",
      outcome: "daily_cap",
    });
    const message = (await (
      await post(base, { ...EMAIL, sender_email: "b@example.com" })
    ).json()) as { run_id: string };
    await queue.idle();
    expect(started).toHaveLength(2);
    expect(await readRun(handle.db, message.run_id)).toMatchObject({
      status: "not_run",
      outcome: "daily_cap",
    });
    // A not_run draft isn't failed, so it's answered rather than drafted again.
    const again = await postDispute(base, { dispute_id: "PP-D-2" });
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ status: "not_run", outcome: "daily_cap" });
  });

  it("sends drafts to the drafter, and without one ends them failed", async () => {
    const drafted: string[] = [];
    const deps = {
      db: handle.db,
      generateContent: null,
      protectedEnv: { gateUrl: null, key: null },
      issueToken: async () => {
        throw new Error("unused");
      },
      clock,
    };
    const base = await listen(
      createModeRunner({
        ...deps,
        runDraft: async (draftId) => {
          drafted.push(draftId);
          await fakeDrafter(draftId);
        },
      }),
    );
    const draft = (await (await postDispute(base, { dispute_id: "PP-D-1" })).json()) as DraftView;
    await queue.idle();
    expect(drafted).toEqual([draft.draft_id]);

    const bare = await listen(createModeRunner(deps));
    await postDispute(bare, { dispute_id: "PP-D-2" });
    await queue.idle();
    expect((await (await fetch(`${bare}/disputes/PP-D-2`)).json()) as DraftView).toMatchObject({
      status: "failed",
      outcome: "not_configured",
    });
  });
});

describe("serve", () => {
  it("marks a draft the last process left unfinished failed, and never reruns it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "resolve-serve-"));
    temps.push(dir);
    const old = await openPgliteDirectory(join(dir, "pglite"));
    await queueDraft(old.db, {
      id: "drf_left",
      disputeId: "PP-D-1",
      model: MODEL,
      queuedAt: NOW.toISOString(),
    });
    await startDraft(old.db, "drf_left", NOW.toISOString());
    await old.close();

    const lines: string[] = [];
    const serving = await serve(
      { PORT: "0" },
      { pgliteDir: join(dir, "pglite"), host: "127.0.0.1", log: (line) => lines.push(line) },
    );
    try {
      const base = `http://127.0.0.1:${serving.port}`;
      expect(await (await fetch(`${base}/disputes/PP-D-1`)).json()).toMatchObject({
        draft_id: "drf_left",
        status: "failed",
        outcome: "interrupted",
        started_at: NOW.toISOString(),
      });
    } finally {
      await serving.close();
    }
    expect(lines).toContain("1 unfinished draft marked interrupted.");
  });

  it("reads PORT, defaulting to 8788", () => {
    expect(DEFAULT_PORT).toBe(8788);
    expect(parsePort({})).toBe(8788);
    expect(parsePort({ PORT: "" })).toBe(8788);
    expect(parsePort({ PORT: "9000" })).toBe(9000);
    expect(() => parsePort({ PORT: "eighty" })).toThrow(/^PORT must be/);
  });

  it("answers /health and takes messages with only a PGlite directory", async () => {
    const dir = mkdtempSync(join(tmpdir(), "resolve-serve-"));
    temps.push(dir);
    const lines: string[] = [];
    const serving = await serve(
      { PORT: "0" },
      { pgliteDir: join(dir, "pglite"), host: "127.0.0.1", log: (line) => lines.push(line) },
    );
    try {
      const base = `http://127.0.0.1:${serving.port}`;
      expect(await (await fetch(`${base}/health`)).json()).toEqual({ ok: true });
      expect((await post(base, EMAIL)).status).toBe(202);
      expect((await fetch(`${base}/threads`)).status).toBe(200);
    } finally {
      await serving.close();
    }
    expect(lines.join("\n")).toMatch(/GEMINI_API_KEY/);
    expect(lines.join("\n")).toMatch(/COUNTERSIGN_SUPPORT_AGENT_KEY/);
  });

  it("still answers /health when the database can't open", async () => {
    const dir = mkdtempSync(join(tmpdir(), "resolve-serve-"));
    temps.push(dir);
    const file = join(dir, "not-a-directory");
    writeFileSync(file, "");
    const serving = await serve(
      { PORT: "0" },
      { pgliteDir: join(file, "pglite"), host: "127.0.0.1", log: () => {} },
    );
    try {
      const base = `http://127.0.0.1:${serving.port}`;
      expect((await fetch(`${base}/health`)).status).toBe(200);
      const res = await fetch(`${base}/threads`);
      expect(res.status).toBe(503);
      expect(((await res.json()) as { message: string }).message).toMatch(/no database/);
    } finally {
      await serving.close();
    }
  });
});
