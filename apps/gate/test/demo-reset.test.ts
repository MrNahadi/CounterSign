// The demo reset's core (T-007): the checks that refuse it, the order check, the replacement
// orders and the clear that starts the new log with `demo.reset`.

import {
  agentRuns,
  auditLog,
  createTestDatabase,
  type Database,
  type DatabaseHandle,
  disputeDrafts,
  seedOrders,
  sql,
  tickets,
} from "@countersign/db";
import { appendEntries, type EntryInput, verifyLog } from "@countersign/ledger";
import { SHIPMENT_STATUSES } from "@countersign/mandate";
import { RAIL_WORST_CALL_MS } from "@countersign/rail-paypal";
import {
  DEMO_ORDERS,
  type DemoOrder,
  SAME_BUYER_PROBLEM,
  type SeedReport,
} from "@countersign/seed";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  checkSeedOrders,
  EXECUTION_WINDOW_MS,
  RESET_COOLDOWN_MS,
  RESET_MESSAGES,
  type Reseed,
  type ResetDeps,
  resetDemo,
} from "../src/demo-reset";
import { executionRequestedEntry, executionResultEntry } from "../src/execution-log";
import { MAX_RAIL_CALLS_PER_EXECUTION } from "../src/executors";
import { createFakeSandbox, type FakeSandbox } from "./fake-sandbox";

// Each PGlite start takes a couple of seconds.
const SLOW = 60_000;

const START = new Date("2026-10-20T12:00:00.000Z");
const OLD_RUN = "20261001oldrun";
const SUFFIX = "k3x9qa";
const NEW_RUN = `20261020${SUFFIX}`;

const ENV = {
  PAYPAL_BASE_URL: "https://api-m.sandbox.paypal.com",
  PAYPAL_CLIENT_ID: "illustrative-client-id",
  PAYPAL_CLIENT_SECRET: "illustrative-client-secret",
  PAYPAL_SEED_VAULT_TOKEN: "illustrative-vault-a",
  PAYPAL_SEED_VAULT_TOKEN_B: "illustrative-vault-b",
  RESOLVE_AGENT_URL: "http://resolve.test:8788",
};

const capOf = (orderNumber: string, runId = OLD_RUN) => `CAP-${runId}-${orderNumber}`;
const usd = (minor: number) => ({ minor, currency: "USD" as const });

const rowFor = (demo: DemoOrder, runId = OLD_RUN) => ({
  orderNumber: demo.orderNumber,
  runId,
  paypalOrderId: `ORD-${runId}-${demo.orderNumber}`,
  paypalCaptureId: capOf(demo.orderNumber, runId),
  amountMinor: 1800,
  currency: "USD",
  payerEmail: `buyer-${demo.buyer.toLowerCase()}@example.com`,
  buyer: demo.buyer,
  trackingNumber: `TRK-${runId}-${demo.orderNumber}`,
  role: demo.role,
  seededAt: "2026-10-01T09:00:00.000Z",
});

const emptyCounts = () =>
  Object.fromEntries(SHIPMENT_STATUSES.map((status) => [status, 0])) as SeedReport["counts"];

// An intent ID and hash for execution entries.
const hashOf = (n: number) => n.toString(16).padEnd(64, "b");
const intentId = (n: number) => `int_${hashOf(n).slice(0, 24)}`;

const decision = (n: number): EntryInput => ({
  entryType: "decision",
  refId: intentId(n),
  at: "2026-10-20T11:00:00.000Z",
  payload: { note: "illustrative decision" },
});

const refundRequest = (n: number, captureId: string, at: string): EntryInput =>
  executionRequestedEntry({
    at,
    intentId: intentId(n),
    intentHash: hashOf(n),
    principal: "agent:resolve",
    rail: "paypal",
    amount: usd(1800),
    action: "paypal.refund",
    target: { captureId },
    decisionSeq: 1,
  });

const evidenceRequest = (n: number, at: string): EntryInput =>
  executionRequestedEntry({
    at,
    intentId: intentId(n),
    intentHash: hashOf(n),
    principal: "agent:resolve",
    rail: "paypal",
    amount: usd(24000),
    action: "paypal.dispute.provide_evidence",
    target: { disputeId: "PP-D-1" },
    approvalSeq: 1,
  });

const executedResult = (n: number, requestSeq: number): EntryInput =>
  executionResultEntry({
    at: "2026-10-20T11:01:00.000Z",
    intentId: intentId(n),
    requestSeq,
    outcome: "executed",
    refund: { id: `REF-${n}`, status: "COMPLETED" },
  });

const failedResult = (n: number, requestSeq: number): EntryInput =>
  executionResultEntry({
    at: "2026-10-20T11:01:00.000Z",
    intentId: intentId(n),
    requestSeq,
    outcome: "failed",
    error: { name: "UNPROCESSABLE_ENTITY", issues: ["CAPTURE_FULLY_REFUNDED"], debugId: "f00d" },
  });

const unreadableRequest: EntryInput = {
  entryType: "execution.requested",
  refId: intentId(9),
  at: "2026-10-20T11:00:00.000Z",
  payload: { intentId: intentId(9), principal: "agent:resolve" },
};

const unreadableResult: EntryInput = {
  entryType: "execution.result",
  refId: intentId(1),
  at: "2026-10-20T11:00:00.000Z",
  payload: { outcome: "executed" },
};

const resetEntry = (at: string): EntryInput => ({
  entryType: "demo.reset",
  refId: null,
  at,
  payload: {
    previous_head: null,
    cleared: { entries: 0, tickets: 0, attachments: 0, runs: 0, drafts: 0, documents: 0 },
  },
});

async function append(db: Database, ...entries: EntryInput[]) {
  const result = await appendEntries(db, entries);
  if (!result.ok) throw new Error(`append refused: ${result.rejection.detail}`);
  return result.entries;
}

describe("resetDemo", () => {
  let handle: DatabaseHandle;
  let db: Database;
  let rail: FakeSandbox;
  let now: Date;
  let reseeds: { orders: string[]; runId: string; seededAt: string }[];

  // Records its input, writes a seed row for each order and adds its capture to the sandbox.
  const recordingReseed: Reseed = async ({ orders, runId, seededAt }) => {
    reseeds.push({ orders: orders.map((o) => o.orderNumber), runId, seededAt });
    for (const demo of orders) {
      const row = { ...rowFor(demo, runId), seededAt };
      await db
        .insert(seedOrders)
        .values(row)
        .onConflictDoUpdate({ target: seedOrders.orderNumber, set: row });
      rail.captures.set(row.paypalCaptureId, {
        id: row.paypalCaptureId,
        status: "COMPLETED",
        amount: usd(1800),
        orderId: row.paypalOrderId,
      });
    }
    return {
      runId,
      total: orders.length,
      seeded: orders.length,
      counts: emptyCounts(),
      failures: [],
      problem: null,
    };
  };

  const deps = (extra: Partial<ResetDeps> = {}): ResetDeps => ({
    db,
    rail: () => rail,
    env: ENV,
    clock: () => now,
    reseed: recordingReseed,
    randomSuffix: () => SUFFIX,
    ...extra,
  });

  // Every catalog order seeded under the old run, each capture COMPLETED.
  async function seedAll() {
    for (const demo of DEMO_ORDERS) {
      const row = rowFor(demo);
      await db.insert(seedOrders).values(row);
      rail.captures.set(row.paypalCaptureId, {
        id: row.paypalCaptureId,
        status: "COMPLETED",
        amount: usd(1800),
        orderId: row.paypalOrderId,
      });
    }
  }

  async function logRows() {
    return db.select().from(auditLog).orderBy(auditLog.seq);
  }

  async function seedRows() {
    return db.select().from(seedOrders).orderBy(seedOrders.orderNumber);
  }

  const insertRun = (id: string, status: string, queuedAt: string) =>
    db.insert(agentRuns).values({
      id,
      ticketId: "tkt_illustrative",
      threadId: "thr_illustrative",
      mode: "protected",
      model: "illustrative-model",
      modelVersions: [],
      status,
      queuedAt,
    });

  const insertTicket = () =>
    db.insert(tickets).values({
      id: "tkt_illustrative",
      channel: "email",
      senderEmail: "buyer-a@example.com",
      body: "Illustrative message.",
      attachments: [],
      receivedAt: "2026-10-20T11:00:00.000Z",
      simulated: true,
      threadId: "thr_illustrative",
    });

  beforeAll(async () => {
    handle = await createTestDatabase();
    db = handle.db;
  }, SLOW);

  beforeEach(async () => {
    await db.execute(
      sql`TRUNCATE audit_log, tickets, ticket_attachments, agent_runs, dispute_drafts, evidence_documents, seed_orders, cleared_run_counts`,
    );
    rail = createFakeSandbox();
    now = START;
    reseeds = [];
  });

  afterAll(async () => {
    await handle.close();
  });

  describe("the replacement and the clear", () => {
    it("replaces all 30 on an empty database and writes entry 1 demo.reset with no previous head", async () => {
      const result = await resetDemo(deps());
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const { report } = result;
      expect(report.resetAt).toBe(START.toISOString());
      expect(report.orders.kept).toBe(0);
      expect(report.orders.replaced).toEqual(DEMO_ORDERS.map((o) => o.orderNumber));
      expect(report.orders.replaced).toHaveLength(30);
      expect(report.orders.runId).toBe(NEW_RUN);
      expect(report.orders.failed).toEqual([]);
      expect(reseeds).toEqual([
        {
          orders: DEMO_ORDERS.map((o) => o.orderNumber),
          runId: NEW_RUN,
          seededAt: START.toISOString(),
        },
      ]);
      expect(report.cleared).toEqual({
        previousHead: null,
        entries: 0,
        tickets: 0,
        attachments: 0,
        runs: 0,
        drafts: 0,
        documents: 0,
      });

      const rows = await logRows();
      expect(rows).toHaveLength(1);
      expect(rows[0]?.seq).toBe(1);
      expect(rows[0]?.entryType).toBe("demo.reset");
      expect(rows[0]?.refId).toBeNull();
      expect(rows[0]?.at).toBe(START.toISOString());
      expect(JSON.parse(rows[0]?.payload ?? "")).toEqual({
        previous_head: null,
        cleared: { entries: 0, tickets: 0, attachments: 0, runs: 0, drafts: 0, documents: 0 },
      });
      expect((await verifyLog(db)).intact).toBe(true);
    });

    it("keeps all 30 when every seeded capture is COMPLETED and untouched, and records the old head", async () => {
      await seedAll();
      await insertTicket();
      await insertRun("run_done", "replied", "2026-10-20T10:00:00.000Z");
      const [first, second] = await append(db, decision(1), decision(2));
      const result = await resetDemo(deps());
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.report.orders).toEqual({ kept: 30, replaced: [], runId: null, failed: [] });
      expect(reseeds).toEqual([]);
      expect(rail.calls.filter((c) => c.call === "getCapture")).toHaveLength(30);
      expect(first?.seq).toBe(1);
      expect(result.report.cleared).toEqual({
        previousHead: { seq: 2, hash: second?.hash },
        entries: 2,
        tickets: 1,
        attachments: 0,
        runs: 1,
        drafts: 0,
        documents: 0,
      });

      const rows = await logRows();
      expect(rows).toHaveLength(1);
      expect(JSON.parse(rows[0]?.payload ?? "")).toEqual({
        previous_head: { seq: 2, hash: second?.hash },
        cleared: { entries: 2, tickets: 1, attachments: 0, runs: 1, drafts: 0, documents: 0 },
      });
      expect(await db.select().from(tickets)).toEqual([]);
      expect(await db.select().from(agentRuns)).toEqual([]);
      expect(await seedRows()).toHaveLength(30);
      expect((await verifyLog(db)).intact).toBe(true);
    });

    it("replaces a refunded capture, a failed capture read, a missing row, the wrong buyer and requested captures in one run", async () => {
      await seedAll();
      const [refunded, unread, missing, wrongBuyer, executed, failed, evidence] = DEMO_ORDERS;
      if (!refunded || !unread || !missing || !wrongBuyer || !executed || !failed || !evidence)
        throw new Error("the catalog is short");
      rail.captures.set(capOf(refunded.orderNumber), {
        id: capOf(refunded.orderNumber),
        status: "REFUNDED",
        amount: usd(1800),
        orderId: null,
      });
      rail.captures.delete(capOf(unread.orderNumber));
      await db.delete(seedOrders).where(sql`${seedOrders.orderNumber} = ${missing.orderNumber}`);
      await db
        .update(seedOrders)
        .set({ buyer: wrongBuyer.buyer === "A" ? "B" : "A" })
        .where(sql`${seedOrders.orderNumber} = ${wrongBuyer.orderNumber}`);
      // Older than the 10-minute window, each with a result, and an evidence submission, which
      // names no capture.
      await append(
        db,
        decision(1),
        refundRequest(1, capOf(executed.orderNumber), "2026-10-20T11:00:00.000Z"),
        executedResult(1, 2),
        refundRequest(2, capOf(failed.orderNumber), "2026-10-20T11:00:00.000Z"),
        failedResult(2, 4),
        evidenceRequest(3, "2026-10-20T11:00:00.000Z"),
      );

      const result = await resetDemo(deps());
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const touched = new Set([refunded, unread, missing, wrongBuyer, executed, failed]);
      const expected = DEMO_ORDERS.filter((o) => touched.has(o)).map((o) => o.orderNumber);
      expect(result.report.orders.replaced).toEqual(expected);
      expect(result.report.orders.kept).toBe(24);
      expect(result.report.orders.runId).toBe(NEW_RUN);
      expect(reseeds).toHaveLength(1);
      expect(reseeds[0]?.orders).toEqual(expected);
      expect(result.report.orders.replaced).not.toContain(evidence.orderNumber);
      // Captures with execution history are never read; the rest are.
      const read = rail.calls.filter((c) => c.call === "getCapture").map((c) => c.arg);
      expect(read).not.toContain(capOf(executed.orderNumber));
      expect(read).not.toContain(capOf(failed.orderNumber));
      expect(read).toContain(capOf(evidence.orderNumber));

      const rows = await seedRows();
      for (const row of rows) {
        expect(row.runId).toBe(expected.includes(row.orderNumber) ? NEW_RUN : OLD_RUN);
      }
      expect(rows).toHaveLength(30);
      expect((await logRows())[0]?.entryType).toBe("demo.reset");
      expect((await verifyLog(db)).intact).toBe(true);
    });

    it("doesn't block on an unanswered request older than 10 minutes, and replaces its capture", async () => {
      await seedAll();
      const [demo] = DEMO_ORDERS;
      if (!demo) throw new Error("the catalog is empty");
      const old = new Date(START.getTime() - EXECUTION_WINDOW_MS - 1000).toISOString();
      await append(db, decision(1), refundRequest(1, capOf(demo.orderNumber), old));
      const result = await resetDemo(deps());
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.report.orders.replaced).toEqual([demo.orderNumber]);
    });

    it("an older demo.reset at entry 1 doesn't block", async () => {
      await append(db, resetEntry(new Date(START.getTime() - RESET_COOLDOWN_MS).toISOString()));
      const result = await resetDemo(deps());
      expect(result.ok).toBe(true);
    });
  });

  describe("refusals before any PayPal call", () => {
    async function expectRefusedUnchanged(status: number, message: string, extra = {}) {
      const logBefore = await logRows();
      const seedBefore = await seedRows();
      const result = await resetDemo(deps(extra));
      expect(result).toEqual({ ok: false, status, message });
      expect(rail.calls).toEqual([]);
      expect(reseeds).toEqual([]);
      expect(await logRows()).toEqual(logBefore);
      expect(await seedRows()).toEqual(seedBefore);
    }

    beforeEach(async () => {
      await seedAll();
    });

    it("refuses a queued run", async () => {
      await insertRun("run_queued", "queued", "2026-10-20T11:59:00.000Z");
      await expectRefusedUnchanged(409, RESET_MESSAGES.resolveBusy);
    });

    it("refuses a running draft", async () => {
      await db.insert(disputeDrafts).values({
        id: "drf_running",
        disputeId: "PP-D-1",
        status: "running",
        model: "illustrative-model",
        modelVersions: [],
        queuedAt: "2026-10-20T11:59:00.000Z",
      });
      await expectRefusedUnchanged(409, RESET_MESSAGES.resolveBusy);
    });

    it("refuses an unanswered execution request from the last 10 minutes", async () => {
      const [demo] = DEMO_ORDERS;
      if (!demo) throw new Error("the catalog is empty");
      const recent = new Date(START.getTime() - EXECUTION_WINDOW_MS + 1000).toISOString();
      await append(db, decision(1), refundRequest(1, capOf(demo.orderNumber), recent));
      await expectRefusedUnchanged(409, RESET_MESSAGES.executing);
    });

    it("refuses an unreadable execution result", async () => {
      await append(db, decision(1), unreadableResult);
      await expectRefusedUnchanged(409, RESET_MESSAGES.executing);
    });

    // ADR 0046: the busy check reads requests with the same schema as the order check, so an
    // unreadable request refuses here; the order check's unknown branch is tested directly below.
    it("refuses an unreadable execution request", async () => {
      await append(db, decision(1), unreadableRequest);
      await expectRefusedUnchanged(409, RESET_MESSAGES.executing);
    });

    it("refuses a reset less than a minute after the last", async () => {
      await append(db, resetEntry(new Date(START.getTime() - RESET_COOLDOWN_MS + 1).toISOString()));
      await expectRefusedUnchanged(409, RESET_MESSAGES.justReset);
    });

    it("refuses a second reset in the same process", async () => {
      // A refunded capture, so the first reset waits in its reseed.
      const [demo] = DEMO_ORDERS;
      if (!demo) throw new Error("the catalog is empty");
      rail.captures.delete(capOf(demo.orderNumber));
      let release: () => void = () => {};
      let entered: () => void = () => {};
      const inReseed = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const first = resetDemo(
        deps({
          reseed: async (input) => {
            entered();
            await held;
            return recordingReseed(input);
          },
        }),
      );
      await inReseed;
      const callsBefore = rail.calls.length;
      const second = await resetDemo(deps());
      expect(second).toEqual({ ok: false, status: 409, message: RESET_MESSAGES.running });
      expect(rail.calls.length).toBe(callsBefore);
      release();
      expect((await first).ok).toBe(true);
      // The flag is cleared once the first finishes.
      now = new Date(START.getTime() + RESET_COOLDOWN_MS);
      expect((await resetDemo(deps())).ok).toBe(true);
    });

    it("refuses 503 without a database", async () => {
      const result = await resetDemo({ ...deps(), db: undefined });
      expect(result).toEqual({ ok: false, status: 503, message: RESET_MESSAGES.noDatabase });
      expect(rail.calls).toEqual([]);
    });

    it("refuses 503 when a PayPal variable is missing", async () => {
      const { PAYPAL_CLIENT_SECRET: _, ...env } = ENV;
      await expectRefusedUnchanged(503, RESET_MESSAGES.noPayPal, { env });
    });

    it("refuses 503 when the rail can't be built", async () => {
      await expectRefusedUnchanged(503, RESET_MESSAGES.noPayPal, {
        rail: () => {
          throw new Error("no rail");
        },
      });
    });

    it("refuses 503 naming only the missing vault variables", async () => {
      const { PAYPAL_SEED_VAULT_TOKEN_B: _, ...env } = ENV;
      const message = RESET_MESSAGES.noVault(["PAYPAL_SEED_VAULT_TOKEN_B"]);
      expect(message).toBe("Set PAYPAL_SEED_VAULT_TOKEN_B on the gate to reset the demo.");
      expect(message).not.toContain(ENV.PAYPAL_SEED_VAULT_TOKEN);
      await expectRefusedUnchanged(503, message, { env });
      const { PAYPAL_SEED_VAULT_TOKEN: __, ...neither } = env;
      await expectRefusedUnchanged(
        503,
        "Set PAYPAL_SEED_VAULT_TOKEN and PAYPAL_SEED_VAULT_TOKEN_B on the gate to reset the demo.",
        { env: neither },
      );
    });
  });

  describe("a failed replacement clears nothing", () => {
    beforeEach(async () => {
      await seedAll();
      await insertTicket();
      await insertRun("run_done", "replied", "2026-10-20T10:00:00.000Z");
      await append(db, decision(1));
      const [a, b] = DEMO_ORDERS;
      if (!a || !b) throw new Error("the catalog is short");
      rail.captures.delete(capOf(a.orderNumber));
      rail.captures.delete(capOf(b.orderNumber));
    });

    async function expectNothingCleared(reseed: Reseed) {
      const logBefore = await logRows();
      const result = await resetDemo(deps({ reseed }));
      expect(result.ok).toBe(true);
      if (!result.ok) return null;
      expect(result.report.complete).toBe(false);
      expect(result.report.cleared).toBeNull();
      expect(result.report.disputes).toBeNull();
      expect(await logRows()).toEqual(logBefore);
      expect(await db.select().from(tickets)).toHaveLength(1);
      expect(await db.select().from(agentRuns)).toHaveLength(1);
      return result.report;
    }

    it("reports a seed failure", async () => {
      const report = await expectNothingCleared(async ({ orders, runId }) => ({
        runId,
        total: orders.length,
        seeded: orders.length - 1,
        counts: emptyCounts(),
        failures: [
          {
            orderNumber: orders[0]?.orderNumber ?? "",
            call: "create-order",
            reason: "returned HTTP 422",
            debugId: "abc",
          },
        ],
        problem: null,
      }));
      expect(report?.orders.failed).toEqual([
        {
          orderNumber: DEMO_ORDERS[0]?.orderNumber,
          call: "create-order",
          reason: "returned HTTP 422",
        },
      ]);
      expect(report?.orders.replaced).toHaveLength(2);
    });

    it("fails every replaced order on a seed problem", async () => {
      const report = await expectNothingCleared(async ({ orders, runId }) => ({
        runId,
        total: orders.length,
        seeded: 0,
        counts: emptyCounts(),
        failures: [],
        problem: SAME_BUYER_PROBLEM,
      }));
      expect(report?.orders.failed).toEqual(
        DEMO_ORDERS.slice(0, 2).map((o) => ({
          orderNumber: o.orderNumber,
          call: "seed",
          reason: SAME_BUYER_PROBLEM,
        })),
      );
    });

    it("fails every replaced order when the reseed throws", async () => {
      const report = await expectNothingCleared(async () => {
        throw new Error("boom");
      });
      expect(report?.orders.failed).toEqual(
        DEMO_ORDERS.slice(0, 2).map((o) => ({
          orderNumber: o.orderNumber,
          call: "seed",
          reason: "the seed run failed unexpectedly",
        })),
      );
      expect(report?.orders.runId).toBe(NEW_RUN);
    });
  });

  it("the execution window outlasts the longest execution", () => {
    expect(EXECUTION_WINDOW_MS).toBeGreaterThan(MAX_RAIL_CALLS_PER_EXECUTION * RAIL_WORST_CALL_MS);
  });
});

describe("checkSeedOrders", () => {
  const rows = DEMO_ORDERS.map((demo) => rowFor(demo));

  it("replaces all 30 without reading a capture when the execution history is unknown", async () => {
    const reads: string[] = [];
    const result = await checkSeedOrders({
      rows,
      requested: { known: false, seq: 3, detail: "execution.requested #3 can't be read" },
      getCapture: async (id) => {
        reads.push(id);
        return { status: "COMPLETED" };
      },
    });
    expect(result.kept).toEqual([]);
    expect(result.replaced).toEqual([...DEMO_ORDERS]);
    expect(reads).toEqual([]);
  });

  it("reads at most 3 captures at once", async () => {
    let inFlight = 0;
    let most = 0;
    const result = await checkSeedOrders({
      rows,
      requested: { known: true, captureIds: new Set() },
      getCapture: async () => {
        inFlight += 1;
        most = Math.max(most, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 1));
        inFlight -= 1;
        return { status: "COMPLETED" };
      },
    });
    expect(result.kept).toHaveLength(30);
    expect(most).toBe(3);
  });

  it("replaces a row that fails the stored-row rules", async () => {
    const [first, ...rest] = rows;
    if (!first) throw new Error("no rows");
    const result = await checkSeedOrders({
      rows: [{ ...first, seededAt: "yesterday" }, ...rest],
      requested: { known: true, captureIds: new Set() },
      getCapture: async () => ({ status: "COMPLETED" }),
    });
    expect(result.replaced.map((o) => o.orderNumber)).toEqual([first.orderNumber]);
  });
});
