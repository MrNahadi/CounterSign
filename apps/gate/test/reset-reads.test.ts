// The demo reset's reads of the execution log (T-005): which execution requests still have no
// result, and which captures any request has named.

import { createTestDatabase, type Database, type DatabaseHandle, sql } from "@countersign/db";
import { appendEntries, type EntryInput } from "@countersign/ledger";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  countUnansweredRequests,
  executionRequestedEntry,
  executionResultEntry,
  type Reader,
  requestedCaptureIds,
} from "../src/execution-log";
import { MAX_RAIL_CALLS_PER_EXECUTION } from "../src/executors";

// Each PGlite start takes a couple of seconds.
const SLOW = 60_000;

const BEFORE = "2026-10-18T08:50:00.000Z";
const SINCE = "2026-10-18T09:00:00.000Z";
const AFTER = "2026-10-18T09:05:00.000Z";

const hashOf = (n: number) => n.toString(16).padEnd(64, "a");
const intentId = (n: number) => `int_${hashOf(n).slice(0, 24)}`;

const base = (n: number, at: string) => ({
  at,
  intentId: intentId(n),
  intentHash: hashOf(n),
  principal: "agent:resolve",
  rail: "paypal" as const,
  amount: { minor: 1800 * n, currency: "USD" as const },
});

const refund = (n: number, at = AFTER): EntryInput =>
  executionRequestedEntry({
    ...base(n, at),
    action: "paypal.refund",
    target: { captureId: `CAP-${n}` },
    decisionSeq: 1,
  });

const replay = (n: number, firstRequestSeq: number, at = AFTER): EntryInput =>
  executionRequestedEntry({
    ...base(n, at),
    action: "paypal.refund",
    target: { captureId: `CAP-${n}` },
    replayOf: { firstRequestSeq, proposal: { action: "create_refund", note: "illustrative" } },
  });

const disputeAccept = (n: number, at = AFTER): EntryInput =>
  executionRequestedEntry({
    ...base(n, at),
    action: "paypal.dispute.accept_claim",
    target: { disputeId: `PP-D-${n}` },
    approvalSeq: 1,
  });

const payout = (n: number, at = AFTER): EntryInput =>
  executionRequestedEntry({
    ...base(n, at),
    action: "paypal.payout",
    target: { email: `maker${n}@example.com` },
    approvalSeq: 1,
  });

const executed = (n: number, requestSeq: number): EntryInput =>
  executionResultEntry({
    at: AFTER,
    intentId: intentId(n),
    requestSeq,
    outcome: "executed",
    refund: { id: `REF-${n}`, status: "COMPLETED" },
  });

const failed = (n: number, requestSeq: number): EntryInput =>
  executionResultEntry({
    at: AFTER,
    intentId: intentId(n),
    requestSeq,
    outcome: "failed",
    error: { name: "UNPROCESSABLE_ENTITY", issues: ["CAPTURE_FULLY_REFUNDED"], debugId: "f00d" },
  });

// Seq 1, so the requests' decision and approval seqs point at an entry.
const decision: EntryInput = {
  entryType: "decision",
  refId: intentId(1),
  at: BEFORE,
  payload: { note: "illustrative decision" },
};

const unreadableRequest: EntryInput = {
  entryType: "execution.requested",
  refId: intentId(9),
  at: AFTER,
  payload: { intentId: intentId(9), principal: "agent:resolve" },
};

describe("the reset's reads of the execution log", () => {
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
  };

  describe("countUnansweredRequests", () => {
    it("is 0 on an empty log", async () => {
      expect(await countUnansweredRequests(db, SINCE)).toEqual({ known: true, count: 0 });
    });

    it("doesn't count a request with a result, and counts one without", async () => {
      // 1 decision, 2 request 1, 3 its result, 4 request 2 with none.
      await append(decision, refund(1), executed(1, 2), refund(2));
      expect(await countUnansweredRequests(db, SINCE)).toEqual({ known: true, count: 1 });
    });

    it("counts a failed result as an answer", async () => {
      await append(decision, refund(1), failed(1, 2));
      expect(await countUnansweredRequests(db, SINCE)).toEqual({ known: true, count: 0 });
    });

    it("counts a replay request on its own, though its first request has a result", async () => {
      // 1 decision, 2 request, 3 its result, 4 a replay with none.
      await append(decision, refund(1), executed(1, 2), replay(1, 2));
      expect(await countUnansweredRequests(db, SINCE)).toEqual({ known: true, count: 1 });
    });

    it("doesn't count a request from before `since`, and counts one at it", async () => {
      await append(decision, refund(1, BEFORE), refund(2, SINCE));
      expect(await countUnansweredRequests(db, SINCE)).toEqual({ known: true, count: 1 });
    });

    it("counts dispute and payout requests with no result", async () => {
      await append(decision, disputeAccept(1), payout(2));
      expect(await countUnansweredRequests(db, SINCE)).toEqual({ known: true, count: 2 });
    });

    it("works inside a transaction", async () => {
      await append(decision, refund(1));
      const reader: (tx: Reader) => ReturnType<typeof countUnansweredRequests> = (tx) =>
        countUnansweredRequests(tx, SINCE);
      const count = await db.transaction(reader);
      expect(count).toEqual({ known: true, count: 1 });
    });

    describe("is unknown when an entry can't be read", () => {
      const cases: [string, EntryInput[]][] = [
        ["an unreadable request", [decision, unreadableRequest]],
        [
          "an unreadable request from before `since`",
          [decision, { ...unreadableRequest, at: BEFORE }],
        ],
        [
          "an unreadable result",
          [
            decision,
            refund(1),
            {
              entryType: "execution.result",
              refId: intentId(1),
              at: AFTER,
              payload: { requestSeq: 2, outcome: "refunded" },
            },
          ],
        ],
        ["a result for a request that isn't in the log", [decision, refund(1), failed(1, 7)]],
        ["a result for another intent's request", [decision, refund(1), failed(2, 2)]],
      ];

      it.each(cases)("%s", async (_name, inputs) => {
        await append(...inputs);
        const answer = await countUnansweredRequests(db, SINCE);
        expect(answer).toMatchObject({ known: false });
        if (!answer.known) {
          expect(answer.seq).toBeGreaterThan(1);
          expect(answer.detail).not.toBe("");
        }
      });
    });
  });

  describe("requestedCaptureIds", () => {
    it("is empty on an empty log", async () => {
      expect(await requestedCaptureIds(db)).toEqual({ known: true, captureIds: new Set() });
    });

    it("names the capture of every refund request, whatever its outcome or time", async () => {
      await append(
        decision,
        refund(1, BEFORE),
        executed(1, 2),
        refund(2),
        failed(2, 4),
        refund(3),
        replay(1, 2),
      );
      expect(await requestedCaptureIds(db)).toEqual({
        known: true,
        captureIds: new Set(["CAP-1", "CAP-2", "CAP-3"]),
      });
    });

    it("names no capture for a dispute or payout request", async () => {
      await append(decision, disputeAccept(1), payout(2));
      expect(await requestedCaptureIds(db)).toEqual({ known: true, captureIds: new Set() });
    });

    it("is unknown when a request can't be read", async () => {
      await append(decision, refund(1), unreadableRequest);
      expect(await requestedCaptureIds(db)).toMatchObject({ known: false, seq: 3 });
    });

    it("works inside a transaction", async () => {
      await append(decision, refund(1));
      const read = await db.transaction((tx) => requestedCaptureIds(tx));
      expect(read).toEqual({ known: true, captureIds: new Set(["CAP-1"]) });
    });
  });

  it("an execution makes at most two rail calls", () => {
    expect(MAX_RAIL_CALLS_PER_EXECUTION).toBe(2);
  });
});
