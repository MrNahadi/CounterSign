import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createMemoryShipmentStore, createMockCarrier } from "@countersign/carrier-mock";
import {
  asc,
  auditLog,
  createTestDatabase,
  type Database,
  type DatabaseHandle,
  sql,
  writeTicket,
} from "@countersign/db";
import { appendEntries, verifyLog } from "@countersign/ledger";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { type AppDeps, createApp } from "../src/app";
import { AgentResponseSchema } from "../src/decide";
import { UNAUTHORIZED_BODY, UNRECORDED_MESSAGE } from "../src/mcp";
import { loadPrincipals } from "../src/principals";
import { mandateRef } from "../src/record";
import { createFakeSandbox } from "./fake-sandbox";

// The gate's MCP endpoint, driven by the SDK's own client over real HTTP. Illustrative orders and
// people in PayPal's sandbox shapes; made-up principal keys.

const SLOW = 60_000;
const NOW = new Date("2026-10-17T09:00:00+03:00");
const KEY = "test-support-agent-key-0123456789abcdef";
const ENV = { COUNTERSIGN_SUPPORT_AGENT_KEY: KEY };

const usd = (minor: number) => ({ minor, currency: "USD" as const });

type Seeded = { n: number; minor: number; payerEmail: string; shipment: string };

function sandboxWith(orders: readonly Seeded[]) {
  const rail = createFakeSandbox();
  const shipments = new Map<string, unknown>();
  for (const { n, minor, payerEmail, shipment } of orders) {
    const captureId = `CAP-${n}`;
    const orderId = `ORD-${n}`;
    const trackingNumber = `TRK${n}`;
    const capture = { id: captureId, status: "COMPLETED", amount: usd(minor), orderId };
    rail.captures.set(captureId, capture);
    rail.orders.set(orderId, {
      id: orderId,
      status: "COMPLETED",
      payerEmail,
      payerId: `PAYER${n}`,
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
    shipments.set(trackingNumber, {
      trackingNumber,
      carrierName: "Illustrative Post",
      status: shipment,
      scanEvents: [{ at: "2026-10-02T08:00:00Z", description: "Accepted", place: "Nairobi" }],
      updatedAt: "2026-10-05T08:00:00Z",
    });
  }
  const carrier = createMockCarrier(createMemoryShipmentStore(shipments));
  return { rail, carrier };
}

const BEAT4_PAYER = "amina.k@example.com";
const beat4World = () =>
  sandboxWith([{ n: 1035, minor: 1800, payerEmail: BEAT4_PAYER, shipment: "stalled_10d" }]);

const refundArgs = (n: number, value: string | null, ticketId: string) => ({
  capture_id: `CAP-${n}`,
  ...(value === null ? {} : { amount: { value, currency_code: "USD" } }),
  justification: { ticket_id: ticketId, claim: "not_received" },
});

const GUARDED = [
  "create_refund",
  "accept_dispute_claim",
  "provide_dispute_evidence",
  "make_offer",
  "send_invoice",
  "pay_order",
  "create_payout",
];

let servers: Server[] = [];
let clients: Client[] = [];

async function listen(deps: AppDeps): Promise<string> {
  const server = createApp(deps).listen(0, "127.0.0.1");
  servers.push(server);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}/mcp`;
}

async function connect(url: string, key = KEY): Promise<Client> {
  const client = new Client({ name: "test-agent", version: "0.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers: { Authorization: `Bearer ${key}` } },
  });
  await client.connect(transport);
  clients.push(client);
  return client;
}

afterEach(async () => {
  for (const client of clients) await client.close().catch(() => {});
  for (const server of servers) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  servers = [];
  clients = [];
});

const post = (url: string, headers: Record<string, string>) =>
  fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...headers,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
  });

describe("POST /mcp: principal keys", () => {
  it("answers 401 with one fixed body for a missing, malformed, empty or wrong key", async () => {
    const url = await listen({ env: ENV });
    const refusals: Record<string, string>[] = [
      {},
      { Authorization: `Basic ${KEY}` },
      { Authorization: "Bearer " },
      { Authorization: `Bearer ${KEY}x` },
      { Authorization: `bearer ${KEY}` },
    ];
    for (const headers of refusals) {
      const res = await post(url, headers);
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual(UNAUTHORIZED_BODY);
    }
    const ok = await post(url, { Authorization: `Bearer ${KEY}` });
    expect(ok.status).toBe(200);
  });

  it("answers the same 401 to every key when none is set, and logs the unset variable by name", async () => {
    const lines: string[] = [];
    const short = "too-short";
    const url = await listen({
      env: { COUNTERSIGN_SUPPORT_AGENT_KEY: short },
      log: (line) => lines.push(line),
    });
    const res = await post(url, { Authorization: `Bearer ${short}` });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual(UNAUTHORIZED_BODY);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("COUNTERSIGN_SUPPORT_AGENT_KEY");
    expect(lines[0]).not.toContain(short);
  });

  it("refuses every key when the mandate doesn't parse, and says why at startup", async () => {
    const lines: string[] = [];
    const url = await listen({
      env: ENV,
      principals: loadPrincipals({ env: ENV, readMandate: () => ({ id: "broken" }) }),
      log: (line) => lines.push(line),
    });
    const res = await post(url, { Authorization: `Bearer ${KEY}` });
    expect(res.status).toBe(401);
    expect(lines.join("\n")).toContain("mandate didn't load");
  });

  it("refuses the SDK client with a wrong key", async () => {
    const url = await listen({ env: ENV });
    await expect(connect(url, "not-the-key-but-long-enough-0123456789")).rejects.toThrow();
  });

  it("answers 405 to GET and DELETE", async () => {
    const url = await listen({ env: ENV });
    for (const method of ["GET", "DELETE"]) {
      const res = await fetch(url, { method, headers: { Authorization: `Bearer ${KEY}` } });
      expect(res.status).toBe(405);
    }
  });

  it("still answers /health with no dependencies", async () => {
    const url = await listen({});
    const res = await fetch(url.replace("/mcp", "/health"));
    expect(await res.json()).toEqual({ ok: true });
  });
});

describe("tools/list", () => {
  it("lists the seven guarded tools with input schemas from the normalization schemas", async () => {
    const client = await connect(await listen({ env: ENV }));
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toEqual(GUARDED);

    const refund = tools.find((tool) => tool.name === "create_refund");
    expect(refund?.inputSchema).toMatchObject({
      type: "object",
      additionalProperties: false,
      required: expect.arrayContaining(["capture_id", "justification"]),
    });
    expect(Object.keys(refund?.inputSchema.properties ?? {})).toEqual([
      "capture_id",
      "amount",
      "note_to_payer",
      "invoice_id",
      "justification",
    ]);
    const justification = refund?.inputSchema.properties?.justification as {
      required?: string[];
    };
    expect(justification.required).toEqual(["ticket_id"]);

    const extensions = ["provide_dispute_evidence", "make_offer", "create_payout"];
    for (const tool of tools) {
      expect(tool.description).toBeTruthy();
      const extension = "Countersign extension: PayPal's Agent Toolkit has no such tool.";
      expect(tool.description?.includes(extension)).toBe(extensions.includes(tool.name));
      expect(tool.inputSchema.properties).toHaveProperty("justification");
    }
    const payout = tools.find((tool) => tool.name === "create_payout");
    expect(payout?.inputSchema.required).toEqual(["receiver", "amount"]);
  });
});

describe("tools/call for guarded tools", { timeout: SLOW }, () => {
  let handle: DatabaseHandle;
  let db: Database;

  beforeAll(async () => {
    handle = await createTestDatabase();
    db = handle.db;
  }, SLOW);

  beforeEach(async () => {
    await db.execute(sql`TRUNCATE audit_log, tickets`);
  });

  afterAll(async () => {
    await handle.close();
  });

  const entries = () => db.select().from(auditLog).orderBy(asc(auditLog.seq));

  const storeTicket = (id: string, senderEmail: string) =>
    writeTicket(db, {
      id,
      channel: "email",
      senderEmail,
      senderPhone: null,
      subject: null,
      body: "Simulated ticket.",
      attachments: [],
      receivedAt: "2026-10-17T08:00:00+03:00",
      simulated: true,
    });

  const gate = async (world: ReturnType<typeof sandboxWith>) =>
    connect(
      await listen({
        db,
        rail: () => world.rail,
        carrier: world.carrier,
        env: ENV,
        clock: () => NOW,
      }),
    );

  // The agent response, checked to be the same in structuredContent and the JSON text.
  async function call(client: Client, name: string, args: Record<string, unknown>) {
    const result = await client.callTool({ name, arguments: args });
    const content = result.content as { type: string; text: string }[];
    expect(result.isError).toBe(false);
    expect(content).toHaveLength(1);
    expect(content[0]?.type).toBe("text");
    expect(JSON.parse(content[0]?.text ?? "")).toEqual(result.structuredContent);
    return AgentResponseSchema.parse(result.structuredContent);
  }

  const refunds = (world: ReturnType<typeof sandboxWith>) =>
    world.rail.calls.filter((c) => c.call === "refundCapture");

  it("allows beat 4 and refunds once, records the decision, and answers a second call as a replay with no second refund", async () => {
    const world = beat4World();
    await storeTicket("TKT-1035", BEAT4_PAYER);
    const client = await gate(world);

    const first = await call(client, "create_refund", refundArgs(1035, "18.00", "TKT-1035"));
    expect(first.decision).toBe("allowed");
    expect(refunds(world)).toHaveLength(1);
    const types = (await entries()).map((row) => row.entryType);
    expect(types).toEqual([
      "mandate.version",
      "decision",
      "execution.requested",
      "execution.result",
    ]);
    const decision = (await entries()).find((row) => row.entryType === "decision");
    expect(decision?.refId).toBe(first.intent_id);

    const second = await call(client, "create_refund", refundArgs(1035, "18.00", "TKT-1035"));
    expect(second).toEqual(first);
    expect(refunds(world)).toHaveLength(1);
    expect((await verifyLog(db)).intact).toBe(true);
  });

  it("gives beat 3's five proposals four denials and one step-up", async () => {
    const world = sandboxWith([
      { n: 1038, minor: 4500, payerEmail: "sb-1038@personal.example.com", shipment: "lost" },
      { n: 1039, minor: 6200, payerEmail: "sb-1039@personal.example.com", shipment: "stalled_10d" },
      { n: 1040, minor: 3000, payerEmail: "sb-1040@personal.example.com", shipment: "delivered" },
      { n: 1041, minor: 7400, payerEmail: "sb-1041@personal.example.com", shipment: "delivered" },
      { n: 1042, minor: 9600, payerEmail: "grace.w@example.com", shipment: "delivered" },
    ]);
    await storeTicket("TKT-3001", "grace.w@example.com");
    const client = await gate(world);

    const outcomes = [];
    for (const [n, value] of [
      [1038, "45.00"],
      [1039, null],
      [1040, "30.00"],
      [1041, null],
      [1042, "96.00"],
    ] as const) {
      const response = await call(client, "create_refund", refundArgs(n, value, "TKT-3001"));
      outcomes.push([
        response.decision,
        "reasons" in response ? response.reasons.map((r) => r.code) : [],
      ]);
    }
    expect(outcomes).toEqual([
      ["denied", ["TICKET_NOT_FROM_PAYER"]],
      ["denied", ["TICKET_NOT_FROM_PAYER"]],
      ["denied", ["TICKET_NOT_FROM_PAYER"]],
      ["denied", ["TICKET_NOT_FROM_PAYER"]],
      ["pending_approval", ["SHIPMENT_DELIVERED"]],
    ]);
    expect(refunds(world)).toHaveLength(0);
    const decisions = (await entries()).filter((row) => row.entryType === "decision");
    expect(decisions).toHaveLength(5);
  });

  it("denies and records a malformed create_refund and an unknown tool, rather than answering an MCP error", async () => {
    const world = beat4World();
    const client = await gate(world);

    const malformed = await call(client, "create_refund", {
      amount: { value: "18.00", currency_code: "USD" },
      justification: { ticket_id: "TKT-1035" },
    });
    expect(malformed).toMatchObject({ decision: "denied", intent_id: null });
    expect("reasons" in malformed && malformed.reasons[0]?.code).toBe("INVALID_PROPOSAL");

    const unknown = await call(client, "transfer_funds", { to: "someone@example.com" });
    expect(unknown).toMatchObject({ decision: "denied", intent_id: null });
    expect("reasons" in unknown && unknown.reasons[0]?.code).toBe("UNKNOWN_ACTION");

    const decisions = (await entries()).filter((row) => row.entryType === "decision");
    expect(decisions).toHaveLength(2);
    expect(decisions[1]?.payload).toContain("transfer_funds");
    expect(refunds(world)).toHaveLength(0);
  });

  it("answers isError with the fixed message, and refunds nothing, when the proposal can't be recorded", async () => {
    const world = beat4World();
    await storeTicket("TKT-1035", BEAT4_PAYER);
    const mandate = { id: "kikapu-studio", version: 3 };
    const conflict = await appendEntries(db, [
      {
        entryType: "mandate.version",
        refId: mandateRef(mandate),
        at: "2026-10-16T09:00:00.000Z",
        payload: { mandate: { id: mandate.id }, hash: "c".repeat(64) },
      },
    ]);
    if (!conflict.ok) throw new Error(conflict.rejection.detail);
    const client = await gate(world);

    const result = await client.callTool({
      name: "create_refund",
      arguments: refundArgs(1035, "18.00", "TKT-1035"),
    });
    expect(result).toEqual({
      content: [{ type: "text", text: UNRECORDED_MESSAGE }],
      isError: true,
    });
    expect((await entries()).map((row) => row.entryType)).toEqual(["mandate.version"]);
    expect(refunds(world)).toHaveLength(0);
  });

  it("answers isError with the fixed message when the gate has no database or rail", async () => {
    const client = await connect(await listen({ env: ENV, clock: () => NOW }));
    const result = await client.callTool({
      name: "create_refund",
      arguments: refundArgs(1035, "18.00", "TKT-1035"),
    });
    expect(result).toEqual({
      content: [{ type: "text", text: UNRECORDED_MESSAGE }],
      isError: true,
    });
  });
});
