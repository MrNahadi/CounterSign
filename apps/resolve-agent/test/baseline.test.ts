import { existsSync, readdirSync, readFileSync } from "node:fs";
import type { Server as HttpServer } from "node:http";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  auditLog,
  createRun,
  createTestDatabase,
  type DatabaseHandle,
  seedOrders,
  writeTicket,
} from "@countersign/db";
import { createApp } from "@countersign/gate/src/app";
import { createFakeSandbox } from "@countersign/gate/test/fake-sandbox";
import type {
  Content,
  Tool as GeminiTool,
  GenerateContentConfig,
  GenerateContentParameters,
  GenerateContentResponse,
  Part,
} from "@google/genai";
import { getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type BaselineServer,
  runBaseline,
  type TokenIssuer,
  type TransportFactory,
} from "../src/baseline";
import type { ToolStep } from "../src/harness";
import { parseProtectedEnv, runProtected } from "../src/protected";
import type { RunTrace } from "../src/runs";

// Baseline mode with an injected token issuer and transport factory: a small in-process server
// stands in for PayPal's, so nothing is spawned and no sandbox is reached. Illustrative orders
// and people; a made-up token; simulated messages.

const SLOW = 60_000;
const NOW = new Date("2026-10-20T09:00:00Z");
const MODEL = "gemini-3.5-flash-lite";
const PAYER = "payer.1035@example.com";
const TICKET = "tkt_beat4";
const TOKEN = "A21AA-illustrative-sandbox-token-0123456789";
const KEY = "test-support-agent-key-0123456789abcdef";

const PAYPAL_TOOLS: Tool[] = [
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
];

let handle: DatabaseHandle;
let spawned: BaselineServer[];
let closes: number;
let paypalCalls: string[];
let httpServers: HttpServer[];

// Stands in for spawning PayPal's server: records how the child would start, and counts closes.
const fakeTransport: TransportFactory = (server) => {
  spawned.push(server);
  const mcp = new Server({ name: "paypal", version: "1.8.1" }, { capabilities: { tools: {} } });
  mcp.setRequestHandler(ListToolsRequestSchema, () => ({ tools: PAYPAL_TOOLS }));
  mcp.setRequestHandler(CallToolRequestSchema, (request) => {
    paypalCalls.push(request.params.name);
    return {
      content: [{ type: "text", text: "done" }],
      structuredContent: { id: "REF1", status: "COMPLETED" },
    };
  });
  // The server's side closes once when Resolve closes its end: the child is gone.
  mcp.onclose = () => {
    closes++;
  };
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  void mcp.connect(serverSide);
  return clientSide;
};

const issuer: TokenIssuer = async () => ({ accessToken: TOKEN, expiresAt: 0 });

beforeEach(async () => {
  handle = await createTestDatabase();
  spawned = [];
  closes = 0;
  paypalCalls = [];
  httpServers = [];
  await handle.db.insert(seedOrders).values({
    orderNumber: "KIK-1035",
    runId: "run1",
    paypalOrderId: "ORD1035",
    paypalCaptureId: "CAP1035",
    amountMinor: 1800,
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
    subject: "Coaster set KIK-1035",
    body: "My coaster set, order KIK-1035, hasn't arrived. The tracking hasn't moved in ten days.",
    attachments: [],
    receivedAt: "2026-10-20T08:00:00Z",
    simulated: true,
  });
});

afterEach(async () => {
  for (const server of httpServers) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  await handle.close();
});

// ---- The scripted model ----

function answer(parts: Part[]): GenerateContentResponse {
  return {
    candidates: [{ content: { role: "model", parts }, finishReason: "STOP" }],
    modelVersion: "gemini-3.5-flash-lite-001",
    responseId: "resp",
    usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 20 },
  } as never;
}

const call = (name: string, args: Record<string, unknown>, id: string): Part => ({
  functionCall: { id, name, args },
});

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

const FIND_THEN_REPLY = () => [
  answer([call("find_order", { order_number: "KIK-1035" }, "c1")]),
  answer([{ text: "I've looked into KIK-1035 and it's on its way." }]),
];

let runCount = 0;
async function queue(mode: "protected" | "baseline"): Promise<string> {
  runCount++;
  const id = `run_${mode}_${runCount}`;
  await createRun(handle.db, {
    id,
    ticketId: TICKET,
    threadId: TICKET,
    mode,
    model: MODEL,
    queuedAt: NOW.toISOString(),
  });
  return id;
}

const baseline = async (
  generateContent: (request: GenerateContentParameters) => Promise<GenerateContentResponse>,
  overrides: { issueToken?: TokenIssuer; createTransport?: TransportFactory } = {},
) =>
  runBaseline({
    db: handle.db,
    runId: await queue("baseline"),
    generateContent,
    clock: () => NOW,
    issueToken: overrides.issueToken ?? issuer,
    createTransport: overrides.createTransport ?? fakeTransport,
  });

// ---- The child process ----

describe("starting PayPal's server", () => {
  it("runs Node on @paypal/mcp's entry point from the baseline workspace, with every tool, the token in env and stderr ignored", async () => {
    const { generateContent } = scripted(FIND_THEN_REPLY());
    await baseline(generateContent);

    const workspace = createRequire(import.meta.url).resolve(
      "@countersign/baseline-paypal-mcp/package.json",
    );
    const manifest = createRequire(workspace).resolve("@paypal/mcp/package.json");
    const entry = join(dirname(manifest), "dist/index.js");
    expect(existsSync(entry)).toBe(true);

    expect(spawned).toEqual([
      {
        command: process.execPath,
        args: [entry, "--tools=all"],
        env: {
          ...getDefaultEnvironment(),
          PAYPAL_ACCESS_TOKEN: TOKEN,
          PAYPAL_ENVIRONMENT: "SANDBOX",
        },
        stderr: "ignore",
      },
    ]);
  });

  it("mints a fresh token for each run", async () => {
    let minted = 0;
    const counting: TokenIssuer = async () => {
      minted++;
      return { accessToken: `${TOKEN}-${minted}`, expiresAt: 0 };
    };
    await baseline(scripted(FIND_THEN_REPLY()).generateContent, { issueToken: counting });
    await baseline(scripted(FIND_THEN_REPLY()).generateContent, { issueToken: counting });
    expect(spawned.map((server) => server.env.PAYPAL_ACCESS_TOKEN)).toEqual([
      `${TOKEN}-1`,
      `${TOKEN}-2`,
    ]);
  });
});

describe("closing the child", () => {
  it("closes it after a replied run", async () => {
    const run = await baseline(scripted(FIND_THEN_REPLY()).generateContent);
    expect(run).toMatchObject({ status: "replied", mode: "baseline" });
    expect(closes).toBe(1);
  });

  it("closes it after a stopped run", async () => {
    const run = await baseline(
      scripted([answer([call("delete_everything", {}, "c1")])]).generateContent,
    );
    expect(run).toMatchObject({ status: "stopped", outcome: "unknown_tool" });
    expect(closes).toBe(1);
  });

  it("closes it after a failed run", async () => {
    const run = await baseline(async () => {
      throw new Error("fetch failed");
    });
    expect(run).toMatchObject({ status: "failed", outcome: "model_error" });
    expect(closes).toBe(1);
  });
});

describe("when baseline can't start", () => {
  const cases: [string, { issueToken?: TokenIssuer; createTransport?: TransportFactory }][] = [
    [
      "no token",
      {
        issueToken: async () => {
          throw new Error(`OAuth refused ${TOKEN}`);
        },
      },
    ],
    [
      "a spawn that throws",
      {
        createTransport: () => {
          throw new Error("spawn ENOENT");
        },
      },
    ],
    [
      "a child that won't start",
      {
        createTransport: (server) => {
          spawned.push(server);
          const [clientSide] = InMemoryTransport.createLinkedPair();
          clientSide.start = async () => {
            throw new Error("spawn EACCES");
          };
          return clientSide;
        },
      },
    ],
  ];

  it.each(cases)(
    "ends failed baseline_unavailable with no model call for %s",
    async (_, overrides) => {
      const { generateContent, requests } = scripted(FIND_THEN_REPLY());
      const run = await baseline(generateContent, overrides);
      expect(run).toMatchObject({
        status: "failed",
        outcome: "baseline_unavailable",
        reply: null,
        modelVersions: [],
        trace: { mode: "baseline", tools: [], rewrites: [], steps: [] },
      });
      expect(requests).toHaveLength(0);
      expect(JSON.stringify(run)).not.toContain(TOKEN);
    },
  );
});

// ---- The same agent in both modes ----

async function listenGate(): Promise<string> {
  const server = createApp({
    db: handle.db,
    rail: () => createFakeSandbox(),
    env: { COUNTERSIGN_SUPPORT_AGENT_KEY: KEY },
    clock: () => NOW,
  }).listen(0, "127.0.0.1");
  httpServers.push(server);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}/mcp`;
}

const withoutTools = (config: GenerateContentConfig | undefined) => {
  const { tools: _tools, ...rest } = config ?? {};
  return JSON.stringify(rest);
};
const declared = (request: GenerateContentParameters) =>
  ((request.config?.tools ?? []) as GeminiTool[]).flatMap((tool) =>
    (tool.functionDeclarations ?? []).map((declaration) => declaration.name),
  );

describe("protected and baseline send the same agent", { timeout: SLOW }, () => {
  it("sends byte-identical system instructions, configs and user turns, and both declare find_order", async () => {
    const gateUrl = await listenGate();
    const prot = scripted(FIND_THEN_REPLY());
    const protectedRun = await runProtected({
      db: handle.db,
      runId: await queue("protected"),
      env: parseProtectedEnv({ COUNTERSIGN_SUPPORT_AGENT_KEY: KEY, GATE_MCP_URL: gateUrl }),
      generateContent: prot.generateContent,
      clock: () => NOW,
    });
    const base = scripted(FIND_THEN_REPLY());
    const baselineRun = await baseline(base.generateContent);

    expect(protectedRun.status).toBe("replied");
    expect(baselineRun.status).toBe("replied");
    expect(prot.requests).toHaveLength(2);
    expect(base.requests).toHaveLength(2);
    for (const [i, request] of base.requests.entries()) {
      const other = prot.requests[i] as GenerateContentParameters;
      expect(request.model).toBe(other.model);
      expect(JSON.stringify(request.config?.systemInstruction)).toBe(
        JSON.stringify(other.config?.systemInstruction),
      );
      expect(withoutTools(request.config)).toBe(withoutTools(other.config));
      expect(JSON.stringify(base.snapshots[i])).toBe(JSON.stringify(prot.snapshots[i]));
      expect(declared(request)).toContain("find_order");
      expect(declared(other)).toContain("find_order");
    }
    // The servers differ, so the rest of the declarations do: that's the comparison.
    expect(declared(base.requests[0] as GenerateContentParameters)).not.toEqual(
      declared(prot.requests[0] as GenerateContentParameters),
    );
  });
});

// ---- No audit, marked baseline ----

describe("what a baseline run leaves behind", () => {
  it("appends nothing to the audit log, and is stored and traced as baseline", async () => {
    const { generateContent } = scripted([
      answer([call("create_refund", { capture_id: "CAP1035" }, "c1")]),
      answer([{ text: "I've refunded your order." }]),
    ]);
    const run = await baseline(generateContent);

    expect(paypalCalls).toEqual(["create_refund"]);
    expect(run).toMatchObject({ status: "replied", mode: "baseline" });
    const trace = run.trace as RunTrace;
    expect(trace.mode).toBe("baseline");
    const tools = trace.steps.filter((step): step is ToolStep => step.kind === "tool");
    expect(tools.map((step) => step.name)).toEqual(["create_refund"]);
    expect(await handle.db.select().from(auditLog)).toHaveLength(0);
    expect(JSON.stringify(run)).not.toContain(TOKEN);
  });
});

// ---- Only the baseline workspace touches PayPal's packages ----

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const SKIP = new Set(["node_modules", ".git", ".next", "dist", "coverage"]);
const CODE = /\.(?:[cm]?[jt]sx?)$/;
const PAYPAL_IMPORT =
  /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|\bimport\s+)["']@paypal\/(?:mcp|agent-toolkit)(?:\/[^"']*)?["']/;

function codeFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...codeFiles(path));
    else if (CODE.test(entry.name)) found.push(path);
  }
  return found;
}

describe("PayPal's packages stay in their workspace", () => {
  it("recognises an import of either package", () => {
    // Built from parts so this file doesn't match its own scan.
    const at = (name: string) => `@paypal/${name}`;
    expect(PAYPAL_IMPORT.test(`import { x } from "${at("mcp")}";`)).toBe(true);
    expect(PAYPAL_IMPORT.test(`await import('${at("agent-toolkit/mcp")}')`)).toBe(true);
    expect(PAYPAL_IMPORT.test(`require("${at("agent-toolkit")}")`)).toBe(true);
    expect(PAYPAL_IMPORT.test(`import "${at("mcp")}";`)).toBe(true);
    expect(PAYPAL_IMPORT.test(`import { x } from "${at("paypal-js")}";`)).toBe(false);
  });

  it("finds no import of @paypal/mcp or @paypal/agent-toolkit outside apps/baseline-paypal-mcp", () => {
    const baselineWorkspace = join(ROOT, "apps", "baseline-paypal-mcp") + sep;
    const files = codeFiles(ROOT).filter((path) => !path.startsWith(baselineWorkspace));
    expect(files.map((path) => relative(ROOT, path))).toContain(
      join("apps", "resolve-agent", "src", "baseline.ts"),
    );
    const offenders = files
      .filter((path) => PAYPAL_IMPORT.test(readFileSync(path, "utf8")))
      .map((path) => relative(ROOT, path));
    expect(offenders).toEqual([]);
  });
});
