import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createMemoryShipmentStore, createMockCarrier } from "@countersign/carrier-mock";
import {
  asc,
  auditLog,
  createTestDatabase,
  type Database,
  type DatabaseHandle,
  writeEvidenceDocument,
} from "@countersign/db";
import { appendEntry, verifyLog } from "@countersign/ledger";
import { parseMandate } from "@countersign/mandate";
import type { PayPalDisputeDetail } from "@countersign/rail-paypal";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { answerStepUp } from "../src/answer-step-up";
import {
  type DecisionRow,
  type ReadableDecisionRow,
  readDecisionDetail,
  readDecisionRows,
  readEntries,
} from "../src/audit-reader";
import { disputeReceivedEntry } from "../src/dispute-log";
import { propose } from "../src/propose";
import { createFakeSandbox, httpError } from "./fake-sandbox";

// The audit reader's lines for disputes (ADR 0035) over PGlite: dispute.received entries, the
// results of dispute actions in the entries list and in an intent's trail, and decision rows for
// dispute actions. Illustrative IDs and people.

const SLOW = 120_000;
const NOW = new Date("2026-10-17T09:00:00+03:00");
const LATER = new Date(NOW.getTime() + 5 * 60 * 1000);
const READ_AT = new Date(NOW.getTime() + 10 * 60 * 1000);
const PRINCIPAL = "support-agent";
const CAPTURE = "CAP-1042";

const EVIDENCE_DISPUTE = "PP-D-4012";
const CLAIM_DISPUTE = "PP-D-4013";
const OFFER_DISPUTE = "PP-D-4014";
const REFUSED_DISPUTE = "PP-D-4015";
const BARE_DISPUTE = "PP-D-4016";
const DOCUMENTS = {
  [EVIDENCE_DISPUTE]: "doc_0123456789abcdef01234567",
  [REFUSED_DISPUTE]: "doc_89abcdef0123456789abcdef",
};

const mandateFile = fileURLToPath(
  new URL("../../../packages/mandate/fixtures/kikapu-studio-v3.json", import.meta.url),
);
const parsed = parseMandate(JSON.parse(readFileSync(mandateFile, "utf8")));
if (!parsed.ok) throw new Error(parsed.error);
const mandate = parsed.mandate;
const mandates = [mandate];

const usd = (minor: number) => ({ minor, currency: "USD" as const });

function detail(id: string, overrides: Partial<PayPalDisputeDetail> = {}): PayPalDisputeDetail {
  return {
    id,
    status: "WAITING_FOR_SELLER_RESPONSE",
    reason: "MERCHANDISE_OR_SERVICE_NOT_RECEIVED",
    lifeCycleStage: "CHARGEBACK",
    amount: usd(4500),
    sellerResponseDueDate: "2026-10-27T09:00:00.000Z",
    captureIds: [CAPTURE],
    linkNames: ["provide_evidence"],
    ...overrides,
  };
}

function world() {
  const rail = createFakeSandbox();
  const capture = { id: CAPTURE, status: "COMPLETED", amount: usd(4500), orderId: "ORD-1042" };
  rail.captures.set(CAPTURE, capture);
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
          {
            id: `${CAPTURE}-TRK1042`,
            captureId: CAPTURE,
            trackingNumber: "TRK1042",
            status: "SHIPPED",
          },
        ],
        refunds: [],
      },
    ],
  });
  for (const id of [EVIDENCE_DISPUTE, CLAIM_DISPUTE, OFFER_DISPUTE, REFUSED_DISPUTE]) {
    rail.disputeDetails.set(id, detail(id));
  }
  return { rail, carrier: createMockCarrier(createMemoryShipmentStore(new Map())) };
}

const evidence = (disputeId: string, documentId: string) => ({
  tool: "provide_dispute_evidence",
  args: {
    dispute_id: disputeId,
    evidence: [
      {
        evidence_type: "PROOF_OF_FULFILLMENT",
        notes: "Shipped with Illustrative Post. Records attached.",
        tracking_numbers: ["TRK1042"],
      },
    ],
    document_ids: [documentId],
  },
});
const acceptClaim = {
  tool: "accept_dispute_claim",
  args: { dispute_id: CLAIM_DISPUTE, note: "Refunding in full." },
};
const makeOffer = {
  tool: "make_offer",
  args: {
    dispute_id: OFFER_DISPUTE,
    offer_type: "REFUND",
    offer_amount: { value: "20.00", currency_code: "USD" },
    note: "We can refund $20.00 for the damage.",
  },
};

type Log = {
  evidenceSeq: number;
  evidenceIntent: string;
  claimSeq: number;
  claimIntent: string;
  offerSeq: number;
  refusedSeq: number;
  webhookSeq: number;
  pollSeq: number;
  bareSeq: number;
  junkSeq: number;
  mismatchSeq: number;
  total: number;
};

describe("the audit reader's dispute lines", { timeout: SLOW }, () => {
  let handle: DatabaseHandle;
  let db: Database;
  let log: Log;

  beforeAll(async () => {
    handle = await createTestDatabase();
    db = handle.db;
    const w = world();
    for (const [disputeId, id] of Object.entries(DOCUMENTS)) {
      await writeEvidenceDocument(db, {
        id,
        disputeId,
        kind: "pdf",
        name: `countersign-evidence-${disputeId}.pdf`,
        contentType: "application/pdf",
        bytes: new TextEncoder().encode(`%PDF-1.7 illustrative evidence for ${disputeId}`),
        createdAt: NOW.toISOString(),
      });
    }

    const append = async (entry: Parameters<typeof appendEntry>[1]) => {
      const result = await appendEntry(db, entry);
      if (!result.ok) throw new Error("not written");
      return result.entry.seq;
    };
    const webhookSeq = await append(
      disputeReceivedEntry({
        at: NOW.toISOString(),
        source: "webhook",
        event: { id: "WH-EVT-4012", type: "CUSTOMER.DISPUTE.CREATED" },
        dispute: detail(EVIDENCE_DISPUTE),
      }),
    );
    const pollSeq = await append(
      disputeReceivedEntry({
        at: NOW.toISOString(),
        source: "poll",
        dispute: detail(CLAIM_DISPUTE, { amount: usd(24000), reason: "CREDIT_NOT_PROCESSED" }),
      }),
    );
    // A reason PayPal adds later, on a dispute that names no capture.
    const bareSeq = await append(
      disputeReceivedEntry({
        at: NOW.toISOString(),
        source: "poll",
        dispute: detail(BARE_DISPUTE, { reason: "NEW_REASON_CODE", captureIds: [] }),
      }),
    );

    const stepUp = async (proposal: unknown) => {
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
      if (result.record.decision !== "step_up") throw new Error("not held");
      return result;
    };
    const approve = async (held: Awaited<ReturnType<typeof stepUp>>) => {
      const result = await answerStepUp({
        db,
        rail: w.rail,
        stepUpSeq: held.seqs.decision,
        answer: "approve",
        intentHash: held.record.intentHash,
        channel: "approvals_page",
        now: LATER,
        clock: () => LATER,
      });
      if (result.kind !== "answered") throw new Error(`not answered: ${result.kind}`);
      return result;
    };

    const evidenceHeld = await stepUp(evidence(EVIDENCE_DISPUTE, DOCUMENTS[EVIDENCE_DISPUTE]));
    await approve(evidenceHeld);
    const claimHeld = await stepUp(acceptClaim);
    await approve(claimHeld);
    const offerHeld = await stepUp(makeOffer);
    await approve(offerHeld);
    const refusedHeld = await stepUp(evidence(REFUSED_DISPUTE, DOCUMENTS[REFUSED_DISPUTE]));
    w.rail.failures.provideEvidence = httpError("provide-evidence", 422, "UNPROCESSABLE_ENTITY");
    await approve(refusedHeld);

    // Two entries that can't be read: a dispute.received with junk, and one whose ref isn't its
    // dispute.
    const junkSeq = await append({
      entryType: "dispute.received",
      refId: "PP-D-9999",
      at: LATER.toISOString(),
      payload: { junk: true },
    });
    const mismatchSeq = await append({
      ...disputeReceivedEntry({
        at: LATER.toISOString(),
        source: "poll",
        dispute: detail("PP-D-4017"),
      }),
      refId: "PP-D-4018",
    });
    const evidenceIntent = evidenceHeld.record.intentId;
    const claimIntent = claimHeld.record.intentId;
    if (!evidenceIntent || !claimIntent) throw new Error("no intent");
    const rows = await db.select().from(auditLog).orderBy(asc(auditLog.seq));
    log = {
      evidenceSeq: evidenceHeld.seqs.decision,
      evidenceIntent,
      claimSeq: claimHeld.seqs.decision,
      claimIntent,
      offerSeq: offerHeld.seqs.decision,
      refusedSeq: refusedHeld.seqs.decision,
      webhookSeq,
      pollSeq,
      bareSeq,
      junkSeq,
      mismatchSeq,
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
    const summaries = async () => {
      const page = await readEntries(db, { limit: 200 });
      expect(page.total).toBe(log.total);
      return (seq: number) => page.entries.find((entry) => entry.seq === seq);
    };

    it("summarise dispute.received with the capture, the amount and the reason in words", async () => {
      const entry = await summaries();
      expect(entry(log.webhookSeq)).toMatchObject({
        type: "dispute.received",
        ref: EVIDENCE_DISPUTE,
        readable: true,
        problem: null,
        summary:
          "PayPal opened dispute PP-D-4012 on capture CAP-1042 for $45.00 (item not received).",
      });
      expect(entry(log.pollSeq)?.summary).toBe(
        "PayPal opened dispute PP-D-4013 on capture CAP-1042 for $240.00 (refund not processed).",
      );
    });

    it("keeps a reason PayPal adds later as it is, and leaves out a capture the dispute doesn't name", async () => {
      const entry = await summaries();
      expect(entry(log.bareSeq)?.summary).toBe(
        "PayPal opened dispute PP-D-4016 for $45.00 (NEW_REASON_CODE).",
      );
    });

    it("say an unreadable dispute.received can't be read, with the problem", async () => {
      const entry = await summaries();
      expect(entry(log.junkSeq)).toMatchObject({
        type: "dispute.received",
        readable: false,
        summary: "This entry can't be read.",
        problem: expect.stringContaining("dispute.received"),
      });
      expect(entry(log.mismatchSeq)).toMatchObject({
        readable: false,
        summary: "This entry can't be read.",
        problem: expect.stringContaining("ref"),
      });
    });

    it("summarise each dispute result, and the refusal", async () => {
      const page = await readEntries(db, { limit: 200 });
      const results = page.entries
        .filter((entry) => entry.type === "execution.result")
        .map((entry) => entry.summary)
        .reverse();
      expect(results).toEqual([
        "PayPal took the evidence for PP-D-4012: under review.",
        "Accepted the claim on PP-D-4013.",
        "Sent an offer on PP-D-4014.",
        "PayPal refused it: UNPROCESSABLE_ENTITY.",
      ]);
    });

    it("find a result's action when its request is on another page", async () => {
      const all = await readEntries(db, { limit: 200 });
      const result = all.entries.find(
        (entry) => entry.ref === log.claimIntent && entry.type === "execution.result",
      );
      if (!result) throw new Error("no result");
      const page = await readEntries(db, { limit: 1, before: result.seq + 1 });
      expect(page.entries[0]?.summary).toBe("Accepted the claim on PP-D-4013.");
    });
  });

  describe("decision rows", () => {
    it("show the dispute as the target, and the executed status with the dispute", async () => {
      const page = await readDecisionRows(db, {}, READ_AT);
      const evidenceRow = readable(page.rows.find((row) => row.seq === log.evidenceSeq));
      expect(evidenceRow).toMatchObject({
        action: "paypal.dispute.provide_evidence",
        target: { kind: "dispute", id: EVIDENCE_DISPUTE },
        decision: "step_up",
        status: {
          kind: "approved",
          execution: {
            outcome: "executed",
            refund: null,
            invoice: null,
            dispute: { id: EVIDENCE_DISPUTE, status: "UNDER_REVIEW" },
          },
        },
      });
      expect(
        readable(page.rows.find((row) => row.seq === log.claimSeq)).status?.execution,
      ).toMatchObject({ outcome: "executed", dispute: { id: CLAIM_DISPUTE, status: "RESOLVED" } });
      expect(
        readable(page.rows.find((row) => row.seq === log.offerSeq)).status?.execution,
      ).toMatchObject({
        outcome: "executed",
        dispute: { id: OFFER_DISPUTE, status: "WAITING_FOR_BUYER_RESPONSE" },
      });
    });

    it("show a refused dispute action as failed, with no dispute", async () => {
      const page = await readDecisionRows(db, {}, READ_AT);
      expect(readable(page.rows.find((row) => row.seq === log.refusedSeq)).status).toMatchObject({
        kind: "approved",
        execution: { outcome: "failed", dispute: null },
      });
    });

    it("are found by the dispute's ID", async () => {
      const page = await readDecisionRows(db, { q: "PP-D-4012" }, READ_AT);
      expect(page.rows.map((row) => row.seq)).toEqual([log.evidenceSeq]);
    });
  });

  describe("decision detail", () => {
    it("lists the dispute intent's request, result with the dispute and status, and approval", async () => {
      const found = await readDecisionDetail(db, log.evidenceSeq, READ_AT, mandates);
      if (!found?.readable) throw new Error("not readable");
      expect(found.target).toMatchObject({ kind: "dispute", id: EVIDENCE_DISPUTE });
      expect(found.trail.map((entry) => entry.type)).toEqual([
        "decision",
        "approval",
        "execution.requested",
        "execution.result",
      ]);
      const [, , request, result] = found.trail;
      expect(request).toMatchObject({
        readable: true,
        parts: {
          kind: "execution.requested",
          request_id: null,
          action: "paypal.dispute.provide_evidence",
        },
      });
      expect(result).toMatchObject({
        readable: true,
        parts: {
          kind: "execution.result",
          outcome: "executed",
          refund: null,
          invoice: null,
          dispute: {
            id: EVIDENCE_DISPUTE,
            status: "UNDER_REVIEW",
            action: "paypal.dispute.provide_evidence",
          },
        },
      });
    });

    it("names an accepted claim's action in its result", async () => {
      const found = await readDecisionDetail(db, log.claimSeq, READ_AT, mandates);
      if (!found?.readable) throw new Error("not readable");
      expect(found.trail.at(-1)).toMatchObject({
        parts: { dispute: { id: CLAIM_DISPUTE, action: "paypal.dispute.accept_claim" } },
      });
    });
  });

  it("writes nothing", async () => {
    const before = await verifyLog(db);
    await readDecisionRows(db, {}, READ_AT);
    await readDecisionDetail(db, log.evidenceSeq, READ_AT, mandates);
    await readEntries(db, {});
    expect(await verifyLog(db)).toEqual(before);
  });
});
