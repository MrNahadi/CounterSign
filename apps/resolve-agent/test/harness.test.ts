import {
  createRun,
  createTestDatabase,
  type DatabaseHandle,
  finishRun,
  seedOrders,
  startRun,
  writeAttachment,
  writeTicket,
} from "@countersign/db";
import type {
  Content,
  Tool as GeminiTool,
  GenerateContentParameters,
  GenerateContentResponse,
  Part,
} from "@google/genai";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  type CallToolResult,
  ListToolsRequestSchema,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findOrder, type HarnessResult, NO_ORDER, runHarness, type ToolStep } from "../src/harness";
import { SYSTEM_INSTRUCTION } from "../src/model";

// The loop against a scripted model and a small in-process MCP server, over PGlite.

const PAYER = "payer.1035@example.com";
const TICKET = "tkt_beat4";
const PHOTO = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);

const SERVER_TOOLS: Tool[] = [
  {
    name: "get_order",
    description: "Read a PayPal order.",
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
  },
  {
    name: "create_refund",
    description: "Refund a capture.",
    inputSchema: {
      type: "object",
      properties: { capture_id: { type: "string" } },
      required: ["capture_id"],
    },
  },
  {
    name: "alpha_tool",
    description: "Has a $schema to strip.",
    inputSchema: {
      $schema: "http://json-schema.org/draft-07/schema#",
      type: "object",
      properties: {},
    },
  },
];

type Call = { name: string; args: unknown };

let handle: DatabaseHandle;
let client: Client;
let serverCalls: Call[];
let listPages: number;

async function connect(results: Record<string, (args: unknown) => CallToolResult>) {
  const server = new Server({ name: "test", version: "1.0.0" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, (request) => {
    listPages++;
    const start = Number(request.params?.cursor ?? 0);
    const page = SERVER_TOOLS.slice(start, start + 2);
    const next = start + 2 < SERVER_TOOLS.length ? String(start + 2) : undefined;
    return next === undefined ? { tools: page } : { tools: page, nextCursor: next };
  });
  server.setRequestHandler(CallToolRequestSchema, (request) => {
    serverCalls.push({ name: request.params.name, args: request.params.arguments });
    const result = results[request.params.name];
    return result
      ? result(request.params.arguments)
      : { content: [{ type: "text", text: "unexpected" }], isError: true };
  });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  client = new Client({ name: "resolve-test", version: "1.0.0" });
  await client.connect(clientSide);
}

const DEFAULT_RESULTS: Record<string, (args: unknown) => CallToolResult> = {
  get_order: () => ({
    content: [{ type: "text", text: "Order" }],
    structuredContent: { id: "ORD1035", status: "COMPLETED" },
  }),
  create_refund: () => ({
    content: [
      { type: "text", text: "Refund refused." },
      { type: "text", text: "Ask the merchant." },
    ],
    isError: true,
  }),
  alpha_tool: () => ({
    content: [
      { type: "text", text: "line one" },
      { type: "text", text: "two" },
    ],
  }),
};

beforeEach(async () => {
  handle = await createTestDatabase();
  serverCalls = [];
  listPages = 0;
  await handle.db.insert(seedOrders).values({
    orderNumber: "KIK-1035",
    runId: "run1",
    paypalOrderId: "ORD1035",
    paypalCaptureId: "CAP1035",
    amountMinor: 4800,
    currency: "USD",
    payerEmail: PAYER,
    buyer: "A",
    trackingNumber: "KC-run1-1035",
    role: "demo",
    seededAt: "2026-10-01T08:00:00Z",
  });
  await writeTicket(handle.db, {
    id: TICKET,
    channel: "email",
    senderEmail: PAYER,
    senderPhone: null,
    subject: "Parcel stuck",
    body: "My parcel for KIK-1035 hasn't moved in ten days.",
    attachments: [],
    receivedAt: "2026-10-20T09:00:00Z",
    simulated: true,
  });
  await connect(DEFAULT_RESULTS);
});

afterEach(async () => {
  await client.close();
  await handle.close();
});

// ---- The scripted model ----

const usage = {
  promptTokenCount: 100,
  candidatesTokenCount: 20,
  thoughtsTokenCount: 30,
  cachedContentTokenCount: 0,
};

let responseCount = 0;
function answer(parts: Part[], fields: Record<string, unknown> = {}): GenerateContentResponse {
  responseCount++;
  return {
    candidates: [{ content: { role: "model", parts }, finishReason: "STOP" }],
    modelVersion: "gemini-3.5-flash-lite-001",
    responseId: `resp-${responseCount}`,
    usageMetadata: usage,
    ...fields,
  } as never;
}

const call = (name: string, args: Record<string, unknown>, id?: string): Part => ({
  functionCall: { ...(id === undefined ? {} : { id }), name, args },
});
const text = (value: string): Part => ({ text: value });

function scripted(steps: GenerateContentResponse[]) {
  const requests: GenerateContentParameters[] = [];
  const snapshots: Content[][] = [];
  const generateContent = async (request: GenerateContentParameters) => {
    requests.push(request);
    snapshots.push(structuredClone(request.contents as Content[]));
    const next = steps[requests.length - 1];
    if (!next) throw new Error("The script ran out.");
    return next;
  };
  return { generateContent, requests, snapshots };
}

// A clock that moves 5 ms per read, so latencies are known.
function ticking() {
  let t = 0;
  return () => {
    t += 5;
    return t;
  };
}

const run = (
  generateContent: (request: GenerateContentParameters) => Promise<GenerateContentResponse>,
  ticketId = TICKET,
  threadId = TICKET,
): Promise<HarnessResult> =>
  runHarness({
    db: handle.db,
    client,
    generateContent,
    model: "gemini-3.5-flash-lite",
    ticketId,
    threadId,
    now: ticking(),
  });

const toolSteps = (result: HarnessResult) =>
  result.trace.steps.filter((step): step is ToolStep => step.kind === "tool");

// ---- Tools and the user turn ----

describe("tools and the user turn", () => {
  it("lists every page, adds find_order, sorts and sanitizes once, and sends the same declarations each step", async () => {
    const model = scripted([
      answer([call("find_order", { order_number: "KIK-1035" }, "c1")]),
      answer([text("Your parcel is on its way.")]),
    ]);
    const result = await run(model.generateContent);
    expect(listPages).toBe(2);
    const tool = model.requests[0]?.config?.tools?.[0] as GeminiTool | undefined;
    const declarations = tool?.functionDeclarations ?? [];
    expect(declarations.map((d) => d.name)).toEqual([
      "alpha_tool",
      "create_refund",
      "find_order",
      "get_order",
    ]);
    expect(declarations[0]?.parametersJsonSchema).toEqual({ type: "object", properties: {} });
    expect(model.requests[1]?.config?.tools).toEqual(model.requests[0]?.config?.tools);
    expect(model.requests[0]?.config?.systemInstruction).toBe(SYSTEM_INSTRUCTION);
    expect(result.trace.tools).toEqual(declarations.map((d) => d.name));
    expect(result.trace.rewrites).toEqual([
      expect.objectContaining({ tool: "alpha_tool", rule: expect.any(String) }),
    ]);
  });

  it("renders the thread, then the ticket's header, body and photos as inline image parts", async () => {
    await createRun(handle.db, {
      id: "run_1",
      ticketId: TICKET,
      threadId: TICKET,
      mode: "protected",
      model: "gemini-3.5-flash-lite",
      queuedAt: "2026-10-20T09:00:01Z",
    });
    await startRun(handle.db, "run_1", "2026-10-20T09:00:02Z");
    await finishRun(handle.db, "run_1", {
      status: "replied",
      outcome: "replied",
      reply: "I've checked: it's with the carrier.",
      modelVersions: ["gemini-3.5-flash-lite-001"],
      trace: null,
      finishedAt: "2026-10-20T09:00:30Z",
    });
    await writeAttachment(handle.db, {
      id: "att_1",
      ticketId: "tkt_follow",
      contentType: "image/jpeg",
      bytes: PHOTO,
    });
    await writeTicket(handle.db, {
      id: "tkt_follow",
      channel: "email",
      senderEmail: PAYER,
      senderPhone: null,
      subject: "Still stuck",
      body: "Here's a photo of the tracking page.",
      attachments: [{ id: "att_1", contentType: "image/jpeg" }],
      receivedAt: "2026-10-21T09:00:00Z",
      simulated: true,
      threadId: TICKET,
    });
    const model = scripted([answer([text("Thanks for the photo.")])]);
    await run(model.generateContent, "tkt_follow", TICKET);
    const turn = model.snapshots[0]?.[0];
    expect(turn?.role).toBe("user");
    const rendered = turn?.parts?.[0]?.text ?? "";
    const order = [
      "My parcel for KIK-1035 hasn't moved in ten days.",
      "I've checked: it's with the carrier.",
      "Ticket ID: tkt_follow",
      "Channel: email",
      `From: ${PAYER}`,
      "Subject: Still stuck",
      "Received: 2026-10-21T09:00:00Z",
      "Here's a photo of the tracking page.",
    ].map((piece) => rendered.indexOf(piece));
    expect(order.every((at) => at >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(turn?.parts?.[1]).toEqual({
      inlineData: { mimeType: "image/jpeg", data: Buffer.from(PHOTO).toString("base64") },
    });
    expect(turn?.parts).toHaveLength(2);
  });
});

// ---- Calls and results ----

describe("calls and results", () => {
  it("runs calls in order and returns one functionResponse turn, keeping the model's content unchanged", async () => {
    const first = answer([
      { ...call("find_order", { order_number: "KIK-1035" }, "c1"), thoughtSignature: "sig-1" },
      call("get_order", { id: "ORD1035" }, "c2"),
      call("create_refund", { capture_id: "CAP1035" }),
      call("alpha_tool", {}, "c4"),
    ]);
    const model = scripted([first, answer([text("  I've looked into it.  ")])]);
    const result = await run(model.generateContent);

    expect(result).toMatchObject({
      status: "replied",
      outcome: "replied",
      reply: "I've looked into it.",
    });
    expect(serverCalls.map((c) => c.name)).toEqual(["get_order", "create_refund", "alpha_tool"]);
    // The live array keeps growing after the call, so its length is read from the snapshot.
    expect(model.snapshots[1]).toHaveLength(3);
    const history = model.requests[1]?.contents as Content[];
    expect(history[1]).toBe(first.candidates?.[0]?.content);
    expect(history[1]?.parts?.[0]?.thoughtSignature).toBe("sig-1");
    expect(history[2]).toEqual({
      role: "user",
      parts: [
        {
          functionResponse: {
            id: "c1",
            name: "find_order",
            response: {
              output: {
                order_number: "KIK-1035",
                paypal_order_id: "ORD1035",
                capture_id: "CAP1035",
                amount: { value: "48.00", currency_code: "USD" },
                tracking_number: "KC-run1-1035",
              },
            },
          },
        },
        {
          functionResponse: {
            id: "c2",
            name: "get_order",
            response: { output: { id: "ORD1035", status: "COMPLETED" } },
          },
        },
        {
          functionResponse: {
            id: "local_1_3",
            name: "create_refund",
            response: { error: "Refund refused.\nAsk the merchant." },
          },
        },
        {
          functionResponse: { id: "c4", name: "alpha_tool", response: { output: "line one\ntwo" } },
        },
      ],
    });
    expect(result.toolCallCount).toBe(4);
  });

  it("sends empty arguments when a call has none", async () => {
    const model = scripted([
      answer([{ functionCall: { id: "c1", name: "alpha_tool" } }]),
      answer([text("Done.")]),
    ]);
    await run(model.generateContent);
    expect(serverCalls).toEqual([{ name: "alpha_tool", args: {} }]);
  });
});

// ---- Ending the run ----

describe("ending the run", () => {
  it("stops on an undeclared tool without running any call in that response", async () => {
    const model = scripted([
      answer([call("get_order", { id: "ORD1035" }, "c1"), call("delete_everything", {}, "c2")]),
    ]);
    const result = await run(model.generateContent);
    expect(result).toMatchObject({ status: "stopped", outcome: "unknown_tool", reply: null });
    expect(serverCalls).toEqual([]);
    expect(model.requests).toHaveLength(1);
  });

  it("fails on a transport failure and makes no further call", async () => {
    let closed = false;
    const generateContent = async () => {
      if (!closed) {
        closed = true;
        await client.close();
        return answer([call("get_order", { id: "ORD1035" }, "c1"), call("alpha_tool", {}, "c2")]);
      }
      throw new Error("No second model call expected.");
    };
    const result = await run(generateContent);
    expect(result).toMatchObject({
      status: "failed",
      outcome: "tool_transport_failed",
      reply: null,
    });
    expect(toolSteps(result)).toEqual([
      expect.objectContaining({ id: "c1", name: "get_order", result: null }),
    ]);
  });

  it("stops after 8 model calls", async () => {
    const steps = Array.from({ length: 9 }, (_, i) =>
      answer([call("find_order", { order_number: "KIK-1035" }, `c${i}`)]),
    );
    const model = scripted(steps);
    const result = await run(model.generateContent);
    expect(result).toMatchObject({ status: "stopped", outcome: "step_cap", reply: null });
    expect(model.requests).toHaveLength(8);
    expect(result.toolCallCount).toBe(8);
  });

  it("stops before a 13th tool call", async () => {
    const batch = (from: number, n: number) =>
      answer(
        Array.from({ length: n }, (_, i) =>
          call("get_order", { id: `O${from + i}` }, `c${from + i}`),
        ),
      );
    const model = scripted([batch(0, 5), batch(5, 5), batch(10, 3)]);
    const result = await run(model.generateContent);
    expect(result).toMatchObject({ status: "stopped", outcome: "step_cap" });
    expect(serverCalls).toHaveLength(10);
    expect(model.requests).toHaveLength(3);
  });

  it("stops on a final response with no reply text", async () => {
    const model = scripted([answer([{ text: "thinking", thought: true }, text("   ")])]);
    const result = await run(model.generateContent);
    expect(result).toMatchObject({ status: "stopped", outcome: "empty_reply", reply: null });
  });

  it("runs none of the calls in a response that fails the check", async () => {
    const model = scripted([
      answer([call("get_order", { id: "ORD1035" }, "c1")], {
        candidates: [
          {
            content: { role: "model", parts: [call("get_order", { id: "ORD1035" }, "c1")] },
            finishReason: "MAX_TOKENS",
          },
        ],
      }),
    ]);
    const result = await run(model.generateContent);
    expect(result).toMatchObject({ status: "stopped", outcome: "model_stopped:MAX_TOKENS" });
    expect(serverCalls).toEqual([]);
    expect(result.trace.steps).toEqual([
      expect.objectContaining({
        kind: "model",
        finishReason: "MAX_TOKENS",
        outcome: "model_stopped:MAX_TOKENS",
      }),
    ]);
  });

  it("fails on a model error", async () => {
    const result = await run(async () => {
      throw new Error("fetch failed");
    });
    expect(result).toMatchObject({ status: "failed", outcome: "model_error", modelVersions: [] });
  });
});

// ---- find_order ----

describe("find_order", () => {
  it("answers a seeded order without the payer's email", async () => {
    const result = await findOrder(handle.db, { order_number: "KIK-1035" });
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toEqual({
      order_number: "KIK-1035",
      paypal_order_id: "ORD1035",
      capture_id: "CAP1035",
      amount: { value: "48.00", currency_code: "USD" },
      tracking_number: "KC-run1-1035",
    });
    expect(JSON.stringify(result)).not.toContain(PAYER);
  });

  it("answers no order for an unknown number, and an error for a malformed one", async () => {
    const model = scripted([
      answer([
        call("find_order", { order_number: "KIK-9999" }, "c1"),
        call("find_order", { order_number: "1035" }, "c2"),
        call("find_order", { order_number: "KIK-1035", email: "x" }, "c3"),
      ]),
      answer([text("I couldn't find that order.")]),
    ]);
    await run(model.generateContent);
    const turn = model.snapshots[1]?.[2];
    const responses = turn?.parts?.map((part) => part.functionResponse?.response);
    expect(responses?.[0]).toEqual({ error: NO_ORDER });
    expect(responses?.[1]).toEqual({ error: expect.stringContaining("KIK- and four digits") });
    expect(responses?.[2]).toEqual({ error: expect.stringContaining("KIK- and four digits") });
    expect(serverCalls).toEqual([]);
  });
});

// ---- The trace ----

describe("the trace", () => {
  it("holds every model call's and tool call's details", async () => {
    const model = scripted([
      answer([call("get_order", { id: "ORD1035" }, "c1")], {
        promptFeedback: { safetyRatings: [] },
      }),
      answer([text("All good.")], { modelVersion: "gemini-3.5-flash-lite-002" }),
    ]);
    const result = await run(model.generateContent);
    expect(result.modelVersions).toEqual([
      "gemini-3.5-flash-lite-001",
      "gemini-3.5-flash-lite-002",
    ]);
    expect(result.trace.steps).toEqual([
      {
        kind: "model",
        step: 1,
        model: "gemini-3.5-flash-lite",
        modelVersion: "gemini-3.5-flash-lite-001",
        responseId: expect.stringMatching(/^resp-/),
        finishReason: "STOP",
        promptFeedback: { safetyRatings: [] },
        usage: { prompt: 100, candidates: 20, thoughts: 30, cached: 0 },
        latencyMs: 5,
      },
      {
        kind: "tool",
        step: 1,
        id: "c1",
        name: "get_order",
        args: { id: "ORD1035" },
        result: {
          content: [{ type: "text", text: "Order" }],
          structuredContent: { id: "ORD1035", status: "COMPLETED" },
        },
        latencyMs: 5,
        local: false,
      },
      expect.objectContaining({
        kind: "model",
        step: 2,
        modelVersion: "gemini-3.5-flash-lite-002",
        promptFeedback: null,
      }),
    ]);
  });
});
