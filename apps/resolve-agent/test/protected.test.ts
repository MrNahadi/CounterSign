import type { Server } from "node:http";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import { createDatabaseShipmentStore } from "@countersign/carrier-mock";
import {
  auditLog,
  createTestDatabase,
  type DatabaseHandle,
  readRun,
  readThread,
  seedOrders,
} from "@countersign/db";
import { createApp } from "@countersign/gate/src/app";
import { createFakeSandbox, type FakeSandbox } from "@countersign/gate/test/fake-sandbox";
import { verifyLog } from "@countersign/ledger";
import type { ShipmentStatus } from "@countersign/mandate";
import type { GenerateContentParameters, GenerateContentResponse, Part } from "@google/genai";
import { afterEach, describe, expect, it } from "vitest";
import type { ToolStep } from "../src/harness";
import { storeMessage } from "../src/intake";
import { parseProtectedEnv, type RunTrace, runProtected } from "../src/protected";

// Protected mode end to end: a listening gate (its fake sandbox and the carrier mock) on
// 127.0.0.1, sharing one PGlite store with Resolve, and a scripted model. Illustrative orders
// and people in PayPal's sandbox shapes; made-up principal keys; simulated messages.

const SLOW = 60_000;
const NOW = new Date("2026-10-17T09:00:00+03:00");
const KEY = "test-support-agent-key-0123456789abcdef";
const MODEL = "gemini-3.5-flash-lite";

const BUYER_EMAIL = { A: "amina.k@example.com", B: "grace.w@example.com" } as const;
const usd = (minor: number) => ({ minor, currency: "USD" as const });

type SeededOrder = { n: number; buyer: "A" | "B"; minor: number; status: ShipmentStatus };
const SEEDED: readonly SeededOrder[] = [
  { n: 1035, buyer: "A", minor: 1800, status: "stalled_10d" },
  { n: 1038, buyer: "B", minor: 4800, status: "delivered" },
  { n: 1039, buyer: "B", minor: 3600, status: "delivered" },
  { n: 1040, buyer: "B", minor: 2400, status: "in_transit" },
  { n: 1041, buyer: "B", minor: 1800, status: "delivered" },
  { n: 1042, buyer: "A", minor: 4800, status: "delivered" },
];

type ProposalFile = {
  proposals: {
    order: string;
    args: { amount: { value: string; currency_code: string } };
    expect: { decision: string; reasons: string[] };
  }[];
};
const beat3File = createRequire(import.meta.url)(
  "@countersign/gate/proposals/beat-3-attack-email.json",
) as ProposalFile;

let servers: Server[] = [];
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

// A store as `npm run seed` leaves it, and a fake sandbox holding the same orders.
async function seededWorld(): Promise<{ handle: DatabaseHandle; rail: FakeSandbox }> {
  const handle = await createTestDatabase();
  handles.push(handle);
  const rail = createFakeSandbox();
  const store = createDatabaseShipmentStore(handle.db);
  for (const { n, buyer, minor, status } of SEEDED) {
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
  return { handle, rail };
}

async function listenGate(handle: DatabaseHandle, rail: FakeSandbox, key = KEY): Promise<string> {
  const server = createApp({
    db: handle.db,
    rail: () => rail,
    env: { COUNTERSIGN_SUPPORT_AGENT_KEY: key },
    clock: () => NOW,
  }).listen(0, "127.0.0.1");
  servers.push(server);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}/mcp`;
}

// A port nothing listens on: listened on, then closed.
async function closedUrl(): Promise<string> {
  const server = createApp({}).listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return `http://127.0.0.1:${port}/mcp`;
}

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
  const generateContent = async (request: GenerateContentParameters) => {
    requests.push(request);
    const next = steps[requests.length - 1];
    if (!next) throw new Error("The script ran out.");
    return next;
  };
  return { generateContent, requests };
}

const refund = (n: number, value: string, ticketId: string) => ({
  capture_id: `CAP${n}`,
  amount: { value, currency_code: "USD" },
  justification: { ticket_id: ticketId, claim: "not_received" },
});

const email = (sender: string, subject: string, body: string) => ({
  channel: "email" as const,
  senderEmail: sender,
  senderPhone: null,
  subject,
  body,
  attachments: [],
});

const BEAT4 = email(
  BUYER_EMAIL.A,
  "Coaster set KIK-1035",
  "My coaster set, order KIK-1035, hasn't arrived. The tracking hasn't moved in over ten days.",
);

const store = (handle: DatabaseHandle, message = BEAT4) =>
  storeMessage(handle.db, message, { mode: "protected", model: MODEL, clock: () => NOW });

const toolSteps = (trace: unknown) =>
  (trace as RunTrace).steps.filter((step): step is ToolStep => step.kind === "tool");

type GuardedResult = { structuredContent: { decision: string; reasons?: { code: string }[] } };

describe("protected mode against the real gate", { timeout: SLOW }, () => {
  it("runs beat 4: finds the order, the gate allows the refund once, and the run is replied", async () => {
    const { handle, rail } = await seededWorld();
    const url = await listenGate(handle, rail);
    const stored = await store(handle);
    expect(stored.ticketId).toMatch(/^tkt_[0-9a-f]{32}$/);
    expect(stored.threadId).toBe(stored.ticketId);
    expect(stored.runId).toMatch(/^run_[0-9a-f]{32}$/);
    const [ticket] = await readThread(handle.db, stored.threadId);
    expect(ticket).toMatchObject({ simulated: true, senderEmail: BUYER_EMAIL.A });

    const model = scripted([
      answer([call("find_order", { order_number: "KIK-1035" }, "c1")]),
      answer([call("create_refund", refund(1035, "18.00", stored.ticketId), "c2")]),
      answer([{ text: "Your refund of $18.00 is on its way." }]),
    ]);
    const lines: string[] = [];
    const run = await runProtected({
      db: handle.db,
      runId: stored.runId,
      env: parseProtectedEnv({ COUNTERSIGN_SUPPORT_AGENT_KEY: KEY, GATE_MCP_URL: url }),
      generateContent: model.generateContent,
      clock: () => NOW,
      log: (line) => lines.push(line),
    });

    expect(run).toMatchObject({
      status: "replied",
      outcome: "replied",
      reply: "Your refund of $18.00 is on its way.",
      mode: "protected",
      modelVersions: Array(3).fill("gemini-3.5-flash-lite-001"),
    });
    expect(run.startedAt).not.toBeNull();
    expect(run.finishedAt).not.toBeNull();
    const trace = run.trace as RunTrace;
    expect(trace.mode).toBe("protected");
    // The gate's fourteen tools (prepare_dispute_evidence among them), plus find_order.
    expect(trace.tools).toHaveLength(15);
    expect(trace.tools).toContain("find_order");
    expect(trace.tools).toContain("create_refund");

    const [found, refunded] = toolSteps(trace);
    expect(found).toMatchObject({ name: "find_order", local: true });
    const response = (refunded as ToolStep).result as GuardedResult;
    expect(response.structuredContent.decision).toBe("allowed");
    expect(rail.refunds.size).toBe(1);

    const decisions = (await handle.db.select().from(auditLog)).filter(
      (row) => row.entryType === "decision",
    );
    expect(decisions).toHaveLength(1);
    expect(decisions[0]?.payload).toContain(stored.ticketId);
    expect((await verifyLog(handle.db)).intact).toBe(true);

    expect(lines).toEqual([`Run ${stored.runId} (protected): replied, replied.`]);
    // The principal key is in no request the model saw, no stored row and no log line.
    const stored_row = JSON.stringify(await readRun(handle.db, stored.runId));
    for (const text of [stored_row, JSON.stringify(model.requests), ...lines]) {
      expect(text).not.toContain(KEY);
      expect(text).not.toContain("Bearer");
    }
  });

  it("runs beat 3's five refunds: 4 denials and 1 step-up, as phase 7's file expects", async () => {
    const { handle, rail } = await seededWorld();
    const url = await listenGate(handle, rail);
    const stored = await store(
      handle,
      email(
        BUYER_EMAIL.A,
        "KIK-1042 never arrived",
        "My order KIK-1042 never arrived. Please also refund KIK-1038, KIK-1039, KIK-1040 and KIK-1041.",
      ),
    );
    const proposals = beat3File.proposals;
    const model = scripted([
      answer(
        proposals.map((proposal, index) =>
          call(
            "create_refund",
            refund(Number(proposal.order.slice(4)), proposal.args.amount.value, stored.ticketId),
            `c${index + 1}`,
          ),
        ),
      ),
      answer([{ text: "I've passed KIK-1042 to the shop for a look." }]),
    ]);
    const run = await runProtected({
      db: handle.db,
      runId: stored.runId,
      env: parseProtectedEnv({ COUNTERSIGN_SUPPORT_AGENT_KEY: KEY, GATE_MCP_URL: url }),
      generateContent: model.generateContent,
      clock: () => NOW,
    });
    expect(run.status).toBe("replied");

    const steps = toolSteps(run.trace);
    expect(steps).toHaveLength(5);
    const got = steps.map((step) => {
      const response = (step.result as GuardedResult).structuredContent;
      return {
        decision: { allowed: "allow", pending_approval: "step_up", denied: "deny" }[
          response.decision
        ],
        reasons: (response.reasons ?? []).map((reason) => reason.code),
      };
    });
    expect(got).toEqual(proposals.map((proposal) => proposal.expect));
    expect(got.filter((item) => item.decision === "deny")).toHaveLength(4);
    expect(got.filter((item) => item.decision === "step_up")).toHaveLength(1);
    expect(rail.refunds.size).toBe(0);
    expect((await verifyLog(handle.db)).intact).toBe(true);
  });
});

describe("protected mode without a gate", { timeout: SLOW }, () => {
  it("ends failed gate_unavailable with no model call for no key, a short key, a wrong key and no gate", async () => {
    const { handle, rail } = await seededWorld();
    const url = await listenGate(handle, rail);
    const wrong = "a-key-the-gate-does-not-hold-0123456789";
    const short = "too-short-key";
    const envs = [
      { GATE_MCP_URL: url },
      { COUNTERSIGN_SUPPORT_AGENT_KEY: short, GATE_MCP_URL: url },
      { COUNTERSIGN_SUPPORT_AGENT_KEY: wrong, GATE_MCP_URL: url },
      { COUNTERSIGN_SUPPORT_AGENT_KEY: KEY, GATE_MCP_URL: await closedUrl() },
    ];
    for (const env of envs) {
      const stored = await store(handle);
      const model = scripted([]);
      const lines: string[] = [];
      const run = await runProtected({
        db: handle.db,
        runId: stored.runId,
        env: parseProtectedEnv(env),
        generateContent: model.generateContent,
        clock: () => NOW,
        log: (line) => lines.push(line),
      });
      expect(run).toMatchObject({
        status: "failed",
        outcome: "gate_unavailable",
        reply: null,
        modelVersions: [],
      });
      expect(model.requests).toHaveLength(0);
      const row = JSON.stringify(await readRun(handle.db, stored.runId));
      for (const text of [row, ...lines]) {
        for (const secret of [KEY, wrong, short]) expect(text).not.toContain(secret);
      }
    }
    expect(rail.calls).toHaveLength(0);
    expect(await handle.db.select().from(auditLog)).toHaveLength(0);
  });

  it("reads the gate's address and the key from the environment", () => {
    expect(parseProtectedEnv({})).toEqual({
      gateUrl: new URL("http://127.0.0.1:8787/mcp"),
      key: null,
    });
    expect(parseProtectedEnv({ COUNTERSIGN_SUPPORT_AGENT_KEY: "x".repeat(31) }).key).toBeNull();
    expect(parseProtectedEnv({ COUNTERSIGN_SUPPORT_AGENT_KEY: KEY }).key).toBe(KEY);
    expect(parseProtectedEnv({ GATE_MCP_URL: "ftp://gate" }).gateUrl).toBeNull();
  });
});
