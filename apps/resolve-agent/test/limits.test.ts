import { mkdtempSync, rmSync } from "node:fs";
import type { Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createRun,
  createTestDatabase,
  type DatabaseHandle,
  finishRun,
  type NewRun,
  openDatabase,
  readRun,
  resolveDatabaseTarget,
  startRun,
  writeTicket,
} from "@countersign/db";
import {
  ApiError,
  type GenerateContentParameters,
  type GenerateContentResponse,
} from "@google/genai";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import type { TransportFactory } from "../src/baseline";
import { parseDailyCap } from "../src/limits";
import { createModeRunner, createRunQueue, type RunQueue } from "../src/queue";
import { serve } from "../src/serve";

// The daily cap, interrupted runs and the fallback rerun, through Resolve's app factory and run
// queue with PGlite, a scripted model and an injected clock. People are illustrative; messages
// are simulated.

const MODEL = "gemini-3.5-flash-lite";
const FALLBACK = "gemini-3.1-flash-lite";
const EMAIL = {
  channel: "email",
  sender_email: "amina.k@example.com",
  subject: "Coaster set KIK-1035",
  mode: "baseline",
  body: "My coaster set hasn't arrived.",
};

let handle: DatabaseHandle;
let servers: HttpServer[];
let temps: string[];
let queue: RunQueue;
let now: Date;
const clock = () => now;

beforeEach(async () => {
  handle = await createTestDatabase();
  servers = [];
  temps = [];
  now = new Date("2026-10-20T08:00:00Z");
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

const textResponse = (text: string) =>
  ({
    candidates: [{ content: { role: "model", parts: [{ text }] }, finishReason: "STOP" }],
    modelVersion: "v1",
  }) as unknown as GenerateContentResponse;

const callResponse = () =>
  ({
    candidates: [
      {
        content: {
          role: "model",
          parts: [
            { functionCall: { id: "c1", name: "find_order", args: { order_number: "KIK-1035" } } },
          ],
        },
        finishReason: "STOP",
      },
    ],
    modelVersion: "v1",
  }) as unknown as GenerateContentResponse;

const unavailable = () => new ApiError({ status: 503, message: "{}" });

type Step = GenerateContentResponse | Error;

async function listen(options: {
  script: Step[];
  dailyCap?: number;
  fallbackModel?: string | null;
  withModel?: boolean;
}) {
  const requests: GenerateContentParameters[] = [];
  const script = [...options.script];
  const generateContent = async (request: GenerateContentParameters) => {
    requests.push(request);
    const next = script.shift();
    if (next === undefined) throw new Error("The script ran out.");
    if (next instanceof Error) throw next;
    return next;
  };
  const transport: TransportFactory = () => {
    const mcp = new Server({ name: "paypal", version: "1.8.1" }, { capabilities: { tools: {} } });
    mcp.setRequestHandler(ListToolsRequestSchema, () => ({ tools: [] }));
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    void mcp.connect(serverSide);
    return clientSide;
  };
  queue = createRunQueue(
    createModeRunner({
      db: handle.db,
      generateContent: options.withModel === false ? null : generateContent,
      protectedEnv: { gateUrl: null, key: null },
      issueToken: async () => ({ accessToken: "illustrative-token", expiresAt: 0 }),
      createTransport: transport,
      clock,
      fallbackModel: options.fallbackModel === undefined ? FALLBACK : options.fallbackModel,
    }),
  );
  const server = createApp({
    db: handle.db,
    model: MODEL,
    queue,
    clock,
    ...(options.dailyCap ? { dailyCap: options.dailyCap } : {}),
  }).listen(0, "127.0.0.1");
  servers.push(server);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { base, requests };
}

const send = async (base: string, body: unknown = EMAIL) => {
  const res = await fetch(`${base}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return (await res.json()) as { thread_id: string; run_id: string; ticket_id: string };
};

const runsOf = async (base: string, threadId: string) =>
  (
    (await (await fetch(`${base}/threads/${threadId}`)).json()) as {
      runs: { model: string; status: string; outcome: string; reply: string | null }[];
    }
  ).runs;

describe("the daily run cap", () => {
  it("stores a message past the cap and ends its run not_run daily_cap with no model call", async () => {
    const { base, requests } = await listen({
      dailyCap: 2,
      script: [textResponse("One."), textResponse("Two."), textResponse("Three.")],
    });
    await send(base);
    await send(base);
    await queue.idle();
    expect(requests).toHaveLength(2);

    const third = await send(base);
    await queue.idle();
    expect(requests).toHaveLength(2);
    expect(await readRun(handle.db, third.run_id)).toMatchObject({
      status: "not_run",
      outcome: "daily_cap",
      reply: null,
    });
    expect(await runsOf(base, third.thread_id)).toHaveLength(1);
  });

  it("counts per UTC date, every status included", async () => {
    const { base, requests } = await listen({
      dailyCap: 1,
      script: [textResponse("One."), textResponse("Next day.")],
    });
    await send(base);
    await queue.idle();
    const capped = await send(base);
    expect((await readRun(handle.db, capped.run_id))?.outcome).toBe("daily_cap");

    now = new Date("2026-10-20T23:59:59Z");
    expect((await readRun(handle.db, (await send(base)).run_id))?.outcome).toBe("daily_cap");

    now = new Date("2026-10-21T00:00:00Z");
    const nextDay = await send(base);
    await queue.idle();
    expect((await readRun(handle.db, nextDay.run_id))?.outcome).toBe("replied");
    expect(requests).toHaveLength(2);
  });

  it("defaults to 200, and refuses a bad value naming the variable", async () => {
    expect(parseDailyCap({})).toBe(200);
    expect(parseDailyCap({ RESOLVE_DAILY_RUN_CAP: "" })).toBe(200);
    expect(parseDailyCap({ RESOLVE_DAILY_RUN_CAP: "5" })).toBe(5);
    for (const bad of ["0", "-3", "2.5", "many", "1e3", "99999999999999999999"]) {
      expect(() => parseDailyCap({ RESOLVE_DAILY_RUN_CAP: bad })).toThrow(
        /^RESOLVE_DAILY_RUN_CAP must be/,
      );
      expect(() => parseDailyCap({ RESOLVE_DAILY_RUN_CAP: bad })).not.toThrow(
        new RegExp(bad.replace(/[.+-]/g, "\\$&")),
      );
    }
    const dir = mkdtempSync(join(tmpdir(), "resolve-cap-"));
    temps.push(dir);
    await expect(
      serve(
        { PORT: "0", RESOLVE_DAILY_RUN_CAP: "0" },
        { pgliteDir: join(dir, "p"), log: () => {} },
      ),
    ).rejects.toThrow(/RESOLVE_DAILY_RUN_CAP/);
  });
});

describe("interrupted runs", () => {
  it("fails queued and running runs at startup and reruns none", async () => {
    const dir = mkdtempSync(join(tmpdir(), "resolve-sweep-"));
    temps.push(dir);
    const pgliteDir = join(dir, "pglite");
    const earlier = await openDatabase(resolveDatabaseTarget({}, pgliteDir));
    const at = now.toISOString();
    const ticketId = "tkt_illustrative";
    await writeTicket(earlier.db, {
      id: ticketId,
      channel: "email",
      senderEmail: "amina.k@example.com",
      senderPhone: null,
      subject: "Coaster set KIK-1035",
      body: "My coaster set hasn't arrived.",
      attachments: [],
      receivedAt: at,
      simulated: true,
      threadId: ticketId,
    });
    const base = { ticketId, threadId: ticketId, mode: "protected", model: MODEL, queuedAt: at };
    await createRun(earlier.db, { ...base, id: "run_queued" } as NewRun);
    await createRun(earlier.db, { ...base, id: "run_running" } as NewRun);
    await startRun(earlier.db, "run_running", at);
    await createRun(earlier.db, { ...base, id: "run_done" } as NewRun);
    await finishRun(earlier.db, "run_done", {
      status: "replied",
      outcome: "replied",
      reply: "Done.",
      modelVersions: [],
      trace: null,
      finishedAt: at,
    });
    await earlier.close();

    const serving = await serve({ PORT: "0" }, { pgliteDir, host: "127.0.0.1", log: () => {} });
    try {
      const thread = (await (
        await fetch(`http://127.0.0.1:${serving.port}/threads/${ticketId}`)
      ).json()) as { runs: { run_id: string; status: string; outcome: string }[] };
      const byId = Object.fromEntries(thread.runs.map((run) => [run.run_id, run]));
      expect(byId.run_queued).toMatchObject({ status: "failed", outcome: "interrupted" });
      expect(byId.run_running).toMatchObject({ status: "failed", outcome: "interrupted" });
      expect(byId.run_done).toMatchObject({ status: "replied", outcome: "replied" });
      expect(thread.runs).toHaveLength(3);
    } finally {
      await serving.close();
    }
  });
});

describe("the fallback rerun", () => {
  it("follows a model_unavailable run that made no tool call with one run on the fallback", async () => {
    const { base, requests } = await listen({
      script: [unavailable(), textResponse("Sorry about the wait.")],
    });
    const sent = await send(base);
    await queue.idle();
    expect(requests.map((request) => request.model)).toEqual([MODEL, FALLBACK]);
    expect(await runsOf(base, sent.thread_id)).toMatchObject([
      { model: MODEL, status: "failed", outcome: "model_unavailable" },
      { model: FALLBACK, status: "replied", reply: "Sorry about the wait." },
    ]);
  });

  it("reruns only once, even when the fallback is unavailable too", async () => {
    const { base, requests } = await listen({
      script: [unavailable(), unavailable(), unavailable()],
    });
    const sent = await send(base);
    await queue.idle();
    expect(requests).toHaveLength(2);
    expect(await runsOf(base, sent.thread_id)).toMatchObject([
      { model: MODEL, outcome: "model_unavailable" },
      { model: FALLBACK, outcome: "model_unavailable" },
    ]);
  });

  it("doesn't rerun a run in which a tool call ran", async () => {
    const { base, requests } = await listen({ script: [callResponse(), unavailable()] });
    const sent = await send(base, EMAIL);
    await queue.idle();
    expect(requests).toHaveLength(2);
    expect(await runsOf(base, sent.thread_id)).toMatchObject([{ outcome: "model_unavailable" }]);
    expect(await runsOf(base, sent.thread_id)).toHaveLength(1);
  });

  it("doesn't rerun without a fallback, or when it's the model that failed", async () => {
    for (const fallbackModel of [null, MODEL]) {
      const { base, requests } = await listen({ script: [unavailable()], fallbackModel });
      const sent = await send(base);
      await queue.idle();
      expect(requests).toHaveLength(1);
      expect(await runsOf(base, sent.thread_id)).toHaveLength(1);
    }
  });

  it("doesn't rerun other failures", async () => {
    const { base, requests } = await listen({
      script: [new ApiError({ status: 400, message: "Input blocked" })],
    });
    const sent = await send(base);
    await queue.idle();
    expect(requests).toHaveLength(1);
    expect(await runsOf(base, sent.thread_id)).toMatchObject([{ outcome: "model_error" }]);
  });
});

describe("no model key", () => {
  it("ends runs not_run not_configured", async () => {
    const { base, requests } = await listen({ script: [], withModel: false });
    const sent = await send(base);
    await queue.idle();
    expect(requests).toHaveLength(0);
    expect(await runsOf(base, sent.thread_id)).toMatchObject([
      { status: "not_run", outcome: "not_configured" },
    ]);
  });
});
