import { spawnSync } from "node:child_process";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import type { Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createDatabaseShipmentStore } from "@countersign/carrier-mock";
import {
  auditLog,
  type DatabaseHandle,
  openPgliteDirectory,
  readThread,
  seedOrders,
} from "@countersign/db";
import { createApp } from "@countersign/gate/src/app";
import { createFakeSandbox, type FakeSandbox } from "@countersign/gate/test/fake-sandbox";
import { trackedTempDirs } from "@countersign/gate/test/temp-dirs";
import type { ShipmentStatus } from "@countersign/mandate";
import type { GenerateContentParameters, GenerateContentResponse, Part } from "@google/genai";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it } from "vitest";
import type { TokenIssuer, TransportFactory } from "../src/baseline";
import { sniffImageType } from "../src/messages";
import {
  EXIT_CANT_RUN,
  EXIT_NOT_REPLIED,
  EXIT_REPLIED,
  MessageFileSchema,
  RESOLVE_USAGE,
  runResolve,
} from "../src/resolve-cli";

// The resolve CLI through its run function: a listening gate (its fake sandbox and the carrier
// mock) sharing a PGlite directory with the CLI, and a scripted model. Plus one child-process
// run of the real entry point. Illustrative orders and people; made-up keys; simulated messages.

const SLOW = 60_000;
const NOW = new Date("2026-10-21T09:00:00Z");
const KEY = "test-support-agent-key-0123456789abcdef";
const GEMINI_KEY = "test-gemini-key-not-real-0123456789";
const TOKEN = "A21AA-illustrative-sandbox-token-0123456789";
const MODEL = "gemini-3.5-flash-lite";

const here = fileURLToPath(new URL(".", import.meta.url));
const scenarios = join(here, "..", "scenarios");
const repoRoot = join(here, "..", "..", "..");
const entry = join(here, "..", "src", "resolve-main.ts");
const scenario = (name: string) => join(scenarios, name);

const BUYER_EMAIL = { A: "amina.k@example.com", B: "grace.w@example.com" } as const;
const usd = (minor: number) => ({ minor, currency: "USD" as const });

type SeededOrder = { n: number; buyer: "A" | "B"; minor: number; status: ShipmentStatus };
const SEEDED: readonly SeededOrder[] = [
  { n: 1035, buyer: "A", minor: 1800, status: "stalled_10d" },
  { n: 1037, buyer: "A", minor: 24000, status: "delivered" },
  { n: 1038, buyer: "B", minor: 4800, status: "delivered" },
  { n: 1039, buyer: "B", minor: 3600, status: "delivered" },
  { n: 1040, buyer: "B", minor: 2400, status: "in_transit" },
  { n: 1041, buyer: "B", minor: 1800, status: "delivered" },
  { n: 1042, buyer: "A", minor: 4800, status: "delivered" },
];

const tempDir = trackedTempDirs();
let servers: HttpServer[] = [];
let handles: DatabaseHandle[] = [];

afterEach(async () => {
  for (const server of servers) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  for (const handle of handles) await handle.close().catch(() => {});
  servers = [];
  handles = [];
});

// A PGlite directory as `npm run seed` leaves it, and a fake sandbox holding the same orders.
async function seededWorld(
  only: readonly number[] = SEEDED.map((order) => order.n),
): Promise<{ handle: DatabaseHandle; rail: FakeSandbox; dir: string }> {
  const dir = tempDir("resolve-cli-");
  const handle = await openPgliteDirectory(dir);
  handles.push(handle);
  const rail = createFakeSandbox();
  const store = createDatabaseShipmentStore(handle.db);
  for (const { n, buyer, minor, status } of SEEDED.filter((order) => only.includes(order.n))) {
    const captureId = `CAP${n}`;
    const orderId = `ORD${n}`;
    const trackingNumber = `KC-run1-${n}`;
    const payerEmail = BUYER_EMAIL[buyer];
    await handle.db.insert(seedOrders).values({
      orderNumber: `KIK-${n}`,
      runId: "run1",
      paypalOrderId: orderId,
      paypalCaptureId: captureId,
      amountMinor: minor,
      currency: "USD",
      payerEmail,
      buyer,
      trackingNumber,
      role: "demo",
      seededAt: "2026-10-01T08:00:00Z",
    });
    await store.write({
      trackingNumber,
      carrierName: "Illustrative Post",
      status,
      scanEvents: [{ at: "2026-10-02T08:00:00Z", description: "Picked up", place: "Kisumu" }],
      updatedAt: "2026-10-05T08:00:00Z",
    });
    const capture = { id: captureId, status: "COMPLETED", amount: usd(minor), orderId };
    rail.captures.set(captureId, capture);
    rail.orders.set(orderId, {
      id: orderId,
      status: "COMPLETED",
      payerEmail,
      payerId: `PAYER${buyer}`,
      purchaseUnits: [
        {
          referenceId: `KIK-${n}`,
          customId: null,
          invoiceId: null,
          amount: usd(minor),
          captures: [capture],
          trackers: [
            { id: `${captureId}-${trackingNumber}`, captureId, trackingNumber, status: "SHIPPED" },
          ],
          refunds: [],
        },
      ],
    });
  }
  return { handle, rail, dir };
}

async function listenGate(handle: DatabaseHandle, rail: FakeSandbox): Promise<string> {
  const server = createApp({
    db: handle.db,
    rail: () => rail,
    env: { COUNTERSIGN_SUPPORT_AGENT_KEY: KEY },
    clock: () => NOW,
  }).listen(0, "127.0.0.1");
  servers.push(server);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}/mcp`;
}

// ---- The scripted model ----

function answer(parts: Part[], finishReason = "STOP"): GenerateContentResponse {
  return {
    candidates: [{ content: { role: "model", parts }, finishReason }],
    modelVersion: "gemini-3.5-flash-lite-001",
    responseId: "resp",
    usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 20 },
  } as never;
}

const call = (name: string, args: Record<string, unknown>, id: string): Part => ({
  functionCall: { id, name, args },
});

// The ticket being answered, from the user turn's header.
const ticketOf = (request: GenerateContentParameters): string => {
  const text = JSON.stringify(request.contents);
  const ids = [...text.matchAll(/Ticket ID: (tkt_[0-9a-f]{32})/g)].map((match) => match[1]);
  return ids.at(-1) as string;
};

type Step = (request: GenerateContentParameters) => GenerateContentResponse;

// Each run of the script starts again at its first step when a new ticket arrives.
function scripted(steps: Step[]) {
  const requests: GenerateContentParameters[] = [];
  let ticket = "";
  let at = 0;
  const generateContent = async (request: GenerateContentParameters) => {
    requests.push(structuredClone(request));
    const id = ticketOf(request);
    if (id !== ticket) {
      ticket = id;
      at = 0;
    }
    const step = steps[at++];
    if (!step) throw new Error("The script ran out.");
    return step(request);
  };
  return { generateContent, requests };
}

const refund = (n: number, value: string, ticketId: string, claim = "not_received") => ({
  capture_id: `CAP${n}`,
  amount: { value, currency_code: "USD" },
  justification: { ticket_id: ticketId, claim },
});

const ENV = { GEMINI_API_KEY: GEMINI_KEY, COUNTERSIGN_SUPPORT_AGENT_KEY: KEY };

const secretsIn = (text: string) =>
  [KEY, GEMINI_KEY, TOKEN, "Bearer"].filter((secret) => text.includes(secret));

describe("resolve CLI, protected mode against the real gate", { timeout: SLOW }, () => {
  it("runs beat 4: stores the simulated ticket, the gate allows one refund, and exits 0", async () => {
    const { handle, rail } = await seededWorld();
    const url = await listenGate(handle, rail);
    const model = scripted([
      () => answer([call("find_order", { order_number: "KIK-1035" }, "c1")]),
      (request) => answer([call("create_refund", refund(1035, "18.00", ticketOf(request)), "c2")]),
      () => answer([{ text: "Your refund of $18.00 is on its way." }]),
    ]);

    const result = await runResolve(
      [scenario("beat-4-stalled-parcel.json")],
      { ...ENV, GATE_MCP_URL: url },
      { db: handle.db, generateContent: model.generateContent, clock: () => NOW },
    );

    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(EXIT_REPLIED);
    const out = result.stdout;
    expect(out).toContain("Illustrative people and orders.");
    expect(out).toContain(`Message 1 of 1: email from ${BUYER_EMAIL.A} (simulated)`);
    expect(out).toContain("  Mode      Protected");
    expect(out).toContain(`  Model     ${MODEL} (reported gemini-3.5-flash-lite-001)`);
    expect(out).toContain("    find_order KIK-1035: Found KIK-1035, capture CAP1035, 18.00 USD.");
    expect(out).toMatch(/ {4}create_refund CAP1035, 18\.00 USD: Allowed\. Intent \S+\./);
    expect(out).toContain("  Outcome   replied, replied");
    expect(out).toContain("  Reply     Your refund of $18.00 is on its way.");
    expect(out).toContain("1 message replied.");
    expect(secretsIn(out)).toEqual([]);

    expect(rail.refunds.size).toBe(1);
    const ticketId = ticketOf(model.requests[0] as GenerateContentParameters);
    const [ticket] = await readThread(handle.db, ticketId);
    expect(ticket).toMatchObject({ simulated: true, senderEmail: BUYER_EMAIL.A, channel: "email" });
    const decisions = (await handle.db.select().from(auditLog)).filter(
      (row) => row.entryType === "decision",
    );
    expect(decisions).toHaveLength(1);
    expect(decisions[0]?.payload).toContain(ticketId);
  });

  it("runs beat 3: shows each denial and the step-up with their reason codes", async () => {
    const { handle, rail } = await seededWorld();
    const url = await listenGate(handle, rail);
    const orders = [
      [1038, "48.00"],
      [1039, "36.00"],
      [1040, "24.00"],
      [1041, "18.00"],
      [1042, "48.00"],
    ] as const;
    const model = scripted([
      (request) =>
        answer(
          orders.map(([n, value], index) =>
            call("create_refund", refund(n, value, ticketOf(request)), `c${index}`),
          ),
        ),
      () => answer([{ text: "I've passed KIK-1042 to the shop for a look." }]),
    ]);

    const result = await runResolve(
      [scenario("beat-3-attack-email.json")],
      { ...ENV, GATE_MCP_URL: url },
      { db: handle.db, generateContent: model.generateContent, clock: () => NOW },
    );

    expect(result.exitCode).toBe(EXIT_REPLIED);
    const lines = result.stdout.split("\n").filter((line) => line.startsWith("    create_refund"));
    expect(lines).toHaveLength(5);
    expect(lines.filter((line) => line.includes("Denied."))).toHaveLength(4);
    expect(lines.filter((line) => line.includes("(TICKET_NOT_FROM_PAYER)"))).toHaveLength(3);
    expect(lines[2]).toContain("(NO_MATCHING_RULE)");
    expect(lines[4]).toContain("CAP1042, 48.00 USD: Waiting for approval.");
    expect(lines[4]).toContain("(SHIPMENT_DELIVERED)");
    expect(lines[0]).toContain("The ticket didn't come from the person who paid.");
    expect(rail.refunds.size).toBe(0);
  });

  it("prints the runs as JSON with --json, and exits 1 when a run stops", async () => {
    const { handle, rail } = await seededWorld();
    const url = await listenGate(handle, rail);
    const model = scripted([() => answer([{ text: "Partial" }], "MAX_TOKENS")]);

    const result = await runResolve(
      [scenario("beat-4-stalled-parcel.json"), "--json"],
      { ...ENV, GATE_MCP_URL: url, GEMINI_FALLBACK_MODEL: "" },
      { db: handle.db, generateContent: model.generateContent, clock: () => NOW },
    );

    expect(result.exitCode).toBe(EXIT_NOT_REPLIED);
    expect(result.stderr).toBe("1 message got no reply.\n");
    const runs = JSON.parse(result.stdout) as { mode: string; status: string; outcome: string }[];
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      mode: "protected",
      status: "stopped",
      outcome: "model_stopped:MAX_TOKENS",
      reply: null,
    });
    expect(secretsIn(result.stdout)).toEqual([]);
  });

  it("threads a follow-up after the first message's run, so its turn holds the earlier reply", async () => {
    const { handle, rail } = await seededWorld();
    const url = await listenGate(handle, rail);
    const path = join(tempDir("resolve-thread-"), "thread.json");
    writeFileSync(
      path,
      JSON.stringify({
        description: "A thread of two simulated chat messages. Illustrative people.",
        messages: [
          { channel: "chat", sender: "payer:KIK-1035", body: "Where is KIK-1035?" },
          { channel: "chat", sender: "payer:KIK-1035", body: "Any news?", follow_up_of: 0 },
        ],
      }),
    );
    const model = scripted([() => answer([{ text: "Let me look into it." }])]);

    const result = await runResolve(
      [path],
      { ...ENV, GATE_MCP_URL: url },
      { db: handle.db, generateContent: model.generateContent, clock: () => NOW },
    );

    expect(result.exitCode).toBe(EXIT_REPLIED);
    expect(result.stdout).toContain("2 messages replied.");
    const first = ticketOf(model.requests[0] as GenerateContentParameters);
    const second = ticketOf(model.requests[1] as GenerateContentParameters);
    expect(second).not.toBe(first);
    expect(result.stdout).toContain(`  Ticket    ${second}, thread ${first}`);
    const thread = await readThread(handle.db, first);
    expect(thread.map((ticket) => ticket.id)).toEqual([first, second]);
    expect(JSON.stringify(model.requests[1]?.contents)).toContain("Let me look into it.");
  });
});

describe("resolve CLI, baseline mode", { timeout: SLOW }, () => {
  it("runs beat 5 in --pglite with --mode baseline: stores the photo and calls PayPal's tools with no checks", async () => {
    const { handle, rail, dir } = await seededWorld();
    await handle.close();
    handles = [];
    const paypalCalls: string[] = [];
    const tokens: string[] = [];
    const createTransport: TransportFactory = (server) => {
      tokens.push(server.env.PAYPAL_ACCESS_TOKEN ?? "");
      const mcp = new Server({ name: "paypal", version: "1.8.1" }, { capabilities: { tools: {} } });
      mcp.setRequestHandler(ListToolsRequestSchema, () => ({
        tools: [
          {
            name: "create_refund",
            description: "Refund a capture.",
            inputSchema: { type: "object", properties: { capture_id: { type: "string" } } },
          },
        ],
      }));
      mcp.setRequestHandler(CallToolRequestSchema, (request) => {
        paypalCalls.push(request.params.name);
        return {
          content: [{ type: "text", text: "done" }],
          structuredContent: { id: "REF1037", status: "COMPLETED" },
        };
      });
      const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
      void mcp.connect(serverSide);
      return clientSide;
    };
    const issueToken: TokenIssuer = async () => ({ accessToken: TOKEN, expiresAt: 0 });
    const model = scripted([
      (request) =>
        answer([call("create_refund", refund(1037, "240.00", ticketOf(request), "damaged"), "c1")]),
      () => answer([{ text: "Your refund of $240.00 is done." }]),
    ]);

    const result = await runResolve(
      [scenario("beat-5-damaged.json"), "--mode", "baseline", "--pglite", dir],
      { GEMINI_API_KEY: GEMINI_KEY },
      { generateContent: model.generateContent, issueToken, createTransport, clock: () => NOW },
    );

    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(EXIT_REPLIED);
    expect(result.stdout).toContain("  Mode      Baseline");
    expect(result.stdout).toContain(
      "    create_refund CAP1037, 240.00 USD: No checks: straight to PayPal. PayPal answered REF1037, COMPLETED.",
    );
    expect(paypalCalls).toEqual(["create_refund"]);
    expect(tokens).toEqual([TOKEN]);
    expect(secretsIn(result.stdout)).toEqual([]);
    expect(rail.refunds.size).toBe(0);

    // The photo went to the model as an inline JPEG, and is stored with the ticket.
    const parts = JSON.stringify(model.requests[0]?.contents);
    expect(parts).toContain('"mimeType":"image/jpeg"');
    const reopened = await openPgliteDirectory(dir);
    handles.push(reopened);
    const ticketId = ticketOf(model.requests[0] as GenerateContentParameters);
    const [ticket] = await readThread(reopened.db, ticketId);
    expect(ticket?.attachments).toEqual([
      { id: expect.stringMatching(/^att_/), contentType: "image/jpeg" },
    ]);
    expect(await reopened.db.select().from(auditLog)).toHaveLength(0);
  });
});

describe("resolve CLI, when it can't run", { timeout: SLOW }, () => {
  it("names missing variables for each mode and never shows a value", async () => {
    const file = scenario("beat-4-stalled-parcel.json");
    const none = await runResolve([file], {});
    expect(none.exitCode).toBe(EXIT_CANT_RUN);
    expect(none.stderr).toBe(
      "The resolve CLI can't start in protected mode. Set GEMINI_API_KEY. Set COUNTERSIGN_SUPPORT_AGENT_KEY, 32 or more characters. Put them in .env.local.\n",
    );
    const short = await runResolve([file], {
      GEMINI_API_KEY: GEMINI_KEY,
      COUNTERSIGN_SUPPORT_AGENT_KEY: "short-key",
    });
    expect(short.stderr).toContain("Set COUNTERSIGN_SUPPORT_AGENT_KEY");
    expect(short.stderr).not.toContain("short-key");
    expect(short.stderr).not.toContain(GEMINI_KEY);

    const baseline = await runResolve([file, "--mode", "baseline"], {
      GEMINI_API_KEY: GEMINI_KEY,
      PAYPAL_CLIENT_ID: "client-id-value",
    });
    expect(baseline.exitCode).toBe(EXIT_CANT_RUN);
    expect(baseline.stderr).toBe(
      "The resolve CLI can't start in baseline mode. Set PAYPAL_BASE_URL, PAYPAL_CLIENT_SECRET. Put them in .env.local.\n",
    );

    const cap = await runResolve([file], { ...ENV, RESOLVE_DAILY_RUN_CAP: "lots" });
    expect(cap.exitCode).toBe(EXIT_CANT_RUN);
    expect(cap.stderr).toContain("RESOLVE_DAILY_RUN_CAP");
    for (const result of [none, short, baseline, cap]) expect(result.stdout).toBe("");
  });

  it("exits 2 for usage, an unreadable or invalid file, and a sender it can't resolve", async () => {
    expect((await runResolve([], ENV)).stderr).toBe(`${RESOLVE_USAGE}\n`);
    expect((await runResolve(["x.json", "--live"], ENV)).stderr).toBe(
      `Unknown option --live. ${RESOLVE_USAGE}\n`,
    );
    expect((await runResolve(["x.json", "--mode", "fast"], ENV)).stderr).toBe(
      `--mode needs protected or baseline. ${RESOLVE_USAGE}\n`,
    );
    const dir = tempDir("resolve-file-");
    const missing = await runResolve([join(dir, "none.json")], ENV);
    expect(missing).toMatchObject({ exitCode: EXIT_CANT_RUN, stdout: "" });
    expect(missing.stderr).toMatch(/^Can't read .*none\.json\.\n$/);

    const write = (name: string, value: unknown) => {
      const path = join(dir, name);
      writeFileSync(path, JSON.stringify(value));
      return path;
    };
    const backwards = write("backwards.json", {
      description: "Simulated. Illustrative people.",
      messages: [{ channel: "chat", sender: "buyer:A", body: "Hi", follow_up_of: 0 }],
    });
    expect((await runResolve([backwards], ENV)).stderr).toContain(
      "must be the index of an earlier message",
    );
    const badSender = write("sender.json", {
      description: "Simulated. Illustrative people.",
      messages: [{ channel: "chat", sender: "buyer:C", body: "Hi" }],
    });
    expect((await runResolve([badSender], ENV)).exitCode).toBe(EXIT_CANT_RUN);
    const badPhoto = write("photo.json", {
      description: "Simulated. Illustrative people.",
      messages: [{ channel: "chat", sender: "buyer:A", body: "Hi", attachments: ["sender.json"] }],
    });
    expect((await runResolve([badPhoto], ENV)).stderr).toBe(
      "Message 1: the photo sender.json isn't a JPEG, PNG or WebP image.\n",
    );

    // Only KIK-1035 is seeded, so buyer B and the payer of KIK-1037 can't be resolved.
    const { handle } = await seededWorld([1035]);
    const model = scripted([]);
    const unseeded = await runResolve([scenario("beat-5-damaged.json")], ENV, {
      db: handle.db,
      generateContent: model.generateContent,
    });
    expect(unseeded).toMatchObject({ exitCode: EXIT_CANT_RUN, stdout: "" });
    expect(unseeded.stderr).toBe(
      "Message 1: Order KIK-1037 isn't seeded. Run npm run seed first.\n",
    );
    expect(model.requests).toHaveLength(0);
  });

  it("exits 2 as a child process when GEMINI_API_KEY is missing", () => {
    const child = spawnSync(
      process.execPath,
      ["--import", "tsx", entry, scenario("beat-4-stalled-parcel.json")],
      { cwd: repoRoot, encoding: "utf8", env: { PATH: process.env.PATH ?? "" } },
    );
    expect(child.status).toBe(EXIT_CANT_RUN);
    expect(child.stdout).toBe("");
    expect(child.stderr).toBe(
      "The resolve CLI can't start in protected mode. Set GEMINI_API_KEY. Set COUNTERSIGN_SUPPORT_AGENT_KEY, 32 or more characters. Put them in .env.local.\n",
    );
  });
});

describe("the scenario files", () => {
  it("parse, say their people are illustrative and messages simulated, and match phase 7's beats", () => {
    const read = (name: string) =>
      MessageFileSchema.parse(JSON.parse(readFileSync(scenario(name), "utf8")));
    const beat3 = read("beat-3-attack-email.json");
    const beat4 = read("beat-4-stalled-parcel.json");
    const beat5 = read("beat-5-damaged.json");
    for (const file of [beat3, beat4, beat5]) {
      expect(file.description).toMatch(/illustrative/i);
      expect(file.description).toMatch(/simulated/i);
    }
    expect(beat3.messages[0]?.sender).toBe("buyer:A");
    for (const n of [1038, 1039, 1040, 1041, 1042]) {
      expect(beat3.messages[0]?.body).toContain(`KIK-${n}`);
    }
    expect(beat4.messages[0]?.sender).toBe("payer:KIK-1035");
    expect(beat5.messages[0]?.sender).toBe("payer:KIK-1037");
    expect(beat5.messages[0]?.body).toContain("$240.00");

    const [photo] = beat5.messages[0]?.attachments ?? [];
    const bytes = readFileSync(scenario(photo as string));
    expect(sniffImageType(new Uint8Array(bytes))).toBe("image/jpeg");
    expect(statSync(scenario(photo as string)).size).toBeLessThan(100 * 1024);
  });

  it("the root package.json runs the CLI with .env.local when it's there", () => {
    const manifest = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };
    expect(manifest.scripts.resolve).toBe(
      "tsx --env-file-if-exists=.env.local apps/resolve-agent/src/resolve-main.ts",
    );
  });
});
