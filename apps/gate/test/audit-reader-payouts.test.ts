import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createMemoryShipmentStore, createMockCarrier } from "@countersign/carrier-mock";
import {
  asc,
  auditLog,
  createTestDatabase,
  type Database,
  type DatabaseHandle,
} from "@countersign/db";
import { appendEntry, verifyLog } from "@countersign/ledger";
import { parseMandate } from "@countersign/mandate";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { answerStepUp } from "../src/answer-step-up";
import {
  type DecisionRow,
  type ReadableDecisionRow,
  readDecisionDetail,
  readDecisionRows,
  readEntries,
} from "../src/audit-reader";
import { reconciliationEntry } from "../src/execution-log";
import { propose } from "../src/propose";
import { createFakeSandbox, httpError } from "./fake-sandbox";

// The audit reader's lines for payouts (ADR 0039) over PGlite: payout results and reconciliations
// in the entries list and in an intent's trail, decision rows for payouts, and the payee check in
// claims vs records. Illustrative suppliers and bills.

const SLOW = 120_000;
const NOW = new Date("2026-10-24T09:00:00+03:00");
const LATER = new Date(NOW.getTime() + 5 * 60 * 1000);
const READ_AT = new Date(NOW.getTime() + 10 * 60 * 1000);
const PRINCIPAL = "ops-agent";
const DYE_WORKS = "dyeworks@example.com";
const SISAL = "sisal.collective@example.com";
const UNLISTED = "refunds.desk@example.com";

const mandateFile = fileURLToPath(
  new URL("../../../packages/mandate/fixtures/kikapu-studio-ops-v1.json", import.meta.url),
);
const parsed = parseMandate(JSON.parse(readFileSync(mandateFile, "utf8")));
if (!parsed.ok) throw new Error(parsed.error);
const mandate = parsed.mandate;
const mandates = [mandate];

const usd = (minor: number) => ({ minor, currency: "USD" as const });

const payout = (receiver: string, value: string, reference: string, note?: string) => ({
  tool: "create_payout",
  args: {
    receiver,
    amount: { value, currency_code: "USD" },
    reference,
    ...(note === undefined ? {} : { note }),
  },
});

type Log = {
  paidSeq: number;
  paidIntent: string;
  deniedBatchSeq: number;
  deniedBatchIntent: string;
  refusedSeq: number;
  refusedIntent: string;
  noItemSeq: number;
  noItemIntent: string;
  unlistedSeq: number;
  pollSeq: number;
  webhookSeq: number;
  strayWebhookSeq: number;
  junkSeq: number;
  total: number;
};

describe("the audit reader's payout lines", { timeout: SLOW }, () => {
  let handle: DatabaseHandle;
  let db: Database;
  let log: Log;

  const append = async (entry: Parameters<typeof appendEntry>[1]) => {
    const result = await appendEntry(db, entry);
    if (!result.ok) throw new Error("not written");
    return result.entry.seq;
  };

  beforeAll(async () => {
    handle = await createTestDatabase();
    db = handle.db;
    const rail = createFakeSandbox();
    const w = { rail, carrier: createMockCarrier(createMemoryShipmentStore(new Map())) };

    const run = async (proposal: unknown) => {
      const result = await propose({
        mandate,
        principal: PRINCIPAL,
        proposal,
        now: NOW,
        ...w,
        db,
        clock: () => NOW,
      });
      if (!result.ok || result.replay) throw new Error("not decided");
      return result;
    };
    const approve = async (held: Awaited<ReturnType<typeof run>>) => {
      if (held.record.decision !== "step_up") throw new Error("not held");
      const result = await answerStepUp({
        db,
        rail,
        stepUpSeq: held.seqs.decision,
        answer: "approve",
        intentHash: held.record.intentHash,
        channel: "approvals_page",
        now: LATER,
        clock: () => LATER,
      });
      if (result.kind !== "answered") throw new Error(`not answered: ${result.kind}`);
    };
    const intentOf = (held: Awaited<ReturnType<typeof run>>) => {
      if (held.record.intentId === null) throw new Error("no intent");
      return held.record.intentId;
    };
    const resultSeqOf = async (intentId: string) => {
      const rows = await db.select().from(auditLog).orderBy(asc(auditLog.seq));
      const found = rows.find(
        (row) => row.entryType === "execution.result" && row.refId === intentId,
      );
      if (!found) throw new Error("no result");
      return found.seq;
    };

    // A $45.00 payout sent and left unclaimed (batch FAKEBATCH0001, item FAKEITEM0001).
    const paid = await run(payout(DYE_WORKS, "45.00", "KDW-2026-0412", "April dye order"));
    await approve(paid);
    // A payout whose batch PayPal denied.
    rail.payoutBatchStatus = "DENIED";
    const deniedBatch = await run(payout(SISAL, "12.50", "NSC-0077"));
    await approve(deniedBatch);
    rail.payoutBatchStatus = "PENDING";
    // A payout PayPal refused with a 4xx.
    const refused = await run(payout(DYE_WORKS, "20.00", "KDW-2026-0414"));
    rail.failures.createPayout = httpError("create-payout", 422, "INSUFFICIENT_FUNDS");
    await approve(refused);
    delete rail.failures.createPayout;
    // A payout that went out but whose batch couldn't be read afterwards.
    const noItem = await run(payout(DYE_WORKS, "9.00", "KDW-2026-0415"));
    rail.failures.getPayoutBatch = httpError("get-payout-batch", 503);
    await approve(noItem);
    delete rail.failures.getPayoutBatch;
    // A payee who isn't on the list.
    const unlisted = await run(payout(UNLISTED, "30.00", "RD-0001"));

    const paidIntent = intentOf(paid);
    const paidResultSeq = await resultSeqOf(paidIntent);
    const item = {
      batchId: "FAKEBATCH0001",
      itemId: "FAKEITEM0001",
      amount: usd(4500),
    };
    const pollSeq = await append(
      reconciliationEntry({
        at: LATER.toISOString(),
        intentId: paidIntent,
        source: "poll",
        payout: { ...item, status: "RETURNED" },
        resultSeq: paidResultSeq,
      }),
    );
    const webhookSeq = await append(
      reconciliationEntry({
        at: LATER.toISOString(),
        intentId: paidIntent,
        source: "webhook",
        event: { id: "WH-PAYOUT-0001", type: "PAYMENT.PAYOUTS-ITEM.SUCCEEDED" },
        payout: { ...item, status: "SUCCESS" },
        resultSeq: paidResultSeq,
      }),
    );
    const strayWebhookSeq = await append(
      reconciliationEntry({
        at: LATER.toISOString(),
        intentId: null,
        source: "webhook",
        event: { id: "WH-PAYOUT-0002", type: "PAYMENT.PAYOUTS-ITEM.UNCLAIMED" },
        payout: {
          batchId: "OTHERBATCH01",
          itemId: "OTHERITEM01",
          status: "UNCLAIMED",
          amount: usd(700),
        },
        resultSeq: null,
      }),
    );
    // A payout reconciliation that can't be read.
    const junkSeq = await append({
      entryType: "reconciliation",
      refId: paidIntent,
      at: LATER.toISOString(),
      payload: { source: "poll", payout: { junk: true }, resultSeq: 1 },
    });

    const rows = await db.select().from(auditLog).orderBy(asc(auditLog.seq));
    log = {
      paidSeq: paid.seqs.decision,
      paidIntent,
      deniedBatchSeq: deniedBatch.seqs.decision,
      deniedBatchIntent: intentOf(deniedBatch),
      refusedSeq: refused.seqs.decision,
      refusedIntent: intentOf(refused),
      noItemSeq: noItem.seqs.decision,
      noItemIntent: intentOf(noItem),
      unlistedSeq: unlisted.seqs.decision,
      pollSeq,
      webhookSeq,
      strayWebhookSeq,
      junkSeq,
      total: rows.length,
    };
  }, SLOW);

  afterAll(async () => {
    await handle.close();
  });

  const readable = (row: DecisionRow | undefined): ReadableDecisionRow => {
    if (!row?.readable) throw new Error("not a readable row");
    return row;
  };

  describe("entries", () => {
    const entryAt = async (seq: number) => {
      const page = await readEntries(db, { limit: 200 });
      expect(page.total).toBe(log.total);
      const found = page.entries.find((entry) => entry.seq === seq);
      if (!found) throw new Error(`no entry at ${seq}`);
      return found;
    };
    const resultOf = async (intentId: string) => {
      const page = await readEntries(db, { limit: 200 });
      const found = page.entries.find(
        (entry) => entry.type === "execution.result" && entry.ref === intentId,
      );
      if (!found) throw new Error("no result entry");
      return found;
    };

    it("summarise a payout's request as asking PayPal to send the payout", async () => {
      const page = await readEntries(db, { limit: 200 });
      const request = page.entries.find(
        (entry) => entry.type === "execution.requested" && entry.ref === log.paidIntent,
      );
      expect(request?.summary).toBe("Asked PayPal to send payout $45.00.");
    });

    it("summarise an executed payout with its amount, payee, batch and item status", async () => {
      expect(await resultOf(log.paidIntent)).toMatchObject({
        readable: true,
        summary: "Paid out $45.00 to dyeworks@example.com (batch FAKEBATCH0001, item unclaimed).",
      });
    });

    it("say so when an executed payout's item was not read", async () => {
      expect((await resultOf(log.noItemIntent)).summary).toBe(
        "Paid out $9.00 to dyeworks@example.com (batch FAKEBATCH0003, item not read).",
      );
    });

    it("say PayPal denied the batch, and name PayPal's refusal", async () => {
      expect((await resultOf(log.deniedBatchIntent)).summary).toBe(
        "PayPal denied the payout batch FAKEBATCH0002.",
      );
      expect((await resultOf(log.refusedIntent)).summary).toBe(
        "PayPal refused the payout: INSUFFICIENT_FUNDS.",
      );
    });

    it("summarise a payout reconciliation with the payee and the new status", async () => {
      expect((await entryAt(log.pollSeq)).summary).toBe(
        "Payout to dyeworks@example.com is now returned.",
      );
      expect((await entryAt(log.webhookSeq)).summary).toBe(
        "Payout to dyeworks@example.com is now success.",
      );
    });

    it("say a webhook payout that matches no request matches none", async () => {
      expect(await entryAt(log.strayWebhookSeq)).toMatchObject({
        readable: true,
        ref: null,
        summary: "Payout item OTHERITEM01 is now unclaimed, which matches no request.",
      });
    });

    it("say an unreadable payout reconciliation can't be read", async () => {
      expect(await entryAt(log.junkSeq)).toMatchObject({
        readable: false,
        summary: "This entry can't be read.",
        problem: expect.any(String),
      });
    });

    it("summarise the decisions with the payee in place of an order", async () => {
      expect((await entryAt(log.paidSeq)).summary).toBe(
        "Held send payout $45.00 on dyeworks@example.com for approval.",
      );
      expect((await entryAt(log.unlistedSeq)).summary).toBe(
        "Denied send payout $30.00 on refunds.desk@example.com.",
      );
    });
  });

  describe("decision rows", () => {
    const rows = async () => (await readDecisionRows(db, { limit: 200 }, READ_AT)).rows;
    const rowAt = async (seq: number) => readable((await rows()).find((row) => row.seq === seq));

    it("show the payee as the target, the action and the amount", async () => {
      expect(await rowAt(log.paidSeq)).toMatchObject({
        action: "paypal.payout",
        action_words: "Send payout",
        amount: { minor: 4500, currency: "USD", display: "$45.00" },
        target: { kind: "payee", id: DYE_WORKS },
        order_number: null,
        principal: "ops-agent",
        decision: "step_up",
        matched_rules: ["payout-listed-supplier"],
      });
    });

    it("show an approved, executed payout with its batch and item", async () => {
      expect((await rowAt(log.paidSeq)).status).toEqual({
        kind: "approved",
        execution: {
          outcome: "executed",
          refund: null,
          invoice: null,
          dispute: null,
          payout: {
            batch_id: "FAKEBATCH0001",
            batch_status: "PENDING",
            item: { id: "FAKEITEM0001", status: "UNCLAIMED" },
          },
        },
      });
      expect((await rowAt(log.noItemSeq)).status).toMatchObject({
        kind: "approved",
        execution: {
          outcome: "executed",
          payout: { batch_id: "FAKEBATCH0003", batch_status: "PENDING", item: null },
        },
      });
    });

    it("show a denied batch and a refused payout as failed, without an executed payout", async () => {
      expect((await rowAt(log.deniedBatchSeq)).status).toMatchObject({
        kind: "approved",
        execution: { outcome: "failed", payout: null },
      });
      expect((await rowAt(log.refusedSeq)).status).toMatchObject({
        kind: "approved",
        execution: { outcome: "failed", payout: null },
      });
    });

    it("show a payee who isn't on the list as denied, with no status", async () => {
      expect(await rowAt(log.unlistedSeq)).toMatchObject({
        decision: "deny",
        target: { kind: "payee", id: UNLISTED },
        reasons: [{ code: "PAYEE_NOT_ALLOWLISTED" }],
        status: null,
      });
    });

    it("are found by the payee's email and by the payout's batch or item", async () => {
      const ids = async (q: string) =>
        (await readDecisionRows(db, { q, limit: 200 }, READ_AT)).rows.map((row) => row.seq);
      expect(await ids("refunds.desk")).toEqual([log.unlistedSeq]);
      expect(await ids("FAKEITEM0001")).toEqual([log.paidSeq]);
      expect(await ids("fakebatch0001")).toEqual([log.paidSeq]);
    });
  });

  describe("decision detail", () => {
    const detailAt = async (seq: number) => {
      const detail = await readDecisionDetail(db, seq, READ_AT, mandates);
      if (!detail?.readable) throw new Error("not a readable detail");
      return detail;
    };

    it("lists an executed payout's decision, approval, request, result and reconciliations", async () => {
      const detail = await detailAt(log.paidSeq);
      expect(detail.trail.map((entry) => entry.type)).toEqual([
        "decision",
        "approval",
        "execution.requested",
        "execution.result",
        "reconciliation",
        "reconciliation",
        "reconciliation",
      ]);
      const unreadable = detail.trail.filter((entry) => !entry.readable);
      expect(unreadable.map((entry) => entry.seq)).toEqual([log.junkSeq]);
      const result = detail.trail.find((entry) => entry.type === "execution.result");
      expect(result).toMatchObject({
        readable: true,
        parts: {
          kind: "execution.result",
          outcome: "executed",
          refund: null,
          invoice: null,
          dispute: null,
          payout: {
            batch_id: "FAKEBATCH0001",
            batch_status: "PENDING",
            item: { id: "FAKEITEM0001", status: "UNCLAIMED" },
            payee: DYE_WORKS,
            amount: { minor: 4500, currency: "USD", display: "$45.00" },
          },
          error: null,
        },
      });
    });

    it("gives a payout reconciliation its item, status, amount and payee", async () => {
      const detail = await detailAt(log.paidSeq);
      const at = (seq: number) => detail.trail.find((entry) => entry.seq === seq);
      expect(at(log.pollSeq)).toMatchObject({
        readable: true,
        parts: {
          kind: "reconciliation",
          source: "poll",
          event: null,
          refund: null,
          payout: {
            batch_id: "FAKEBATCH0001",
            item_id: "FAKEITEM0001",
            status: "RETURNED",
            amount: { minor: 4500, currency: "USD", display: "$45.00" },
            payee: DYE_WORKS,
          },
          result_seq: expect.any(Number),
        },
      });
      expect(at(log.webhookSeq)).toMatchObject({
        parts: {
          source: "webhook",
          event: { id: "WH-PAYOUT-0001", type: "PAYMENT.PAYOUTS-ITEM.SUCCEEDED" },
          payout: { status: "SUCCESS" },
        },
      });
    });

    it("gives a refused payout its error and no payout", async () => {
      const detail = await detailAt(log.refusedSeq);
      expect(detail.trail.find((entry) => entry.type === "execution.result")).toMatchObject({
        parts: {
          outcome: "failed",
          payout: null,
          error: { name: "INSUFFICIENT_FUNDS" },
        },
      });
    });

    it("reads the payee check as Payee is on your list, from your mandate's payee list", async () => {
      const detail = await detailAt(log.paidSeq);
      expect(detail.claims).toEqual([
        {
          check: "payee.allowlisted",
          claim: null,
          record: {
            words: "Payee is on your list",
            detail: expect.stringContaining(DYE_WORKS),
            value: null,
            sources: [
              {
                words: "Your mandate's payee list",
                call: "mandate payees",
                id: "kikapu-studio-ops v1",
              },
            ],
          },
          verdict: "passes",
        },
      ]);
      const denied = await detailAt(log.unlistedSeq);
      expect(denied.claims).toMatchObject([
        {
          check: "payee.allowlisted",
          verdict: "fails",
          record: { words: "Payee is on your list" },
        },
      ]);
    });
  });

  it("writes nothing", async () => {
    const before = await verifyLog(db);
    await readDecisionRows(db, {}, READ_AT);
    await readDecisionDetail(db, log.paidSeq, READ_AT, mandates);
    await readEntries(db, {});
    expect(await verifyLog(db)).toEqual(before);
  });
});
