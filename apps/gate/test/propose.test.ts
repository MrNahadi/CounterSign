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
  writeTicket,
} from "@countersign/db";
import { appendEntries, verifyLog } from "@countersign/ledger";
import { hashIntent, parseMandate } from "@countersign/mandate";
import { PayPalError } from "@countersign/rail-paypal";
import { CALLS, type TicketSnapshot } from "@countersign/verifiers";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  ExecutionRequestedPayloadSchema,
  ExecutionResultPayloadSchema,
  executionRequestedEntry,
  executionResultEntry,
} from "../src/execution-log";
import { type ProposeResult, propose as runPropose } from "../src/propose";
import { mandateRef } from "../src/record";
import { createFakeSandbox, httpError } from "./fake-sandbox";

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

// Writes a ticket snapshot's ticket to the store, as Resolve or the propose CLI would.
const storeTicket = (db: Database, snapshot: TicketSnapshot) =>
  writeTicket(db, {
    id: snapshot.id,
    channel: "email",
    senderEmail: snapshot.senderEmail,
    senderPhone: null,
    subject: null,
    body: "Simulated ticket.",
    attachments: [...snapshot.attachments],
    receivedAt: "2026-10-17T08:00:00+03:00",
    simulated: true,
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

describe("propose: deciding on live records under the ledger lock", () => {
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
  const requests = async () =>
    (await entries()).filter((row) => row.entryType === "execution.requested");

  const propose = async (
    world: ReturnType<typeof sandboxWith>,
    proposal: unknown,
    proposalTicket: TicketSnapshot,
  ) => {
    await storeTicket(db, proposalTicket);
    return runPropose({
      mandate,
      principal: PRINCIPAL,
      proposal,
      now: NOW,
      rail: world.rail,
      carrier: world.carrier,
      db,
    });
  };

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
      if (!result.ok || result.replay) throw new Error("not decided");
      expect(result.problems).toEqual([]);
      expect(result.seqs.request).toBeNull();
      expect(result.execution).toBeNull();
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
    if (!result.ok || result.replay) throw new Error("not decided");

    expect(result.response.decision).toBe("allowed");
    expect(result.problems).toEqual([]);
    expect(result.seqs).toEqual({ mandate: 1, decision: 2, request: 3 });

    const rows = await entries();
    expect(rows.map((row) => [row.seq, row.entryType, row.refId])).toEqual([
      [1, "mandate.version", mandateRef(mandate)],
      [2, "decision", result.record.intentId],
      [3, "execution.requested", result.record.intentId],
      [4, "execution.result", result.record.intentId],
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
        target: { captureId: "CAP-1035" },
        amount: usd(500),
        decisionSeq: 1,
      }),
    ]);
    if (!earlier.ok) throw new Error(earlier.rejection.detail);

    const result = await propose(world, refund(1035, "18.00", "TKT-1035"), beat4Ticket);
    if (!result.ok || result.replay) throw new Error("not decided");

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
    if (!first?.ok || !second?.ok || first.replay || second.replay) {
      throw new Error("not decided");
    }

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
    if (!result.ok || result.replay) throw new Error("not decided");

    expect(result.response.decision).not.toBe("allowed");
    expect(result.seqs.request).toBeNull();
    expect(await requests()).toHaveLength(1);
  });
});

describe("propose: executing once, and replays", () => {
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

  const HOUR = 60 * 60 * 1000;
  const later = (ms: number) => new Date(NOW.getTime() + ms);
  const beat4 = refund(1035, "18.00", "TKT-1035");
  // Beat 4's intent, as the gate normalizes it from the live records.
  const beat4Intent = hashIntent({
    principal: PRINCIPAL,
    rail: "paypal",
    action: "paypal.refund",
    amount: usd(1800),
    target: { kind: "capture", captureId: "CAP-1035", orderId: "ORD-1035" },
    ticketId: "TKT-1035",
    claim: "not_received",
    mandateVersion: mandate.version,
  });

  const entries = () => db.select().from(auditLog).orderBy(asc(auditLog.seq));
  const ofType = async (entryType: string) =>
    (await entries()).filter((row) => row.entryType === entryType);
  const results = async () =>
    (await ofType("execution.result")).map((row) =>
      ExecutionResultPayloadSchema.parse(JSON.parse(row.payload)),
    );
  const refundCalls = (world: ReturnType<typeof sandboxWith>) =>
    world.rail.calls.filter((call) => call.call === "refundCapture");

  const propose = async (world: ReturnType<typeof sandboxWith>, now = NOW) => {
    await storeTicket(db, beat4Ticket);
    return runPropose({
      mandate,
      principal: PRINCIPAL,
      proposal: beat4,
      now,
      rail: world.rail,
      carrier: world.carrier,
      db,
      clock: () => now,
    });
  };

  const decided = (result: ProposeResult) => {
    if (!result.ok || result.replay) throw new Error("not decided");
    return result;
  };
  const replayed = (result: ProposeResult) => {
    if (!result.ok || !result.replay) throw new Error("not a replay");
    return result;
  };

  // Beat 4's request, logged earlier with no decision run here, and optionally its result.
  const seedRequest = async (at: Date, outcome?: "unknown" | "failed") => {
    const inputs = [
      executionRequestedEntry({
        at: at.toISOString(),
        intentId: beat4Intent.id,
        intentHash: beat4Intent.hash,
        principal: PRINCIPAL,
        rail: "paypal",
        action: "paypal.refund",
        target: { captureId: "CAP-1035" },
        amount: usd(1800),
        decisionSeq: 1,
      }),
    ];
    if (outcome === "unknown") {
      inputs.push(
        executionResultEntry({
          at: at.toISOString(),
          intentId: beat4Intent.id,
          requestSeq: 1,
          outcome: "unknown",
        }),
      );
    } else if (outcome === "failed") {
      inputs.push(
        executionResultEntry({
          at: at.toISOString(),
          intentId: beat4Intent.id,
          requestSeq: 1,
          outcome: "failed",
          error: { name: "UNPROCESSABLE_ENTITY", issues: [], debugId: "fake-debug" },
        }),
      );
    }
    const seeded = await appendEntries(db, inputs);
    if (!seeded.ok) throw new Error(seeded.rejection.detail);
  };

  it("sends beat 4's refund once, with the intent hash as request ID and the intent ID as custom_id, and logs it executed", async () => {
    const world = beat4World();
    const result = decided(await propose(world));

    expect(result.response).toEqual({
      decision: "allowed",
      intent_id: beat4Intent.id,
      intent_hash: beat4Intent.hash,
    });
    expect(refundCalls(world)).toEqual([
      {
        call: "refundCapture",
        arg: {
          captureId: "CAP-1035",
          amount: usd(1800),
          customId: beat4Intent.id,
          requestId: beat4Intent.hash,
        },
      },
    ]);
    expect(result.execution).toEqual({
      outcome: "executed",
      refund: { id: "FAKEREFUND000001", status: "COMPLETED" },
      error: null,
      resultSeq: 4,
      resultProblem: null,
      sent: true,
    });
    const [row] = await ofType("execution.result");
    expect(row?.refId).toBe(beat4Intent.id);
    expect(await results()).toEqual([
      {
        requestSeq: 3,
        outcome: "executed",
        refund: { id: "FAKEREFUND000001", status: "COMPLETED" },
      },
    ]);
    expect((await verifyLog(db)).intact).toBe(true);
  });

  it("answers beat 4 proposed again with no rail call, only a replay request, and the same allowed response", async () => {
    const world = beat4World();
    const first = decided(await propose(world));
    const before = (await entries()).length;

    const second = replayed(await propose(world, later(60_000)));

    expect(second.response).toEqual(first.response);
    expect(second.firstRequestSeq).toBe(3);
    expect(second.execution).toEqual({
      outcome: "executed",
      refund: { id: "FAKEREFUND000001", status: "COMPLETED" },
      error: null,
      resultSeq: 4,
      resultProblem: null,
      sent: false,
    });
    expect(refundCalls(world)).toHaveLength(1);
    const rows = await entries();
    expect(rows).toHaveLength(before + 1);
    const last = rows.at(-1);
    expect([last?.seq, last?.entryType, last?.refId]).toEqual([
      second.seqs.request,
      "execution.requested",
      beat4Intent.id,
    ]);
    expect(ExecutionRequestedPayloadSchema.parse(JSON.parse(last?.payload ?? ""))).toMatchObject({
      replay: true,
      firstRequestSeq: 3,
      proposal: JSON.stringify(beat4),
      requestId: beat4Intent.hash,
    });
    expect((await verifyLog(db)).intact).toBe(true);
  });

  it("re-sends a request whose result was unknown with the same request ID within 6 hours, and gets the same refund", async () => {
    const world = beat4World();
    world.rail.lostResponses.refundCapture = new PayPalError({
      kind: "network",
      call: "refund-capture",
      status: null,
      reason: "the connection was reset",
    });
    const first = decided(await propose(world));
    expect(first.execution).toMatchObject({ outcome: "unknown", refund: null, resultSeq: 4 });

    delete world.rail.lostResponses.refundCapture;
    const second = replayed(await propose(world, later(5 * HOUR)));

    expect(second.response).toEqual(first.response);
    expect(second.execution).toMatchObject({
      outcome: "executed",
      refund: { id: "FAKEREFUND000001", status: "COMPLETED" },
      sent: true,
    });
    const calls = refundCalls(world);
    expect(calls).toHaveLength(2);
    expect(calls.map((call) => (call.arg as { requestId: string }).requestId)).toEqual([
      beat4Intent.hash,
      beat4Intent.hash,
    ]);
    expect(world.rail.refunds.size).toBe(1);
    expect((await results()).map((result) => [result.requestSeq, result.outcome])).toEqual([
      [3, "unknown"],
      [second.seqs.request, "executed"],
    ]);
    expect((await verifyLog(db)).intact).toBe(true);
  });

  it("re-sends a request that has no result yet within 6 hours", async () => {
    const world = beat4World();
    await seedRequest(later(-HOUR));

    const result = replayed(await propose(world));

    expect(result.firstRequestSeq).toBe(1);
    expect(result.execution).toMatchObject({ outcome: "executed", sent: true });
    expect(refundCalls(world).map((call) => call.arg)).toEqual([
      {
        captureId: "CAP-1035",
        amount: usd(1800),
        customId: beat4Intent.id,
        requestId: beat4Intent.hash,
      },
    ]);
    expect((await verifyLog(db)).intact).toBe(true);
  });

  it.each([
    ["no result", undefined],
    ["an unknown result", "unknown"],
    ["a failed result", "failed"],
  ] as const)(
    "sends nothing after 6 hours for a request with %s, and denies DUPLICATE_REFUND naming it",
    async (_, outcome) => {
      const world = beat4World();
      await seedRequest(later(-6 * HOUR - 1000), outcome);
      const requestsBefore = (await ofType("execution.requested")).length;

      const result = decided(await propose(world));

      expect(result.response.decision).toBe("denied");
      expect(result.record.reasons.map((reason) => reason.code)).toEqual(["DUPLICATE_REFUND"]);
      expect(result.record.reasons[0]?.detail).toContain("#1");
      expect(result.record.reasons[0]?.detail).toContain("npm run reconcile");
      expect(result.execution).toBeNull();
      expect(refundCalls(world)).toHaveLength(0);
      // Logged as a decision, and no replay request, so a failed intent doesn't block its
      // capture again.
      expect((await ofType("execution.requested")).length).toBe(requestsBefore);
      expect((await entries()).at(-1)?.entryType).toBe("decision");
      expect((await verifyLog(db)).intact).toBe(true);
    },
  );

  it("re-sends nothing for a refused intent once another intent has executed on its capture", async () => {
    const world = beat4World();
    await seedRequest(later(-HOUR), "failed");
    const otherId = `int_${"b".repeat(24)}`;
    const other = await appendEntries(db, [
      executionRequestedEntry({
        at: later(-30 * 60_000).toISOString(),
        intentId: otherId,
        intentHash: "b".repeat(64),
        principal: PRINCIPAL,
        rail: "paypal",
        action: "paypal.refund",
        target: { captureId: "CAP-1035" },
        amount: usd(500),
        decisionSeq: 1,
      }),
      executionResultEntry({
        at: later(-30 * 60_000).toISOString(),
        intentId: otherId,
        requestSeq: 3,
        outcome: "executed",
        refund: { id: "OTHERREFUND00001", status: "COMPLETED" },
      }),
    ]);
    if (!other.ok) throw new Error(other.rejection.detail);
    const requestsBefore = (await ofType("execution.requested")).length;

    const result = decided(await propose(world));

    expect(result.response.decision).toBe("denied");
    expect(result.record.reasons.map((reason) => reason.code)).toEqual(["DUPLICATE_REFUND"]);
    expect(result.record.reasons[0]?.detail).toContain(otherId);
    expect(result.execution).toBeNull();
    expect(refundCalls(world)).toHaveLength(0);
    expect((await ofType("execution.requested")).length).toBe(requestsBefore);
    expect((await verifyLog(db)).intact).toBe(true);
  });

  it("re-sends a refused intent within 6 hours when nothing else has executed on its capture", async () => {
    const world = beat4World();
    await seedRequest(later(-HOUR), "failed");

    const result = replayed(await propose(world));

    expect(result.execution).toMatchObject({ outcome: "executed", sent: true });
    expect(refundCalls(world)).toHaveLength(1);
  });

  it("logs a 4xx refusal as failed, with PayPal's name, issues and debug ID", async () => {
    const world = beat4World();
    world.rail.failures.refundCapture = new PayPalError({
      kind: "http",
      call: "refund-capture",
      status: 422,
      paypalName: "UNPROCESSABLE_ENTITY",
      issues: ["CAPTURE_FULLY_REFUNDED"],
      debugId: "fake-debug",
    });

    const result = decided(await propose(world));

    const error = {
      name: "UNPROCESSABLE_ENTITY",
      issues: ["CAPTURE_FULLY_REFUNDED"],
      debugId: "fake-debug",
    };
    expect(result.execution).toMatchObject({ outcome: "failed", refund: null, error });
    expect(await results()).toEqual([{ requestSeq: 3, outcome: "failed", error }]);
    expect((await verifyLog(db)).intact).toBe(true);
  });

  it("logs a refund PayPal returns as FAILED as failed, with the refund", async () => {
    const world = beat4World();
    world.rail.refundStatus = "FAILED";

    const result = decided(await propose(world));

    const refunded = { id: "FAKEREFUND000001", status: "FAILED" };
    expect(result.execution).toMatchObject({ outcome: "failed", refund: refunded });
    expect(await results()).toEqual([{ requestSeq: 3, outcome: "failed", refund: refunded }]);
  });

  it.each([
    ["a network error", new PayPalError({ kind: "network", call: "refund-capture", status: null })],
    [
      "an unparseable answer",
      new PayPalError({ kind: "invalid_response", call: "refund-capture", status: 201 }),
    ],
    ["a 5xx after retries", httpError("refund-capture", 503, "SERVICE_UNAVAILABLE")],
    ["an unexpected throw", new Error("boom")],
  ])("logs %s as unknown", async (_, failure) => {
    const world = beat4World();
    world.rail.failures.refundCapture = failure;

    const result = decided(await propose(world));

    expect(result.execution).toMatchObject({ outcome: "unknown", refund: null, resultSeq: 4 });
    expect((await results()).map((r) => r.outcome)).toEqual(["unknown"]);
    expect((await verifyLog(db)).intact).toBe(true);
  });
});
