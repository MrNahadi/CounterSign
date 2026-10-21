import { createTestDatabase, type Database, type DatabaseHandle, sql } from "@countersign/db";
import { appendEntries, type EntryInput, verifyLog, withAuditLog } from "@countersign/ledger";
import { CALLS } from "@countersign/verifiers";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  ExecutionRequestedPayloadSchema,
  ExecutionResultPayloadSchema,
  executionRequestedEntry,
  executionResultEntry,
  ReconciliationPayloadSchema,
  readExecutionHistory,
  readIntentRecord,
  readReconcileWork,
  readReconciliationState,
  reconciliationEntry,
} from "../src/execution-log";
import { intentIdOf, PHASE_8_LOG, PHASE_8_READS } from "./fixtures/phase8-execution-log";

// Each PGlite start takes a couple of seconds.
const SLOW = 60_000;

const T1 = "2026-10-18T09:00:00.000Z";
const T2 = "2026-10-18T09:00:05.000Z";
const T3 = "2026-10-18T10:00:00.000Z";

const hashOf = (n: number) => n.toString(16).padEnd(64, "a");
const intentId = (n: number) => `int_${hashOf(n).slice(0, 24)}`;

const request = (n: number, decisionSeq: number, at = T1): EntryInput =>
  executionRequestedEntry({
    at,
    intentId: intentId(n),
    intentHash: hashOf(n),
    principal: "agent:resolve",
    rail: "paypal",
    action: "paypal.refund",
    target: { captureId: `CAP-${n}` },
    amount: { minor: 1800 * n, currency: "USD" },
    decisionSeq,
  });

const replay = (n: number, firstRequestSeq: number, at = T3): EntryInput =>
  executionRequestedEntry({
    at,
    intentId: intentId(n),
    intentHash: hashOf(n),
    principal: "agent:resolve",
    rail: "paypal",
    action: "paypal.refund",
    target: { captureId: `CAP-${n}` },
    amount: { minor: 1800 * n, currency: "USD" },
    replayOf: { firstRequestSeq, proposal: { action: "create_refund", note: "illustrative" } },
  });

const executed = (n: number, requestSeq: number): EntryInput =>
  executionResultEntry({
    at: T2,
    intentId: intentId(n),
    requestSeq,
    outcome: "executed",
    refund: { id: `REF-${n}`, status: "COMPLETED" },
  });

const failed = (n: number, requestSeq: number): EntryInput =>
  executionResultEntry({
    at: T2,
    intentId: intentId(n),
    requestSeq,
    outcome: "failed",
    error: { name: "UNPROCESSABLE_ENTITY", issues: ["CAPTURE_FULLY_REFUNDED"], debugId: "f00d" },
  });

const unknownResult = (n: number, requestSeq: number): EntryInput =>
  executionResultEntry({ at: T2, intentId: intentId(n), requestSeq, outcome: "unknown" });

// An invoice send approved by the `approval` entry at `approvalSeq` (ADR 0033).
const invoiceRequest = (n: number, approvalSeq: number): EntryInput =>
  executionRequestedEntry({
    at: T1,
    intentId: intentId(n),
    intentHash: hashOf(n),
    principal: "agent:resolve",
    rail: "paypal",
    action: "paypal.invoice.send",
    target: { invoiceId: `INV2-${n}` },
    amount: { minor: 2500, currency: "USD" },
    approvalSeq,
  });

const invoiceSent = (n: number, requestSeq: number, status: "SENT" | "SCHEDULED"): EntryInput =>
  executionResultEntry({
    at: T2,
    intentId: intentId(n),
    requestSeq,
    outcome: "executed",
    invoice: { id: `INV2-${n}`, status },
  });

const invoiceSnapshot = (n: number) => ({
  call: CALLS.executions,
  id: intentId(n),
  principal: "agent:resolve",
  captureId: null,
  amount: { minor: 2500, currency: "USD" },
  executedAt: T1,
});

// Any entry before the executions, so seqs in the tests read as the log would hold them.
const decision = (n: number): EntryInput => ({
  entryType: "decision",
  refId: intentId(n),
  at: T1,
  payload: { note: "illustrative decision" },
});

const snapshot = (n: number, at = T1) => ({
  call: CALLS.executions,
  id: intentId(n),
  principal: "agent:resolve",
  captureId: `CAP-${n}`,
  amount: { minor: 1800 * n, currency: "USD" },
  executedAt: at,
});

describe("execution entries and the execution history", () => {
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

  const append = async (...inputs: EntryInput[]) => {
    const result = await appendEntries(db, inputs);
    if (!result.ok) throw new Error(`append rejected: ${result.rejection.detail}`);
    return result.entries;
  };

  describe("the writers", () => {
    it("build entries of all three types that append, and the log verifies", async () => {
      const rows = await append(
        decision(1),
        request(1, 1),
        executed(1, 2),
        reconciliationEntry({
          at: T3,
          intentId: intentId(1),
          source: "webhook",
          event: { id: "WH-1", type: "PAYMENT.CAPTURE.REFUNDED" },
          refund: {
            id: "REF-1",
            captureId: "CAP-1",
            status: "COMPLETED",
            amount: { minor: 1800, currency: "USD" },
          },
          resultSeq: 3,
        }),
        reconciliationEntry({
          at: T3,
          intentId: null,
          source: "poll",
          refund: {
            id: "REF-9",
            captureId: null,
            status: "PENDING",
            amount: { minor: 500, currency: "USD" },
          },
          resultSeq: null,
        }),
      );
      expect(rows.map((row) => [row.entryType, row.refId])).toEqual([
        ["decision", intentId(1)],
        ["execution.requested", intentId(1)],
        ["execution.result", intentId(1)],
        ["reconciliation", intentId(1)],
        ["reconciliation", null],
      ]);
      expect(await verifyLog(db)).toMatchObject({ intact: true, entries: 5 });
    });

    it("write the request ID as the intent hash, and the payloads match their schemas", () => {
      const entry = request(1, 4);
      expect(entry.payload).toEqual({
        intentId: intentId(1),
        intentHash: hashOf(1),
        principal: "agent:resolve",
        rail: "paypal",
        action: "paypal.refund",
        captureId: "CAP-1",
        target: { captureId: "CAP-1" },
        amount: { minor: 1800, currency: "USD" },
        requestId: hashOf(1),
        replay: false,
        decisionSeq: 4,
      });
      expect(ExecutionRequestedPayloadSchema.safeParse(entry.payload).success).toBe(true);
      expect(ExecutionRequestedPayloadSchema.safeParse(replay(1, 2).payload).success).toBe(true);
      expect(ExecutionResultPayloadSchema.safeParse(executed(1, 2).payload).success).toBe(true);
      expect(ExecutionResultPayloadSchema.safeParse(failed(1, 2).payload).success).toBe(true);
      expect(ExecutionResultPayloadSchema.safeParse(unknownResult(1, 2).payload).success).toBe(
        true,
      );
    });

    it("keep a replay's raw proposal as text", () => {
      expect(replay(1, 2).payload).toMatchObject({
        replay: true,
        firstRequestSeq: 2,
        proposal: '{"action":"create_refund","note":"illustrative"}',
        proposalTruncated: false,
      });
    });

    it("refuse to build a payload ADR 0026 doesn't allow", () => {
      const base = { at: T2, intentId: intentId(1), requestSeq: 2 };
      expect(() =>
        executionResultEntry({
          ...base,
          outcome: "executed",
          refund: { id: "REF-1", status: "FAILED" },
        } as never),
      ).toThrow();
      expect(() => executionResultEntry({ ...base, outcome: "failed" })).toThrow();
      expect(() =>
        executionRequestedEntry({
          at: T1,
          intentId: intentId(1),
          intentHash: hashOf(1),
          principal: "agent:resolve",
          rail: "paypal",
          action: "paypal.refund",
          target: { captureId: "CAP-1" },
          amount: { minor: 18.5, currency: "USD" },
          decisionSeq: 1,
        }),
      ).toThrow();
      expect(() =>
        reconciliationEntry({
          at: T3,
          intentId: null,
          source: "webhook",
          refund: {
            id: "REF-1",
            captureId: null,
            status: "COMPLETED",
            amount: { minor: 100, currency: "USD" },
          },
          resultSeq: null,
        } as never),
      ).toThrow();
    });
  });

  describe("the schemas", () => {
    it("reject a request whose request ID isn't the intent hash", () => {
      const payload = { ...(request(1, 1).payload as object), requestId: hashOf(2) };
      expect(ExecutionRequestedPayloadSchema.safeParse(payload).success).toBe(false);
    });

    it("reject unknown fields and outcomes", () => {
      const extra = { ...(executed(1, 2).payload as object), note: "x" };
      expect(ExecutionResultPayloadSchema.safeParse(extra).success).toBe(false);
      const outcome = { ...(executed(1, 2).payload as object), outcome: "refunded" };
      expect(ExecutionResultPayloadSchema.safeParse(outcome).success).toBe(false);
      expect(ReconciliationPayloadSchema.safeParse({ source: "poll" }).success).toBe(false);
    });
  });

  describe("readExecutionHistory", () => {
    it("is known and empty for a log with no executions", async () => {
      expect(await readExecutionHistory(db)).toEqual({ known: true, executions: [] });
      await append(decision(1));
      expect(await readExecutionHistory(db)).toEqual({ known: true, executions: [] });
    });

    it("holds one snapshot per request, with the request's amount, capture, principal and time", async () => {
      await append(decision(1), request(1, 1), decision(2), request(2, 3, T3), executed(2, 4));
      expect(await readExecutionHistory(db)).toEqual({
        known: true,
        executions: [snapshot(1), snapshot(2, T3)],
      });
    });

    it("counts a request whose result is unknown, and leaves out one whose result failed", async () => {
      await append(request(1, 1), unknownResult(1, 1), request(2, 1), failed(2, 3));
      expect(await readExecutionHistory(db)).toEqual({ known: true, executions: [snapshot(1)] });
    });

    it("doesn't add a second snapshot for a replay request", async () => {
      await append(request(1, 1), executed(1, 1), replay(1, 1));
      expect(await readExecutionHistory(db)).toEqual({ known: true, executions: [snapshot(1)] });
    });

    it("counts a failed intent again once a replay re-sends it", async () => {
      await append(request(1, 1), failed(1, 1), replay(1, 1));
      expect(await readExecutionHistory(db)).toEqual({ known: true, executions: [snapshot(1)] });
      await append(executed(1, 3));
      expect(await readExecutionHistory(db)).toEqual({ known: true, executions: [snapshot(1)] });
      await append(request(2, 1), failed(2, 5), replay(2, 5), failed(2, 7));
      expect(await readExecutionHistory(db)).toEqual({ known: true, executions: [snapshot(1)] });
    });

    it("keeps an executed intent even when a later re-send is refused", async () => {
      await append(request(1, 1), unknownResult(1, 1), replay(1, 1), executed(1, 3));
      await append(replay(1, 1), failed(1, 5));
      expect(await readExecutionHistory(db)).toEqual({ known: true, executions: [snapshot(1)] });
    });

    it("sees the open transaction's own appends", async () => {
      const seen = await withAuditLog(db, async (log) => {
        await log.append(request(1, 1));
        return readExecutionHistory(log.tx);
      });
      expect(seen).toEqual({ known: true, executions: [snapshot(1)] });
    });

    describe("is unknown, never skipped, when an entry can't be read", () => {
      const cases: [string, EntryInput[]][] = [
        [
          "a request missing its amount",
          [
            {
              entryType: "execution.requested",
              refId: intentId(1),
              at: T1,
              payload: { intentId: intentId(1), principal: "agent:resolve" },
            },
          ],
        ],
        ["a request whose ref isn't its intent", [{ ...request(1, 1), refId: intentId(2) }]],
        [
          "a result with an outcome it doesn't know",
          [
            request(1, 1),
            {
              entryType: "execution.result",
              refId: intentId(1),
              at: T2,
              payload: { requestSeq: 1, outcome: "refunded" },
            },
          ],
        ],
        ["a result for a request that isn't in the log", [request(1, 1), failed(1, 7)]],
        ["a result for another intent's request", [request(1, 1), failed(2, 1)]],
        ["a replay of a request that isn't in the log", [replay(1, 4)]],
        [
          "a reconciliation with no refund",
          [
            request(1, 1),
            {
              entryType: "reconciliation",
              refId: intentId(1),
              at: T3,
              payload: { source: "poll", resultSeq: null },
            },
          ],
        ],
      ];

      it.each(cases)("%s", async (_name, inputs) => {
        await append(...inputs);
        const history = await readExecutionHistory(db);
        expect(history).toMatchObject({ known: false });
        expect(history).not.toHaveProperty("executions");
      });

      it("names the entry it couldn't read", async () => {
        await append(request(1, 1), failed(2, 1));
        expect(await readExecutionHistory(db)).toEqual({
          known: false,
          seq: 2,
          detail: expect.stringMatching(/^execution\.result #2 /),
        });
      });
    });
  });

  describe("a log in the shapes phases 6 to 8 wrote", () => {
    it("reads as phase 8 read it, in every execution reader", async () => {
      await append(...PHASE_8_LOG);
      expect(await readExecutionHistory(db)).toEqual(PHASE_8_READS.history);
      expect(await readIntentRecord(db, intentIdOf(1))).toEqual(PHASE_8_READS.intent1);
      expect(await readIntentRecord(db, intentIdOf(2))).toEqual(PHASE_8_READS.intent2);
      expect(await readIntentRecord(db, intentIdOf(4))).toEqual({ known: true, trail: null });
      expect(await readReconciliationState(db)).toEqual(PHASE_8_READS.reconciliation);
      expect(await readReconcileWork(db)).toEqual(PHASE_8_READS.work);
      expect(await verifyLog(db)).toMatchObject({ intact: true, entries: 12 });
    });

    it("still reads the same with phase 9's entries after it", async () => {
      await append(...PHASE_8_LOG, invoiceRequest(5, 1), invoiceSent(5, 13, "SENT"));
      const history = await readExecutionHistory(db);
      expect(history).toEqual({
        known: true,
        executions: [...PHASE_8_READS.history.executions, invoiceSnapshot(5)],
      });
      expect(await readIntentRecord(db, intentIdOf(1))).toEqual(PHASE_8_READS.intent1);
      expect(await readReconciliationState(db)).toEqual(PHASE_8_READS.reconciliation);
      expect(await readReconcileWork(db)).toEqual(PHASE_8_READS.work);
    });
  });

  describe("approved and non-refund intents (ADR 0033)", () => {
    it("write an approved request with its approval, its target, and no capture or request ID for an invoice", () => {
      const entry = invoiceRequest(5, 9);
      expect(entry.refId).toBe(intentId(5));
      expect(entry.payload).toEqual({
        intentId: intentId(5),
        intentHash: hashOf(5),
        principal: "agent:resolve",
        rail: "paypal",
        action: "paypal.invoice.send",
        captureId: null,
        target: { invoiceId: "INV2-5" },
        amount: { minor: 2500, currency: "USD" },
        requestId: null,
        replay: false,
        approvalSeq: 9,
      });
      expect(ExecutionRequestedPayloadSchema.safeParse(entry.payload).success).toBe(true);
    });

    it("write an approved refund with its capture from the target and the hash as request ID", () => {
      const entry = executionRequestedEntry({
        at: T1,
        intentId: intentId(1),
        intentHash: hashOf(1),
        principal: "agent:resolve",
        rail: "paypal",
        action: "paypal.refund",
        target: { captureId: "CAP-1" },
        amount: { minor: 24000, currency: "USD" },
        approvalSeq: 3,
      });
      expect(entry.payload).toMatchObject({
        captureId: "CAP-1",
        target: { captureId: "CAP-1" },
        requestId: hashOf(1),
        replay: false,
        approvalSeq: 3,
      });
      expect(entry.payload).not.toHaveProperty("decisionSeq");
    });

    it("refuse a request that mixes its shapes or disagrees with its target", () => {
      const invoice = invoiceRequest(5, 9).payload as Record<string, unknown>;
      const refund = request(1, 1).payload as Record<string, unknown>;
      const bad = [
        { ...invoice, decisionSeq: 1 },
        { ...invoice, requestId: hashOf(5) },
        { ...invoice, captureId: "CAP-5" },
        { ...refund, requestId: null },
        { ...refund, target: { captureId: "CAP-2" } },
        { ...refund, target: { invoiceId: "INV2-1" } },
        { ...refund, target: { captureId: "CAP-1", orderId: "O-1" } },
      ];
      for (const payload of bad) {
        expect(ExecutionRequestedPayloadSchema.safeParse(payload).success).toBe(false);
      }
    });

    it("write an invoice's result in place of a refund, sent or scheduled", () => {
      expect(invoiceSent(5, 2, "SENT").payload).toEqual({
        requestSeq: 2,
        outcome: "executed",
        invoice: { id: "INV2-5", status: "SENT" },
      });
      expect(invoiceSent(5, 2, "SCHEDULED").payload).toMatchObject({
        invoice: { status: "SCHEDULED" },
      });
      const executedRefund = executed(1, 2).payload as Record<string, unknown>;
      const bad = [
        { requestSeq: 2, outcome: "executed", invoice: { id: "INV2-5", status: "PAID" } },
        { ...executedRefund, invoice: { id: "INV2-5", status: "SENT" } },
        { requestSeq: 2, outcome: "executed" },
      ];
      for (const payload of bad) {
        expect(ExecutionResultPayloadSchema.safeParse(payload).success).toBe(false);
      }
    });

    it("count an executed invoice in the history with its amount, and an approved request with no result yet", async () => {
      await append(invoiceRequest(5, 1), invoiceSent(5, 1, "SCHEDULED"), invoiceRequest(6, 1));
      expect(await readExecutionHistory(db)).toEqual({
        known: true,
        executions: [invoiceSnapshot(5), invoiceSnapshot(6)],
      });
    });

    it("leave a refused invoice send out of the history", async () => {
      await append(invoiceRequest(5, 1), failed(5, 1));
      expect(await readExecutionHistory(db)).toEqual({ known: true, executions: [] });
    });

    it("read an invoice intent's trail with its invoice", async () => {
      await append(invoiceRequest(5, 1), invoiceSent(5, 1, "SENT"));
      expect(await readIntentRecord(db, intentId(5))).toEqual({
        known: true,
        trail: {
          firstRequest: { seq: 1, at: T1, payload: invoiceRequest(5, 1).payload },
          executed: { seq: 2, invoice: { id: "INV2-5", status: "SENT" } },
          lastOutcome: "executed",
        },
      });
    });

    it("leave results without a refund out of reconciliation", async () => {
      await append(invoiceRequest(5, 1), invoiceSent(5, 1, "SENT"));
      expect(await readReconciliationState(db)).toEqual({
        known: true,
        state: { events: new Set(), refunds: new Set(), results: new Map() },
      });
      expect(await readReconcileWork(db)).toEqual({
        known: true,
        work: { executed: [], open: [] },
      });
    });
  });
});
