import {
  createRun,
  createTestDatabase,
  type DatabaseHandle,
  finishRun,
  type NewRun,
  readRun,
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
import type { TransportFactory } from "../src/baseline";
import {
  createModeRunner,
  createSuppliedTokens,
  type SuppliedToken,
  type SuppliedTokens,
} from "../src/queue";

// Supplied baseline tokens (ADR 0043, 0044): a token handed to a baseline run is used for that
// run's connection, and its one fallback rerun's, and is gone once the run starts. Through the
// mode runner with PGlite, a scripted model and a fake transport. People are illustrative;
// messages are simulated; the token is a made-up string.

const MODEL = "gemini-3.5-flash-lite";
const FALLBACK = "gemini-3.1-flash-lite";
const TOKEN = "illustrative-supplied-token-7f3a";
const TICKET = "tkt_00000000000000000000000000000001";

let handle: DatabaseHandle;
let now: Date;
const clock = () => now;

beforeEach(async () => {
  handle = await createTestDatabase();
  now = new Date("2026-10-20T08:00:00Z");
  await writeTicket(handle.db, {
    id: TICKET,
    channel: "email",
    senderEmail: "amina.k@example.com",
    senderPhone: null,
    subject: "Coaster set KIK-1035",
    body: "My coaster set hasn't arrived.",
    attachments: [],
    receivedAt: now.toISOString(),
    simulated: true,
    threadId: TICKET,
  });
});

afterEach(async () => {
  await handle.close();
});

const textResponse = (text: string) =>
  ({
    candidates: [{ content: { role: "model", parts: [{ text }] }, finishReason: "STOP" }],
    modelVersion: "v1",
  }) as unknown as GenerateContentResponse;

const unavailable = () => new ApiError({ status: 503, message: "{}" });

const queueRun = async (id: string, mode: "baseline" | "protected" = "baseline") => {
  await createRun(handle.db, {
    id,
    ticketId: TICKET,
    threadId: TICKET,
    mode,
    model: MODEL,
    queuedAt: now.toISOString(),
  } as NewRun);
};

const token = (lifeMs: number): SuppliedToken => ({
  accessToken: TOKEN,
  expiresAt: now.getTime() + lifeMs,
});

function runner(script: (GenerateContentResponse | Error)[], suppliedTokens: SuppliedTokens) {
  const requests: GenerateContentParameters[] = [];
  const connected: string[] = [];
  const minted: string[] = [];
  const logs: string[] = [];
  const steps = [...script];
  const transport: TransportFactory = (server) => {
    connected.push(server.env.PAYPAL_ACCESS_TOKEN ?? "");
    const mcp = new Server({ name: "paypal", version: "1.8.1" }, { capabilities: { tools: {} } });
    mcp.setRequestHandler(ListToolsRequestSchema, () => ({ tools: [] }));
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    void mcp.connect(serverSide);
    return clientSide;
  };
  const run = createModeRunner({
    db: handle.db,
    generateContent: async (request) => {
      requests.push(request);
      const next = steps.shift();
      if (next === undefined) throw new Error("The script ran out.");
      if (next instanceof Error) throw next;
      return next;
    },
    protectedEnv: { gateUrl: null, key: null },
    issueToken: async () => {
      minted.push("minted");
      return { accessToken: "illustrative-minted-token", expiresAt: now.getTime() + 3_600_000 };
    },
    createTransport: transport,
    clock,
    fallbackModel: FALLBACK,
    suppliedTokens,
    log: (line) => logs.push(line),
  });
  return { run, requests, connected, minted, logs };
}

describe("createSuppliedTokens", () => {
  it("returns a held token once, then nothing", () => {
    const tokens = createSuppliedTokens();
    tokens.hold("run_a", token(600_000));
    expect(tokens.take("run_b")).toBeUndefined();
    expect(tokens.take("run_a")).toEqual(token(600_000));
    expect(tokens.take("run_a")).toBeUndefined();
  });
});

describe("a supplied baseline token", () => {
  it("reaches that run's connection, is gone afterwards, and is stored or logged nowhere", async () => {
    const tokens = createSuppliedTokens();
    const { run, connected, minted, logs } = runner([textResponse("Sorry to hear that.")], tokens);
    await queueRun("run_one");
    tokens.hold("run_one", token(600_000));

    expect(await run("run_one")).toBeUndefined();

    expect(connected).toEqual([TOKEN]);
    expect(minted).toEqual([]);
    expect(tokens.take("run_one")).toBeUndefined();
    const stored = await readRun(handle.db, "run_one");
    expect(stored?.mode).toBe("baseline");
    expect(stored?.outcome).not.toBe("baseline_unavailable");
    expect(JSON.stringify(stored)).not.toContain(TOKEN);
    expect(logs.join("\n")).not.toContain(TOKEN);
  });

  it("is dropped by a run that isn't queued, with no connection", async () => {
    const tokens = createSuppliedTokens();
    const { run, connected, requests } = runner([], tokens);
    await queueRun("run_done");
    await finishRun(handle.db, "run_done", {
      status: "replied",
      outcome: "replied",
      reply: "Done.",
      modelVersions: [],
      trace: null,
      finishedAt: now.toISOString(),
    });
    tokens.hold("run_done", token(600_000));

    expect(await run("run_done")).toBeUndefined();

    expect(tokens.take("run_done")).toBeUndefined();
    expect(connected).toEqual([]);
    expect(requests).toEqual([]);
  });

  it("is dropped when the run doesn't exist", async () => {
    const tokens = createSuppliedTokens();
    const { run } = runner([], tokens);
    tokens.hold("run_missing", token(600_000));
    await run("run_missing");
    expect(tokens.take("run_missing")).toBeUndefined();
  });

  it("with 60 seconds or less left fails baseline_unavailable with no model call", async () => {
    for (const lifeMs of [60_000, 1_000, -5_000]) {
      const tokens = createSuppliedTokens();
      const { run, connected, minted, requests } = runner([textResponse("Hi.")], tokens);
      const id = `run_old_${lifeMs < 0 ? "past" : lifeMs}`;
      await queueRun(id);
      tokens.hold(id, token(lifeMs));

      expect(await run(id)).toBeUndefined();

      const stored = await readRun(handle.db, id);
      expect(stored?.status).toBe("failed");
      expect(stored?.outcome).toBe("baseline_unavailable");
      expect(requests).toEqual([]);
      expect(connected).toEqual([]);
      expect(minted).toEqual([]);
      expect(tokens.take(id)).toBeUndefined();
    }
  });

  it("is checked when the run starts, not when it was queued", async () => {
    const tokens = createSuppliedTokens();
    const { run, requests } = runner([textResponse("Hi.")], tokens);
    await queueRun("run_late");
    tokens.hold("run_late", token(120_000));
    now = new Date(now.getTime() + 61_000);

    await run("run_late");

    expect((await readRun(handle.db, "run_late"))?.outcome).toBe("baseline_unavailable");
    expect(requests).toEqual([]);
  });

  it("passes to a model_unavailable run's one rerun, and the rerun's rerun gets none", async () => {
    const tokens = createSuppliedTokens();
    const { run, connected, minted } = runner([unavailable(), unavailable()], tokens);
    await queueRun("run_first");
    tokens.hold("run_first", token(600_000));

    const rerunId = await run("run_first");
    expect(typeof rerunId).toBe("string");
    expect((await readRun(handle.db, "run_first"))?.outcome).toBe("model_unavailable");

    const rerunOfRerun = await run(rerunId as string);
    expect(rerunOfRerun).toBeUndefined();
    const rerun = await readRun(handle.db, rerunId as string);
    expect(rerun?.model).toBe(FALLBACK);
    expect(rerun?.outcome).toBe("model_unavailable");

    expect(connected).toEqual([TOKEN, TOKEN]);
    expect(minted).toEqual([]);
    expect(tokens.take(rerunId as string)).toBeUndefined();
  });

  it("isn't needed: a baseline run without one mints its own", async () => {
    const tokens = createSuppliedTokens();
    const { run, connected, minted } = runner([textResponse("Hi.")], tokens);
    await queueRun("run_mint");

    await run("run_mint");

    expect(minted).toEqual(["minted"]);
    expect(connected).toEqual(["illustrative-minted-token"]);
  });
});
