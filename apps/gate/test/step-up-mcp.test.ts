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
import { verifyLog } from "@countersign/ledger";
import { hashIntent, type Intent } from "@countersign/mandate";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import type { Card, RecentSummary } from "../src/approval-cards";
import { APPROVER_KEY_VAR } from "../src/approver";
import { AgentResponseSchema, APPROVAL_WINDOW_MS } from "../src/decide";
import { ReconciliationPayloadSchema } from "../src/execution-log";
import { SUPPORT_AGENT_KEY_VAR } from "../src/principals";
import { createFakeSandbox } from "./fake-sandbox";

// Step-up end to end: the agent proposes beat 5 over /mcp, the merchant answers through the
// approval API, and PayPal's webhook reconciles the refund. One real gate on 127.0.0.1 with
// PGlite, the fake sandbox and a clock the test moves. Illustrative IDs, keys and people.

const SLOW = 60_000;
const NOW = new Date("2026-10-17T09:00:00+03:00");
const LATER = new Date(NOW.getTime() + 5 * 60 * 1000);
const EXPIRES_AT = new Date(NOW.getTime() + APPROVAL_WINDOW_MS);
const PAST_EXPIRY = new Date(EXPIRES_AT.getTime() + 1);
const AGENT_KEY = "agent-key-illustrative-0123456789abcdef";
const APPROVER_KEY = "approver-key-illustrative-0123456789abcd";
const WEBHOOK_ID = "WH-FAKE-0123456789";
const ENV = {
  [SUPPORT_AGENT_KEY_VAR]: AGENT_KEY,
  [APPROVER_KEY_VAR]: APPROVER_KEY,
  PAYPAL_WEBHOOK_ID: WEBHOOK_ID,
};
const PAYER = "wanjiru.m@example.com";
const CAPTURE = "CAP-1037";

const TRANSMISSION = {
  "paypal-transmission-id": "b2c3d4e5-transmission-id-header",
  "paypal-transmission-time": "2026-10-17T06:10:00Z",
  "paypal-cert-url": "https://api.sandbox.paypal.com/v1/notifications/certs/CERT-fake-cert-header",
  "paypal-auth-algo": "SHA256withRSA",
  "paypal-transmission-sig": "c2lnbmF0dXJlLXRyYW5zbWlzc2lvbi1zaWctaGVhZGVy",
};

const usd = (minor: number) => ({ minor, currency: "USD" as const });

// Beat 5: the payer of KIK-1037 asks for $240.00 back for a damaged basket, with a photo.
function world() {
  const rail = createFakeSandbox();
  const capture = { id: CAPTURE, status: "COMPLETED", amount: usd(24000), orderId: "ORD-1037" };
  rail.captures.set(CAPTURE, capture);
  rail.orders.set("ORD-1037", {
    id: "ORD-1037",
    status: "COMPLETED",
    payerEmail: PAYER,
    payerId: "PAYER1037",
    purchaseUnits: [
      {
        referenceId: "KIK-1037",
        customId: null,
        invoiceId: null,
        amount: usd(24000),
        captures: [capture],
        trackers: [
          {
            id: `${CAPTURE}-TRK1037`,
            captureId: CAPTURE,
            trackingNumber: "TRK1037",
            status: "SHIPPED",
          },
        ],
        refunds: [],
      },
    ],
  });
  const shipments = new Map<string, unknown>([
    [
      "TRK1037",
      {
        trackingNumber: "TRK1037",
        carrierName: "Illustrative Post",
        status: "delivered",
        scanEvents: [{ at: "2026-10-02T08:00:00Z", description: "Accepted", place: "Nairobi" }],
        updatedAt: "2026-10-05T08:00:00Z",
      },
    ],
  ]);
  return { rail, carrier: createMockCarrier(createMemoryShipmentStore(shipments)) };
}
type World = ReturnType<typeof world>;

// The parts of a POST /approvals/:id answer these tests read.
type Answered = {
  outcome: string;
  code: string | null;
  execution: { outcome: string; refund: { id: string; status: string } | null } | null;
};

// The same refund intent as beat 5's, at another amount.
const beat5Intent = (minor: number): Intent => ({
  principal: "support-agent",
  rail: "paypal",
  action: "paypal.refund",
  amount: usd(minor),
  target: { kind: "capture", captureId: CAPTURE, orderId: "ORD-1037" },
  ticketId: "TKT-1037",
  claim: "damaged",
  mandateVersion: 3,
});

let servers: Server[] = [];
let clients: Client[] = [];

afterEach(async () => {
  for (const client of clients) await client.close().catch(() => {});
  for (const server of servers) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  servers = [];
  clients = [];
});

describe("step-up end to end over MCP", { timeout: SLOW }, () => {
  let handle: DatabaseHandle;
  let db: Database;

  beforeAll(async () => {
    handle = await createTestDatabase();
    db = handle.db;
  }, SLOW);

  beforeEach(async () => {
    await db.execute(sql`TRUNCATE audit_log, tickets, seed_orders`);
    await writeTicket(db, {
      id: "TKT-1037",
      channel: "email",
      senderEmail: PAYER,
      senderPhone: null,
      subject: "Damaged basket",
      body: "My basket arrived crushed. Photo attached.",
      attachments: [{ id: "ATT-TKT-1037", contentType: "image/jpeg" }],
      receivedAt: "2026-10-17T08:00:00+03:00",
      simulated: true,
    });
  });

  afterAll(async () => {
    await handle.close();
  });

  const entryTypes = async () =>
    (await db.select().from(auditLog).orderBy(asc(auditLog.seq))).map((row) => row.entryType);

  // One gate whose clock the test sets.
  async function gate(w: World) {
    const clock = { now: NOW };
    const server = createApp({
      db,
      rail: () => w.rail,
      carrier: w.carrier,
      env: ENV,
      clock: () => clock.now,
    }).listen(0, "127.0.0.1");
    servers.push(server);
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const { port } = server.address() as AddressInfo;
    const base = `http://127.0.0.1:${port}`;

    const client = new Client({ name: "test-agent", version: "0.0.0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
        requestInit: { headers: { Authorization: `Bearer ${AGENT_KEY}` } },
      }),
    );
    clients.push(client);

    const approver = { Authorization: `Bearer ${APPROVER_KEY}` };
    return {
      clock,
      async propose(value: string) {
        const result = await client.callTool({
          name: "create_refund",
          arguments: {
            capture_id: CAPTURE,
            amount: { value, currency_code: "USD" },
            justification: { ticket_id: "TKT-1037", claim: "damaged" },
          },
        });
        expect(result.isError).toBe(false);
        return AgentResponseSchema.parse(result.structuredContent);
      },
      async list(): Promise<{ open: Card[]; recent: RecentSummary[] }> {
        const res = await fetch(`${base}/approvals`, { headers: approver });
        expect(res.status).toBe(200);
        return (await res.json()) as { open: Card[]; recent: RecentSummary[] };
      },
      async card(id: number): Promise<Card> {
        const res = await fetch(`${base}/approvals/${id}`, { headers: approver });
        expect(res.status).toBe(200);
        return (await res.json()) as Card;
      },
      async answer(id: number, body: { answer: string; intent_hash: string }): Promise<Answered> {
        const res = await fetch(`${base}/approvals/${id}`, {
          method: "POST",
          headers: { ...approver, "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        expect(res.status).toBe(200);
        return (await res.json()) as Answered;
      },
      webhook(body: string) {
        return fetch(`${base}/webhooks/paypal`, {
          method: "POST",
          headers: { ...TRANSMISSION, "Content-Type": "application/json" },
          body,
        });
      },
    };
  }

  // Proposes beat 5 over /mcp and finds its card.
  async function heldBeat5(g: Awaited<ReturnType<typeof gate>>) {
    const response = await g.propose("240.00");
    if (response.decision !== "pending_approval") throw new Error("not held");
    const { open } = await g.list();
    expect(open).toHaveLength(1);
    const card = open[0] as Card;
    expect(card.intent_id).toBe(response.intent_id);
    return { response, card };
  }

  const refunds = (w: World) => w.rail.calls.filter((call) => call.call === "refundCapture");

  it("holds beat 5 for 15 minutes, executes one refund on approval, and reconciles it from the webhook", async () => {
    const w = world();
    const g = await gate(w);

    const { response, card } = await heldBeat5(g);
    expect(response.expires_at).toBe(EXPIRES_AT.toISOString());
    expect(card.expires_at).toBe(EXPIRES_AT.toISOString());
    expect(card.amount.display).toBe("$240.00");
    expect(refunds(w)).toHaveLength(0);

    g.clock.now = LATER;
    const answer = await g.answer(card.step_up_id, {
      answer: "approve",
      intent_hash: card.intent_hash,
    });
    expect(answer).toMatchObject({ outcome: "approved", code: null });
    expect(answer.execution?.outcome).toBe("executed");
    const refundId = answer.execution?.refund?.id;
    if (refundId === undefined) throw new Error("no refund");
    expect(refunds(w)).toHaveLength(1);
    expect(refunds(w)[0]?.arg).toMatchObject({
      captureId: CAPTURE,
      amount: usd(24000),
      requestId: card.intent_hash,
    });

    // A second tap answers ALREADY_ANSWERED and refunds nothing more.
    const again = await g.answer(card.step_up_id, {
      answer: "approve",
      intent_hash: card.intent_hash,
    });
    expect(again).toMatchObject({ outcome: "rejected", code: "ALREADY_ANSWERED" });
    expect(refunds(w)).toHaveLength(1);

    const webhook = await g.webhook(
      JSON.stringify({
        id: "WH-EVENT-1037",
        event_type: "PAYMENT.CAPTURE.REFUNDED",
        resource_type: "refund",
        resource: { id: refundId, status: "COMPLETED" },
      }),
    );
    expect(webhook.status).toBe(200);
    const rows = await db.select().from(auditLog).orderBy(asc(auditLog.seq));
    const reconciliation = rows.find((row) => row.entryType === "reconciliation");
    expect(reconciliation?.refId).toBe(card.intent_id);
    const payload = ReconciliationPayloadSchema.parse(JSON.parse(reconciliation?.payload ?? ""));
    expect(payload.refund).toMatchObject({ id: refundId, captureId: CAPTURE, amount: usd(24000) });
    expect(payload.resultSeq).not.toBeNull();

    expect(rows.map((row) => row.entryType)).toEqual([
      "mandate.version",
      "decision",
      "approval",
      "execution.requested",
      "execution.result",
      "approval",
      "reconciliation",
    ]);
    expect((await verifyLog(db)).intact).toBe(true);

    const { open, recent } = await g.list();
    expect(open).toEqual([]);
    expect(recent).toHaveLength(1);
    expect(recent[0]).toMatchObject({
      step_up_id: card.step_up_id,
      outcome: "approved",
      execution: { outcome: "executed", refund: { id: refundId } },
    });
  });

  it("rejects an approval sent with the hash of the same intent at $241.00, and refunds nothing", async () => {
    const w = world();
    const g = await gate(w);
    const { card } = await heldBeat5(g);
    // The hash the card shows is the stored intent's, so the $241.00 one is the same intent changed.
    expect(hashIntent(beat5Intent(24000)).hash).toBe(card.intent_hash);
    const changed = hashIntent(beat5Intent(24100)).hash;
    expect(changed).not.toBe(card.intent_hash);

    g.clock.now = LATER;
    const answer = await g.answer(card.step_up_id, { answer: "approve", intent_hash: changed });
    expect(answer).toMatchObject({ outcome: "rejected", code: "HASH_MISMATCH", execution: null });
    expect(refunds(w)).toHaveLength(0);
    expect([...w.rail.refunds.values()]).toEqual([]);
    expect((await entryTypes()).filter((type) => type.startsWith("execution."))).toEqual([]);

    // Still open: the right hash can answer it.
    expect((await g.card(card.step_up_id)).state).toBe("open");
    expect((await verifyLog(db)).intact).toBe(true);
  });

  it("rejects an approval after expires_at, and then lists the card as expired", async () => {
    const w = world();
    const g = await gate(w);
    const { card } = await heldBeat5(g);

    g.clock.now = PAST_EXPIRY;
    const answer = await g.answer(card.step_up_id, {
      answer: "approve",
      intent_hash: card.intent_hash,
    });
    expect(answer).toMatchObject({ outcome: "rejected", code: "EXPIRED", execution: null });
    expect(refunds(w)).toHaveLength(0);

    expect((await g.card(card.step_up_id)).state).toBe("expired");
    const { open, recent } = await g.list();
    expect(open).toEqual([]);
    expect(recent).toHaveLength(1);
    expect(recent[0]).toMatchObject({
      step_up_id: card.step_up_id,
      outcome: "expired",
      at: EXPIRES_AT.toISOString(),
      execution: null,
    });
    expect((await verifyLog(db)).intact).toBe(true);
  });
});
