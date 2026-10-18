import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createMemoryShipmentStore, createMockCarrier } from "@countersign/carrier-mock";
import {
  asc,
  auditLog,
  createTestDatabase,
  type Database,
  type DatabaseHandle,
  sql,
} from "@countersign/db";
import { appendEntries, verifyLog } from "@countersign/ledger";
import { parseMandate } from "@countersign/mandate";
import { CALLS, type TicketSnapshot } from "@countersign/verifiers";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ExecutionRequestedPayloadSchema, executionRequestedEntry } from "../src/execution-log";
import { proposeRefund } from "../src/propose";
import { mandateRef } from "../src/record";
import { createFakeSandbox } from "./fake-sandbox";

// Each PGlite start takes a couple of seconds.
const SLOW = 60_000;
const NOW = new Date("2026-10-17T09:00:00+03:00");
const PRINCIPAL = "support-agent";

const mandateFile = fileURLToPath(
  new URL("../../../packages/mandate/fixtures/kikapu-studio-v3.json", import.meta.url),
);
const parsedMandate = parseMandate(JSON.parse(readFileSync(mandateFile, "utf8")));
if (!parsedMandate.ok) throw new Error(parsedMandate.error);
const mandate = parsedMandate.mandate;

const usd = (minor: number) => ({ minor, currency: "USD" as const });

// Illustrative orders in PayPal's sandbox shapes, one capture and tracker each.
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

const ticket = (id: string, senderEmail: string): TicketSnapshot => ({
  call: CALLS.ticket,
  id,
  senderEmail,
  attachments: [],
});

const refund = (n: number, value: string | null, ticketId: string) => ({
  tool: "create_refund",
  args: {
    capture_id: `CAP-${n}`,
    ...(value === null ? {} : { amount: { value, currency_code: "USD" } }),
  },
  justification: { ticket_id: ticketId, claim: "not_received" },
});

const BEAT4_PAYER = "amina.k@example.com";
const beat4World = () =>
  sandboxWith([{ n: 1035, minor: 1800, payerEmail: BEAT4_PAYER, shipment: "stalled_10d" }]);
const beat4Ticket = ticket("TKT-1035", BEAT4_PAYER);

describe("proposeRefund: deciding on live records under the ledger lock", () => {
  let handle: DatabaseHandle;
  let db: Database;

  beforeAll(async () => {
    handle = await createTestDatabase();
    db = handle.db;
  }, SLOW);

  beforeEach(async () => {
    await db.execute(sql`TRUNCATE audit_log`);
  });

  afterAll(async () => {
    await handle.close();
  });

  const entries = () => db.select().from(auditLog).orderBy(asc(auditLog.seq));
  const requests = async () =>
    (await entries()).filter((row) => row.entryType === "execution.requested");

  const propose = (
    world: ReturnType<typeof sandboxWith>,
    proposal: unknown,
    proposalTicket: TicketSnapshot,
  ) =>
    proposeRefund({
      mandate,
      principal: PRINCIPAL,
      proposal,
      ticket: proposalTicket,
      now: NOW,
      rail: world.rail,
      carrier: world.carrier,
      db,
    });

  it("gives beat 3's five proposals four TICKET_NOT_FROM_PAYER denials and one SHIPMENT_DELIVERED step-up, each one decision entry and no request", async () => {
    const world = sandboxWith([
      { n: 1038, minor: 4500, payerEmail: "sb-1038@personal.example.com", shipment: "lost" },
      { n: 1039, minor: 6200, payerEmail: "sb-1039@personal.example.com", shipment: "stalled_10d" },
      { n: 1040, minor: 3000, payerEmail: "sb-1040@personal.example.com", shipment: "delivered" },
      { n: 1041, minor: 7400, payerEmail: "sb-1041@personal.example.com", shipment: "delivered" },
      { n: 1042, minor: 9600, payerEmail: "grace.w@example.com", shipment: "delivered" },
    ]);
    const attack = ticket("TKT-3001", "grace.w@example.com");
    const proposals = [
      refund(1038, "45.00", "TKT-3001"),
      refund(1039, null, "TKT-3001"),
      refund(1040, "30.00", "TKT-3001"),
      refund(1041, null, "TKT-3001"),
      refund(1042, "96.00", "TKT-3001"),
    ];

    const outcomes = [];
    for (const proposal of proposals) {
      const result = await propose(world, proposal, attack);
      if (!result.ok) throw new Error(result.detail);
      expect(result.problems).toEqual([]);
      expect(result.seqs.request).toBeNull();
      outcomes.push([result.record.decision, result.record.reasons.map((r) => r.code)]);
    }

    expect(outcomes).toEqual([
      ["deny", ["TICKET_NOT_FROM_PAYER"]],
      ["deny", ["TICKET_NOT_FROM_PAYER"]],
      ["deny", ["TICKET_NOT_FROM_PAYER"]],
      ["deny", ["TICKET_NOT_FROM_PAYER"]],
      ["step_up", ["SHIPMENT_DELIVERED"]],
    ]);
    const rows = await entries();
    expect(rows.map((row) => row.entryType)).toEqual([
      "mandate.version",
      "decision",
      "decision",
      "decision",
      "decision",
      "decision",
    ]);
    expect(world.rail.calls.some((call) => call.call === "refundCapture")).toBe(false);
    expect((await verifyLog(db)).intact).toBe(true);
  });

  it("writes beat 4's decision and an execution.requested entry pointing at it, in one transaction", async () => {
    const world = beat4World();
    const result = await propose(world, refund(1035, "18.00", "TKT-1035"), beat4Ticket);
    if (!result.ok) throw new Error(result.detail);

    expect(result.response.decision).toBe("allowed");
    expect(result.problems).toEqual([]);
    expect(result.seqs).toEqual({ mandate: 1, decision: 2, request: 3 });

    const rows = await entries();
    expect(rows.map((row) => [row.seq, row.entryType, row.refId])).toEqual([
      [1, "mandate.version", mandateRef(mandate)],
      [2, "decision", result.record.intentId],
      [3, "execution.requested", result.record.intentId],
    ]);
    // Written together: the same clock reading, and the request names the decision.
    expect(rows[2]?.at).toBe(rows[1]?.at);
    const payload = ExecutionRequestedPayloadSchema.parse(JSON.parse(rows[2]?.payload ?? ""));
    expect(payload).toMatchObject({
      replay: false,
      decisionSeq: 2,
      intentId: result.record.intentId,
      intentHash: result.record.intentHash,
      requestId: result.record.intentHash,
      principal: PRINCIPAL,
      captureId: "CAP-1035",
      amount: usd(1800),
    });
    expect((await verifyLog(db)).intact).toBe(true);
  });

  it("denies a new intent DUPLICATE_REFUND when an earlier request on the capture has no result yet", async () => {
    const world = beat4World();
    const earlier = await appendEntries(db, [
      executionRequestedEntry({
        at: "2026-10-17T05:00:00.000Z",
        intentId: `int_${"b".repeat(24)}`,
        intentHash: "b".repeat(64),
        principal: PRINCIPAL,
        rail: "paypal",
        action: "paypal.refund",
        captureId: "CAP-1035",
        amount: usd(500),
        decisionSeq: 1,
      }),
    ]);
    if (!earlier.ok) throw new Error(earlier.rejection.detail);

    const result = await propose(world, refund(1035, "18.00", "TKT-1035"), beat4Ticket);
    if (!result.ok) throw new Error(result.detail);

    expect(result.response.decision).toBe("denied");
    expect(result.record.reasons.map((reason) => reason.code)).toContain("DUPLICATE_REFUND");
    expect(result.seqs.request).toBeNull();
    expect(await requests()).toHaveLength(1);
  });

  it("writes nothing and requests nothing when the mandate version is logged with another hash", async () => {
    const world = beat4World();
    const conflict = await appendEntries(db, [
      {
        entryType: "mandate.version",
        refId: mandateRef(mandate),
        at: "2026-10-16T09:00:00.000Z",
        payload: { mandate: { id: mandate.id }, hash: "c".repeat(64) },
      },
    ]);
    if (!conflict.ok) throw new Error(conflict.rejection.detail);

    const result = await propose(world, refund(1035, "18.00", "TKT-1035"), beat4Ticket);

    expect(result).toMatchObject({ ok: false, problem: "MANDATE_VERSION_CONFLICT" });
    expect((await entries()).map((row) => row.entryType)).toEqual(["mandate.version"]);
    expect(world.rail.calls.some((call) => call.call === "refundCapture")).toBe(false);
  });

  it("writes exactly one request when two different intents on one capture run concurrently", async () => {
    const world = beat4World();
    const [first, second] = await Promise.all([
      propose(world, refund(1035, "18.00", "TKT-1035"), beat4Ticket),
      propose(world, refund(1035, "10.00", "TKT-1035"), beat4Ticket),
    ]);
    if (!first?.ok || !second?.ok) throw new Error("recording failed");

    expect(first.record.intentId).not.toBe(second.record.intentId);
    const decisions = [first, second].map((result) => result.response.decision).sort();
    expect(decisions).toEqual(["allowed", "denied"]);
    const loser = first.response.decision === "denied" ? first : second;
    expect(loser.record.reasons.map((reason) => reason.code)).toContain("DUPLICATE_REFUND");
    expect(await requests()).toHaveLength(1);
    expect((await verifyLog(db)).intact).toBe(true);
  });

  it("leaves the history unknown when an execution entry can't be read, so nothing is allowed", async () => {
    const world = beat4World();
    const broken = await appendEntries(db, [
      { entryType: "execution.requested", refId: "int_x", at: NOW.toISOString(), payload: {} },
    ]);
    if (!broken.ok) throw new Error(broken.rejection.detail);

    const result = await propose(world, refund(1035, "18.00", "TKT-1035"), beat4Ticket);
    if (!result.ok) throw new Error(result.detail);

    expect(result.response.decision).not.toBe("allowed");
    expect(result.seqs.request).toBeNull();
    expect(await requests()).toHaveLength(1);
  });
});
