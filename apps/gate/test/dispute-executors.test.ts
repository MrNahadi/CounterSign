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
  writeEvidenceDocument,
} from "@countersign/db";
import { verifyLog } from "@countersign/ledger";
import { type Mandate, parseMandate } from "@countersign/mandate";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { type AnswerStepUpResult, answerStepUp } from "../src/answer-step-up";
import { EVIDENCE_CARRIER } from "../src/executors";
import { type ProposeResult, propose } from "../src/propose";
import { createFakeSandbox, type FakeSandbox, httpError } from "./fake-sandbox";

// The dispute executors (ADR 0035) through answerStepUp() and propose(), with the fake sandbox,
// PGlite and an injected clock: accept claim, make offer and provide evidence, each sent once
// with exactly the stored intent's parameters. Illustrative IDs and people.

const SLOW = 60_000;
const NOW = new Date("2026-10-17T09:00:00+03:00");
const LATER = new Date(NOW.getTime() + 5 * 60 * 1000);
const PRINCIPAL = "support-agent";
const DISPUTE = "PP-D-4012";
const DOCUMENT = "doc_0123456789abcdef01234567";
const DOCUMENT_NAME = "countersign-evidence-PP-D-4012.pdf";
const PDF_BYTES = new TextEncoder().encode("%PDF-1.7 illustrative evidence for PP-D-4012");

const mandateFile = fileURLToPath(
  new URL("../../../packages/mandate/fixtures/kikapu-studio-v3.json", import.meta.url),
);
const shipped = JSON.parse(readFileSync(mandateFile, "utf8"));

function mandateOf(json: unknown): Mandate {
  const parsed = parseMandate(json);
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.mandate;
}
const mandate = mandateOf(shipped);

// The shipped mandate with accepted claims allowed outright, for the allowed path.
const allowingClaims = (() => {
  const json = structuredClone(shipped);
  json.rules = json.rules.map((rule: { id: string; action: unknown }) =>
    rule.id === "dispute-and-invoice-actions"
      ? { ...rule, action: ["paypal.dispute.provide_evidence", "paypal.dispute.make_offer"] }
      : rule,
  );
  json.rules.push({ id: "accept-claims", action: "paypal.dispute.accept_claim", decide: "allow" });
  return mandateOf(json);
})();

const usd = (minor: number) => ({ minor, currency: "USD" as const });

// Beat 3's delivered order with an open $45.00 dispute on its capture.
function world() {
  const rail = createFakeSandbox();
  const captureId = "CAP-1042";
  const capture = { id: captureId, status: "COMPLETED", amount: usd(4500), orderId: "ORD-1042" };
  rail.captures.set(captureId, capture);
  rail.orders.set("ORD-1042", {
    id: "ORD-1042",
    status: "COMPLETED",
    payerEmail: "wanjiru.m@example.com",
    payerId: "PAYER1042",
    purchaseUnits: [
      {
        referenceId: "KIK-1042",
        customId: null,
        invoiceId: null,
        amount: usd(4500),
        captures: [capture],
        trackers: [
          { id: `${captureId}-TRK1042`, captureId, trackingNumber: "TRK1042", status: "SHIPPED" },
        ],
        refunds: [],
      },
    ],
  });
  rail.disputeDetails.set(DISPUTE, {
    id: DISPUTE,
    status: "WAITING_FOR_SELLER_RESPONSE",
    amount: usd(4500),
    captureIds: [captureId],
  });
  const carrier = createMockCarrier(createMemoryShipmentStore(new Map()));
  return { rail, carrier };
}
type World = ReturnType<typeof world>;

const FULFILMENT_NOTES =
  "Shipped with Illustrative Post under tracking TRK1042; the carrier shows it delivered on 5 Oct 2026 (simulated carrier data). Records attached.";
const REFUND_NOTES = "Refunded $5.00 on 6 Oct 2026 (refund REF-1042). Records attached.";

const provideEvidence = {
  tool: "provide_dispute_evidence",
  args: {
    dispute_id: DISPUTE,
    evidence: [
      {
        evidence_type: "PROOF_OF_FULFILLMENT",
        notes: FULFILMENT_NOTES,
        tracking_numbers: ["TRK1042"],
      },
      { evidence_type: "PROOF_OF_REFUND", notes: REFUND_NOTES, refund_ids: ["REF-1042"] },
    ],
    document_ids: [DOCUMENT],
  },
};
const acceptClaim = {
  tool: "accept_dispute_claim",
  args: { dispute_id: DISPUTE, note: "Refunding in full." },
};
const makeOffer = {
  tool: "make_offer",
  args: {
    dispute_id: DISPUTE,
    offer_type: "REFUND",
    offer_amount: { value: "20.00", currency_code: "USD" },
    note: "We can refund $20.00 for the damage.",
  },
};
const replacementOffer = {
  tool: "make_offer",
  args: {
    dispute_id: DISPUTE,
    offer_type: "REPLACEMENT_WITHOUT_REFUND",
    note: "We'll send a new basket.",
  },
};

const railCalls = (rail: FakeSandbox, call: string) =>
  rail.calls.filter((entry) => entry.call === call);

function answered(result: AnswerStepUpResult) {
  if (result.kind !== "answered") throw new Error(`not answered: ${result.kind}`);
  return result;
}

describe("dispute executors", { timeout: SLOW }, () => {
  let handle: DatabaseHandle;
  let db: Database;

  beforeAll(async () => {
    handle = await createTestDatabase();
    db = handle.db;
  }, SLOW);

  beforeEach(async () => {
    await db.execute(sql`TRUNCATE audit_log, evidence_documents`);
    await storeDocument(PDF_BYTES);
  });

  afterAll(async () => {
    await handle.close();
  });

  const storeDocument = (bytes: Uint8Array) =>
    writeEvidenceDocument(db, {
      id: DOCUMENT,
      disputeId: DISPUTE,
      kind: "pdf",
      name: DOCUMENT_NAME,
      contentType: "application/pdf",
      bytes,
      createdAt: NOW.toISOString(),
    });

  const entries = () => db.select().from(auditLog).orderBy(asc(auditLog.seq));
  const payloadsOf = async (type: string) =>
    (await entries()).filter((row) => row.entryType === type).map((row) => JSON.parse(row.payload));

  const run = (w: World, proposal: unknown, now = NOW, using = mandate) =>
    propose({ mandate: using, principal: PRINCIPAL, proposal, now, ...w, db, clock: () => now });
  const decided = (result: ProposeResult) => {
    if (!result.ok || result.replay) throw new Error("not decided");
    return result;
  };

  const stepUp = async (w: World, proposal: unknown, now = NOW) => {
    const result = decided(await run(w, proposal, now));
    expect(result.record.decision).toBe("step_up");
    const hash = result.record.intentHash;
    if (hash === null) throw new Error("no intent hash");
    return { seq: result.seqs.decision, hash, result };
  };

  const approve = async (w: World, step: { seq: number; hash: string }, now = LATER) =>
    answered(
      await answerStepUp({
        db,
        rail: w.rail,
        stepUpSeq: step.seq,
        answer: "approve",
        intentHash: step.hash,
        channel: "approvals_page",
        now,
        clock: () => now,
      }),
    );

  it("sends an approved evidence step-up once, with the stored notes and the PDF's bytes, and logs the re-read status", async () => {
    const w = world();
    const step = await stepUp(w, provideEvidence);
    w.rail.calls.length = 0;

    const result = await approve(w, step);

    expect(result.outcome).toBe("approved");
    expect(result.execution).toMatchObject({
      outcome: "executed",
      sent: true,
      dispute: { id: DISPUTE, status: "UNDER_REVIEW" },
    });
    expect(w.rail.calls.map((call) => call.call)).toEqual(["provideEvidence", "getDispute"]);
    const [sent] = railCalls(w.rail, "provideEvidence");
    const input = sent?.arg as {
      documents: { name: string; contentType: string; bytes: Uint8Array }[];
    };
    expect(sent?.arg).toEqual({
      disputeId: DISPUTE,
      evidences: [
        {
          evidenceType: "PROOF_OF_FULFILLMENT",
          notes: FULFILMENT_NOTES,
          trackingInfo: [
            {
              carrierName: "OTHER",
              carrierNameOther: EVIDENCE_CARRIER.nameOther,
              trackingNumber: "TRK1042",
            },
          ],
        },
        { evidenceType: "PROOF_OF_REFUND", notes: REFUND_NOTES, refundIds: ["REF-1042"] },
      ],
      documents: [expect.objectContaining({ name: DOCUMENT_NAME, contentType: "application/pdf" })],
    });
    expect(EVIDENCE_CARRIER.nameOther).toBe("Carrier (simulated)");
    expect([...(input.documents[0]?.bytes ?? [])]).toEqual([...PDF_BYTES]);

    const [request] = await payloadsOf("execution.requested");
    expect(request).toMatchObject({
      action: "paypal.dispute.provide_evidence",
      approvalSeq: result.approvalSeq,
      requestId: null,
      captureId: null,
      target: { disputeId: DISPUTE },
      amount: usd(4500),
    });
    expect(await payloadsOf("execution.result")).toEqual([
      {
        requestSeq: result.requestSeq,
        outcome: "executed",
        dispute: { id: DISPUTE, status: "UNDER_REVIEW" },
      },
    ]);
    expect((await verifyLog(db)).intact).toBe(true);
  });

  it("records a null status when the dispute can't be re-read after the call", async () => {
    const w = world();
    const step = await stepUp(w, provideEvidence);
    w.rail.failures.getDispute = httpError("get-dispute", 503);

    const result = await approve(w, step);

    expect(result.execution).toMatchObject({
      outcome: "executed",
      dispute: { id: DISPUTE, status: null },
    });
    expect(railCalls(w.rail, "provideEvidence")).toHaveLength(1);
    expect(await payloadsOf("execution.result")).toEqual([
      {
        requestSeq: result.requestSeq,
        outcome: "executed",
        dispute: { id: DISPUTE, status: null },
      },
    ]);
  });

  it("sends nothing when the step-up is approved again or the same intent is proposed and approved again", async () => {
    const w = world();
    const first = await stepUp(w, provideEvidence);
    expect((await approve(w, first)).execution?.outcome).toBe("executed");

    const again = await approve(w, first);
    expect(again).toMatchObject({ outcome: "rejected", code: "ALREADY_ANSWERED", execution: null });

    const second = await stepUp(w, provideEvidence, LATER);
    expect(second.hash).toBe(first.hash);
    const reapproved = await approve(w, second, LATER);
    expect(reapproved).toMatchObject({
      outcome: "rejected",
      code: "ALREADY_REQUESTED",
      execution: null,
    });

    expect(railCalls(w.rail, "provideEvidence")).toHaveLength(1);
    expect(await payloadsOf("execution.requested")).toHaveLength(1);
  });

  it("never retries or re-sends a call whose outcome is unknown", async () => {
    const w = world();
    const first = await stepUp(w, acceptClaim);
    w.rail.failures.acceptClaim = httpError("accept-claim", 500, "INTERNAL_SERVER_ERROR");

    const result = await approve(w, first);
    expect(result.execution?.outcome).toBe("unknown");

    const second = await stepUp(w, acceptClaim, LATER);
    expect((await approve(w, second, LATER)).code).toBe("ALREADY_REQUESTED");
    expect(railCalls(w.rail, "acceptClaim")).toHaveLength(1);
  });

  it("sends an allowed claim once, and answers a re-proposal from the log without sending", async () => {
    const w = world();
    const first = decided(await run(w, acceptClaim, NOW, allowingClaims));
    expect(first.record.decision).toBe("allow");
    expect(first.execution).toMatchObject({
      outcome: "executed",
      sent: true,
      dispute: { id: DISPUTE, status: "RESOLVED" },
    });

    const second = decided(await run(w, acceptClaim, LATER, allowingClaims));
    expect(second.record.intentId).toBe(first.record.intentId);
    expect(second.seqs.request).toBeNull();
    expect(second.execution).toMatchObject({
      outcome: "executed",
      sent: false,
      dispute: { id: DISPUTE, status: "RESOLVED" },
      resultSeq: first.execution?.resultSeq,
    });
    expect(railCalls(w.rail, "acceptClaim")).toHaveLength(1);
  });

  it.each([
    ["its bytes changed", () => storeDocument(new TextEncoder().encode("%PDF-1.7 something else"))],
    ["its row is gone", async () => "gone" as const],
  ])(
    "records DOCUMENT_CHANGED and sends nothing when the document's %s",
    async (_label, change) => {
      const w = world();
      const step = await stepUp(w, provideEvidence);
      // The store is write-once, so a changed row can only come back after a truncate.
      await db.execute(sql`TRUNCATE evidence_documents`);
      await change();

      const result = await approve(w, step);

      expect(result.outcome).toBe("approved");
      expect(result.execution).toMatchObject({
        outcome: "failed",
        sent: true,
        error: { name: "DOCUMENT_CHANGED", debugId: null },
      });
      expect(result.execution?.dispute).toBeUndefined();
      expect(railCalls(w.rail, "provideEvidence")).toHaveLength(0);
      const [logged] = await payloadsOf("execution.result");
      expect(logged).toMatchObject({
        requestSeq: result.requestSeq,
        outcome: "failed",
        error: { name: "DOCUMENT_CHANGED" },
      });
    },
  );

  it.each([
    [422, "failed"],
    [500, "unknown"],
  ] as const)(
    "records a %i answer as %s, with PayPal's error and no status read",
    async (status, outcome) => {
      const w = world();
      const step = await stepUp(w, provideEvidence);
      w.rail.failures.provideEvidence = httpError("provide-evidence", status, "REFUSED");
      w.rail.calls.length = 0;

      const result = await approve(w, step);

      expect(result.execution).toMatchObject({
        outcome,
        error: { name: "REFUSED", debugId: "fake-debug" },
      });
      expect(w.rail.calls.map((call) => call.call)).toEqual(["provideEvidence"]);
      expect(await payloadsOf("execution.result")).toEqual([
        {
          requestSeq: result.requestSeq,
          outcome,
          error: { name: "REFUSED", issues: [], debugId: "fake-debug" },
        },
      ]);
    },
  );

  it("accepts a claim from approval with its hashed note", async () => {
    const w = world();
    const result = await approve(w, await stepUp(w, acceptClaim));

    expect(railCalls(w.rail, "acceptClaim").map((call) => call.arg)).toEqual([
      { disputeId: DISPUTE, note: "Refunding in full." },
    ]);
    expect(result.execution?.dispute).toEqual({ id: DISPUTE, status: "RESOLVED" });
  });

  it("makes an offer from approval with its hashed type, amount and note", async () => {
    const w = world();
    const result = await approve(w, await stepUp(w, makeOffer));

    expect(railCalls(w.rail, "makeOffer").map((call) => call.arg)).toEqual([
      {
        disputeId: DISPUTE,
        note: "We can refund $20.00 for the damage.",
        offerType: "REFUND",
        offerAmount: usd(2000),
      },
    ]);
    expect(result.execution?.dispute).toEqual({
      id: DISPUTE,
      status: "WAITING_FOR_BUYER_RESPONSE",
    });
  });

  it("sends a replacement offer with no amount", async () => {
    const w = world();
    await approve(w, await stepUp(w, replacementOffer));

    expect(railCalls(w.rail, "makeOffer").map((call) => call.arg)).toEqual([
      {
        disputeId: DISPUTE,
        note: "We'll send a new basket.",
        offerType: "REPLACEMENT_WITHOUT_REFUND",
      },
    ]);
  });

  it("counts executed dispute actions in today's usage: the offer's amount, or the dispute's", async () => {
    const w = world();
    await approve(w, await stepUp(w, makeOffer));
    await approve(w, await stepUp(w, acceptClaim));

    const later = await stepUp(w, provideEvidence, LATER);
    const usage = later.result.record.usage;
    if (!usage.known) throw new Error("usage unknown");
    expect(usage.perCurrency.USD).toEqual({ count: 2, total: usd(2000 + 4500) });
  });
});
