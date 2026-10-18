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
  reconciliationEntry,
} from "../src/execution-log";

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
    captureId: `CAP-${n}`,
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
    captureId: `CAP-${n}`,
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
          captureId: "CAP-1",
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
});
