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
import { parseMandate } from "@countersign/mandate";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { type AnswerStepUpResult, answerStepUp } from "../src/answer-step-up";
import { APPROVAL_WINDOW_MS } from "../src/decide";
import { propose } from "../src/propose";
import { createFakeSandbox, type FakeSandbox } from "./fake-sandbox";

// Answering a step-up (ADR 0032) through answerStepUp(), with the fake sandbox, PGlite and an
// injected clock. Step-ups come from real decisions under the shipped mandate. Illustrative IDs
// and people.

const SLOW = 60_000;
const NOW = new Date("2026-10-17T09:00:00+03:00");
const LATER = new Date(NOW.getTime() + 5 * 60 * 1000);
const PAST_EXPIRY = new Date(NOW.getTime() + APPROVAL_WINDOW_MS + 1);
const PRINCIPAL = "support-agent";
const PAYER = "wanjiru.m@example.com";
const INVOICE = "INV2-ABCD-EFGH-IJKL-MNOP";
const DISPUTE = "PP-D-4012";

const mandateFile = fileURLToPath(
  new URL("../../../packages/mandate/fixtures/kikapu-studio-v3.json", import.meta.url),
);
const parsedMandate = parseMandate(JSON.parse(readFileSync(mandateFile, "utf8")));
if (!parsedMandate.ok) throw new Error(parsedMandate.error);
const mandate = parsedMandate.mandate;

// The shipped mandate with order captures stepped up too, so an action without an executor
// reaches a step-up.
const captureMandate = (() => {
  const json = JSON.parse(readFileSync(mandateFile, "utf8"));
  json.rules.push({
    id: "order-captures",
    action: "paypal.order.capture",
    decide: "step_up",
    reason: "ALWAYS_NEEDS_APPROVAL",
  });
  const parsed = parseMandate(json);
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.mandate;
})();

const usd = (minor: number) => ({ minor, currency: "USD" as const });

// Beat 5 (the payer of KIK-1037 asks for $240.00 back for a damaged basket, with a photo), plus a
// draft invoice and an open dispute, on one fake sandbox.
function world() {
  const rail = createFakeSandbox();
  const captureId = "CAP-1037";
  const capture = { id: captureId, status: "COMPLETED", amount: usd(24000), orderId: "ORD-1037" };
  rail.captures.set(captureId, capture);
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
          { id: `${captureId}-TRK1037`, captureId, trackingNumber: "TRK1037", status: "SHIPPED" },
        ],
        refunds: [],
      },
    ],
  });
  rail.invoices.set(INVOICE, {
    id: INVOICE,
    status: "DRAFT",
    amount: usd(2500),
    invoiceNumber: "KIK-INV-0007",
    recipientEmails: [PAYER],
  });
  rail.disputeDetails.set(DISPUTE, {
    id: DISPUTE,
    status: "WAITING_FOR_SELLER_RESPONSE",
    amount: usd(4500),
    captureIds: [captureId],
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

const refund = (value: string) => ({
  tool: "create_refund",
  args: { capture_id: "CAP-1037", amount: { value, currency_code: "USD" } },
  justification: { ticket_id: "TKT-1037", claim: "damaged" },
});
const sendInvoice = {
  tool: "send_invoice",
  args: { invoice_id: INVOICE, note: "Thanks for your order." },
  justification: { ticket_id: "TKT-1037" },
};

const payOrder = {
  tool: "pay_order",
  args: { id: "ORD-1037" },
  justification: { ticket_id: "TKT-1037" },
};
const isPayOrder = (proposal: unknown) => proposal === payOrder;

const railCalls = (rail: FakeSandbox, call: string) =>
  rail.calls.filter((entry) => entry.call === call);

function answered(result: AnswerStepUpResult) {
  if (result.kind !== "answered") throw new Error(`not answered: ${result.kind}`);
  return result;
}

describe("answerStepUp", { timeout: SLOW }, () => {
  let handle: DatabaseHandle;
  let db: Database;

  beforeAll(async () => {
    handle = await createTestDatabase();
    db = handle.db;
  }, SLOW);

  beforeEach(async () => {
    await db.execute(sql`TRUNCATE audit_log, tickets`);
    await writeTicket(db, {
      id: "TKT-1037",
      channel: "email",
      senderEmail: PAYER,
      senderPhone: null,
      subject: null,
      body: "Simulated ticket.",
      attachments: [{ id: "ATT-TKT-1037", contentType: "image/jpeg" }],
      receivedAt: "2026-10-17T08:00:00+03:00",
      simulated: true,
    });
  });

  afterAll(async () => {
    await handle.close();
  });

  const entries = () => db.select().from(auditLog).orderBy(asc(auditLog.seq));
  const entryTypes = async () => (await entries()).map((row) => row.entryType);

  const decide = async (w: World, proposal: unknown, now = NOW) => {
    const result = await propose({
      mandate: isPayOrder(proposal) ? captureMandate : mandate,
      principal: PRINCIPAL,
      proposal,
      now,
      ...w,
      db,
      clock: () => now,
    });
    if (!result.ok || result.replay) throw new Error("not decided");
    return result;
  };

  // Proposes and returns the step-up's seq and intent hash.
  const stepUp = async (w: World, proposal: unknown, now = NOW) => {
    const result = await decide(w, proposal, now);
    expect(result.record.decision).toBe("step_up");
    const hash = result.record.intentHash;
    if (hash === null) throw new Error("no intent hash");
    return { seq: result.seqs.decision, hash, intentId: result.record.intentId };
  };

  const answer = (
    w: World,
    stepUpSeq: number,
    input: { answer: unknown; intentHash: unknown },
    now = LATER,
  ) =>
    answerStepUp({
      db,
      rail: w.rail,
      stepUpSeq,
      ...input,
      channel: "approvals_page",
      now,
      clock: () => now,
    });

  const approvalPayloads = async () =>
    (await entries())
      .filter((row) => row.entryType === "approval")
      .map((row) => JSON.parse(row.payload));

  it("approves beat 5's step-up and refunds exactly $240.00 once, with the intent hash", async () => {
    const w = world();
    const { seq, hash, intentId } = await stepUp(w, refund("240.00"));
    const before = (await entries()).length;

    const result = answered(await answer(w, seq, { answer: "approve", intentHash: hash }));

    expect(result.outcome).toBe("approved");
    expect(result.code).toBeNull();
    expect(result.execution?.outcome).toBe("executed");
    expect(result.execution?.refund?.status).toBe("COMPLETED");
    const refunds = railCalls(w.rail, "refundCapture");
    expect(refunds).toHaveLength(1);
    expect(refunds[0]?.arg).toEqual({
      captureId: "CAP-1037",
      amount: usd(24000),
      customId: intentId,
      requestId: hash,
    });

    const added = (await entries()).slice(before);
    expect(added.map((row) => row.entryType)).toEqual([
      "approval",
      "execution.requested",
      "execution.result",
    ]);
    const [approval, request, outcome] = added;
    expect(result.approvalSeq).toBe(approval?.seq);
    expect(approval?.refId).toBe(intentId);
    expect(approval?.at).toBe(LATER.toISOString());
    expect(JSON.parse(approval?.payload ?? "")).toEqual({
      stepUpSeq: seq,
      intentHash: hash,
      answer: "approve",
      outcome: "approved",
      approver: "merchant",
      channel: "approvals_page",
    });
    expect(JSON.parse(request?.payload ?? "")).toMatchObject({
      replay: false,
      approvalSeq: approval?.seq,
      intentHash: hash,
      requestId: hash,
      captureId: "CAP-1037",
      target: { captureId: "CAP-1037" },
      amount: usd(24000),
    });
    expect(JSON.parse(request?.payload ?? "")).not.toHaveProperty("decisionSeq");
    expect(JSON.parse(outcome?.payload ?? "")).toMatchObject({
      requestSeq: request?.seq,
      outcome: "executed",
    });
    expect(result.execution?.resultSeq).toBe(outcome?.seq);
    expect((await verifyLog(db)).intact).toBe(true);
  });

  it("denies with a denied entry and no rail call", async () => {
    const w = world();
    const { seq, hash } = await stepUp(w, refund("240.00"));
    w.rail.calls.length = 0;

    const result = answered(await answer(w, seq, { answer: "deny", intentHash: hash }));

    expect(result).toMatchObject({ outcome: "denied", code: null, execution: null });
    expect(w.rail.calls).toEqual([]);
    expect(await approvalPayloads()).toEqual([
      {
        stepUpSeq: seq,
        intentHash: hash,
        answer: "deny",
        outcome: "denied",
        approver: "merchant",
        channel: "approvals_page",
      },
    ]);
    expect((await entryTypes()).filter((type) => type.startsWith("execution."))).toEqual([]);
  });

  describe("rejections, each a rejected entry and no rail call", () => {
    const expectRejected = async (
      w: World,
      result: AnswerStepUpResult,
      code: string,
      answerGiven = "approve",
    ) => {
      const got = answered(result);
      expect(got).toMatchObject({ outcome: "rejected", code, execution: null });
      const payload = (await approvalPayloads()).at(-1);
      expect(payload).toMatchObject({ outcome: "rejected", code, answer: answerGiven });
      expect(railCalls(w.rail, "refundCapture")).toHaveLength(0);
      expect(railCalls(w.rail, "sendInvoice")).toHaveLength(0);
    };

    it("HASH_MISMATCH: the hash of a changed amount, even when also expired", async () => {
      const w = world();
      const { seq } = await stepUp(w, refund("240.00"));
      const changed = await stepUp(w, refund("230.00"));

      await expectRejected(
        w,
        await answer(w, seq, { answer: "approve", intentHash: changed.hash }, PAST_EXPIRY),
        "HASH_MISMATCH",
      );
      await expectRejected(
        w,
        await answer(w, seq, { answer: "deny", intentHash: changed.hash }),
        "HASH_MISMATCH",
        "deny",
      );
      expect((await entryTypes()).filter((type) => type.startsWith("execution."))).toEqual([]);
    });

    it("ALREADY_ANSWERED: after a deny, even when also expired", async () => {
      const w = world();
      const { seq, hash } = await stepUp(w, refund("240.00"));
      answered(await answer(w, seq, { answer: "deny", intentHash: hash }));

      await expectRejected(
        w,
        await answer(w, seq, { answer: "approve", intentHash: hash }, PAST_EXPIRY),
        "ALREADY_ANSWERED",
      );
      await expectRejected(
        w,
        await answer(w, seq, { answer: "deny", intentHash: hash }),
        "ALREADY_ANSWERED",
        "deny",
      );
    });

    it("EXPIRED: an answer after expires_at counts as denied and never executes", async () => {
      const w = world();
      const { seq, hash } = await stepUp(w, refund("240.00"));

      await expectRejected(
        w,
        await answer(w, seq, { answer: "approve", intentHash: hash }, PAST_EXPIRY),
        "EXPIRED",
      );
      await expectRejected(
        w,
        await answer(w, seq, { answer: "deny", intentHash: hash }, PAST_EXPIRY),
        "EXPIRED",
        "deny",
      );
      // A rejection leaves the step-up as it was, so it's still open before expiry.
      const inTime = answered(await answer(w, seq, { answer: "deny", intentHash: hash }));
      expect(inTime.outcome).toBe("denied");
    });

    it("ALREADY_REQUESTED: a newer step-up of an invoice intent already approved", async () => {
      const w = world();
      const first = await stepUp(w, sendInvoice);
      const approved = answered(
        await answer(w, first.seq, { answer: "approve", intentHash: first.hash }),
      );
      expect(approved.execution?.outcome).toBe("executed");
      expect(railCalls(w.rail, "sendInvoice")).toHaveLength(1);

      const again = await stepUp(w, sendInvoice, LATER);
      expect(again.hash).toBe(first.hash);
      w.rail.calls.length = 0;
      const result = await answer(w, again.seq, { answer: "approve", intentHash: again.hash });
      await expectRejected(w, result, "ALREADY_REQUESTED");
      expect((await entryTypes()).filter((type) => type === "execution.requested")).toHaveLength(1);
      // A deny of the newer step-up is still a plain deny.
      const denied = answered(
        await answer(w, again.seq, { answer: "deny", intentHash: again.hash }),
      );
      expect(denied.outcome).toBe("denied");
    });

    it("ACTION_UNAVAILABLE: an action without an executor can be denied but not approved", async () => {
      const w = world();
      const { seq, hash } = await stepUp(w, payOrder);

      await expectRejected(
        w,
        await answer(w, seq, { answer: "approve", intentHash: hash }),
        "ACTION_UNAVAILABLE",
      );
      const denied = answered(await answer(w, seq, { answer: "deny", intentHash: hash }));
      expect(denied.outcome).toBe("denied");
      expect((await entryTypes()).filter((type) => type.startsWith("execution."))).toEqual([]);
    });

    it("DUPLICATE_REFUND: another refund executed on the capture since", async () => {
      const w = world();
      const { seq, hash } = await stepUp(w, refund("240.00"));
      const small = await decide(w, refund("30.00"), LATER);
      expect(small.record.decision).toBe("allow");
      expect(small.execution?.outcome).toBe("executed");
      w.rail.calls.length = 0;

      await expectRejected(
        w,
        await answer(w, seq, { answer: "approve", intentHash: hash }),
        "DUPLICATE_REFUND",
      );
      expect((await verifyLog(db)).intact).toBe(true);
    });

    it("DUPLICATE_REFUND: the execution history can't be read", async () => {
      const w = world();
      const { seq, hash } = await stepUp(w, refund("240.00"));
      const broken = await appendEntries(db, [
        { entryType: "reconciliation", refId: null, at: NOW.toISOString(), payload: {} },
      ]);
      if (!broken.ok) throw new Error(broken.rejection.detail);
      w.rail.calls.length = 0;

      await expectRejected(
        w,
        await answer(w, seq, { answer: "approve", intentHash: hash }),
        "DUPLICATE_REFUND",
      );
    });
  });

  it("answers not_found for a seq that isn't a step-up, and writes nothing", async () => {
    const w = world();
    const { hash } = await stepUp(w, refund("240.00"));
    const denied = await decide(w, { tool: "create_refund", args: {} });
    expect(denied.record.decision).toBe("deny");
    const before = await entries();
    const mandateSeq = before.find((row) => row.entryType === "mandate.version")?.seq ?? 0;

    for (const seq of [mandateSeq, denied.seqs.decision, 9999]) {
      expect(await answer(w, seq, { answer: "approve", intentHash: hash })).toEqual({
        kind: "not_found",
      });
    }
    expect(await entries()).toEqual(before);
  });

  it("treats an unknown answer or a malformed hash as an input error, and writes nothing", async () => {
    const w = world();
    const { seq, hash } = await stepUp(w, refund("240.00"));
    const before = await entries();

    for (const input of [
      { answer: "maybe", intentHash: hash },
      { answer: "approve", intentHash: "not-a-hash" },
      { answer: "approve", intentHash: hash.toUpperCase() },
    ]) {
      expect((await answer(w, seq, input)).kind).toBe("input_error");
    }
    expect(await entries()).toEqual(before);
    expect(railCalls(w.rail, "refundCapture")).toHaveLength(0);
  });

  it("answers unknown and writes nothing when the step-up log can't be read", async () => {
    const w = world();
    const { seq, hash, intentId } = await stepUp(w, refund("240.00"));
    const broken = await appendEntries(db, [
      { entryType: "approval", refId: intentId, at: NOW.toISOString(), payload: { junk: true } },
    ]);
    if (!broken.ok) throw new Error(broken.rejection.detail);
    const before = await entries();

    expect((await answer(w, seq, { answer: "approve", intentHash: hash })).kind).toBe("unknown");
    expect(await entries()).toEqual(before);
    expect(railCalls(w.rail, "refundCapture")).toHaveLength(0);
  });

  it("makes one refund when two approvals of one step-up start together", async () => {
    const w = world();
    const { seq, hash } = await stepUp(w, refund("240.00"));

    const results = await Promise.all([
      answer(w, seq, { answer: "approve", intentHash: hash }),
      answer(w, seq, { answer: "approve", intentHash: hash }),
    ]);

    const outcomes = results.map((result) => answered(result).outcome).sort();
    expect(outcomes).toEqual(["approved", "rejected"]);
    const loser = results.map(answered).find((result) => result.outcome === "rejected");
    expect(loser?.code).toBe("ALREADY_ANSWERED");
    expect(railCalls(w.rail, "refundCapture")).toHaveLength(1);
    expect((await entryTypes()).filter((type) => type === "execution.requested")).toHaveLength(1);
    expect((await verifyLog(db)).intact).toBe(true);
  });

  it("sends an approved invoice step-up once, with its hashed note and no request ID", async () => {
    const w = world();
    const { seq, hash } = await stepUp(w, sendInvoice);

    const result = answered(await answer(w, seq, { answer: "approve", intentHash: hash }));

    expect(result.outcome).toBe("approved");
    expect(result.execution?.outcome).toBe("executed");
    expect(result.execution?.invoice).toEqual({ id: INVOICE, status: "SENT" });
    expect(w.rail.invoiceSends).toHaveLength(1);
    expect(railCalls(w.rail, "sendInvoice")[0]?.arg).toEqual({
      invoiceId: INVOICE,
      sendToRecipient: true,
      note: "Thanks for your order.",
    });
    const request = (await entries()).find((row) => row.entryType === "execution.requested");
    expect(JSON.parse(request?.payload ?? "")).toMatchObject({
      approvalSeq: result.approvalSeq,
      requestId: null,
      captureId: null,
      target: { invoiceId: INVOICE },
    });
    const again = answered(await answer(w, seq, { answer: "approve", intentHash: hash }));
    expect(again).toMatchObject({ outcome: "rejected", code: "ALREADY_ANSWERED" });
    expect(railCalls(w.rail, "sendInvoice")).toHaveLength(1);
  });

  it("answers the agent's later replay of an approved refund from the log, with no second refund", async () => {
    const w = world();
    const { seq, hash } = await stepUp(w, refund("240.00"));
    const approved = answered(await answer(w, seq, { answer: "approve", intentHash: hash }));
    const refundId = approved.execution?.refund?.id;
    expect(refundId).toBeDefined();
    const decisions = (await entryTypes()).filter((type) => type === "decision").length;

    const replay = await propose({
      mandate,
      principal: PRINCIPAL,
      proposal: refund("240.00"),
      now: LATER,
      ...w,
      db,
      clock: () => LATER,
    });

    if (!replay.ok || !replay.replay) throw new Error("not a replay");
    expect(replay.response).toEqual({
      decision: "allowed",
      intent_id: replay.intentId,
      intent_hash: hash,
    });
    expect(replay.execution).toMatchObject({ outcome: "executed", sent: false });
    expect(replay.execution.refund?.id).toBe(refundId);
    expect(railCalls(w.rail, "refundCapture")).toHaveLength(1);
    expect((await entryTypes()).filter((type) => type === "decision")).toHaveLength(decisions);
    expect((await verifyLog(db)).intact).toBe(true);
  });
});
