import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createTestDatabase,
  type DatabaseHandle,
  finishRun,
  listThreads,
  readRun,
  readThread,
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

let tick = 0;
const clock = () => new Date(NOW.getTime() + 1000 * tick++);

async function listen(runner: ModeRunner = fakeRunner): Promise<string> {
  queue = createRunQueue(runner);
  const server = createApp({ db: handle.db, model: MODEL, queue, clock }).listen(0, "127.0.0.1");
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

describe("serve", () => {
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
