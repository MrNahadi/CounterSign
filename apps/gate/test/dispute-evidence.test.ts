import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  type CarrierAdapter,
  createMemoryShipmentStore,
  createMockCarrier,
} from "@countersign/carrier-mock";
import {
  createTestDatabase,
  type Database,
  type DatabaseHandle,
  readEvidenceDocument,
  seedOrders,
  sha256Hex,
  type Ticket,
  writeTicket,
} from "@countersign/db";
import { checkEvidence } from "@countersign/ledger";
import { parseMandate } from "@countersign/mandate";
import { decodePDFRawStream, PDFDocument, PDFRawStream } from "pdf-lib";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { answerStepUp } from "../src/answer-step-up";
import {
  buildEvidencePack,
  type EvidencePack,
  type EvidencePackDeps,
  PACK_MESSAGES,
} from "../src/dispute-evidence";
import { CARRIER_SIMULATED, PDF_SECTIONS, RECOMPUTE_LINE, winAnsi } from "../src/evidence-pdf";
import { propose } from "../src/propose";
import { createFakeSandbox, httpError } from "./fake-sandbox";

// Evidence packs (ADR 0035) through buildEvidencePack, over PGlite, the fake sandbox and the
// carrier mock. Beat 5's KIK-1037 is delivered and tracked, was stepped up, approved and
// refunded, then disputed. KIK-1040 is stalled, has no decisions and a pending refund.

const SLOW = 120_000;
const NOW = new Date("2026-10-17T09:00:00+03:00");
const LATER = new Date(NOW.getTime() + 5 * 60 * 1000);
const PACK_AT = new Date("2026-10-22T10:00:00Z");
const REFUND_TIME = "2026-10-05T09:30:00Z";
const PRINCIPAL = "support-agent";

const mandateFile = fileURLToPath(
  new URL("../../../packages/mandate/fixtures/kikapu-studio-v3.json", import.meta.url),
);
const parsedMandate = parseMandate(JSON.parse(readFileSync(mandateFile, "utf8")));
if (!parsedMandate.ok) throw new Error(parsedMandate.error);
const mandate = parsedMandate.mandate;

const usd = (minor: number) => ({ minor, currency: "USD" as const });

// Illustrative people and orders.
const PAYER_1037 = "wanjiru.m@example.com";
const PAYER_1040 = "amina.k@example.com";
const TICKET_SUBJECT = "Arrived broken (TKT-1037)";
const TICKET_BODY = "Simulated ticket. The bowl arrived in pieces, photo attached.";
const ORDERS = [
  { n: 1037, minor: 24000, payerEmail: PAYER_1037, shipment: "delivered" },
  { n: 1040, minor: 4500, payerEmail: PAYER_1040, shipment: "stalled_10d" },
];

function world() {
  const rail = createFakeSandbox();
  const shipments = new Map<string, unknown>();
  for (const { n, minor, payerEmail, shipment } of ORDERS) {
    const captureId = `CAP-${n}`;
    const orderId = `ORD-${n}`;
    const trackingNumber = `TRK${n}`;
    const capture = { id: captureId, status: "COMPLETED", amount: usd(minor), orderId };
    rail.captures.set(captureId, { ...capture, createTime: "2026-10-01T08:00:05Z" });
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
      scanEvents: [
        { at: "2026-10-02T08:00:00Z", description: "Accepted", place: "Nairobi" },
        { at: "2026-10-04T15:30:00Z", description: "Delivered to recipient", place: "Mombasa" },
      ],
      updatedAt: "2026-10-05T08:00:00Z",
    });
    rail.disputeDetails.set(`PP-D-${n}`, {
      id: `PP-D-${n}`,
      status: "WAITING_FOR_SELLER_RESPONSE",
      amount: usd(minor),
      captureIds: [captureId],
      reason: "MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED",
      lifeCycleStage: "CHARGEBACK",
      sellerResponseDueDate: "2026-11-01T23:59:59Z",
    });
  }
  return { rail, carrier: createMockCarrier(createMemoryShipmentStore(shipments)) };
}

const ticket: Ticket = {
  id: "TKT-1037",
  channel: "email",
  senderEmail: PAYER_1037,
  senderPhone: null,
  subject: TICKET_SUBJECT,
  body: TICKET_BODY,
  attachments: [{ id: "ATT-TKT-1037-0", contentType: "image/jpeg" }],
  receivedAt: "2026-10-17T08:00:00+03:00",
  simulated: true,
  threadId: "THR-TKT-1037",
};

// Every string a PDF draws, from its content streams.
async function pdfText(bytes: Uint8Array): Promise<{ text: string; pages: number }> {
  const doc = await PDFDocument.load(bytes);
  const parts: string[] = [];
  for (const [, object] of doc.context.enumerateIndirectObjects()) {
    if (!(object instanceof PDFRawStream)) continue;
    const decoded = Buffer.from(decodePDFRawStream(object).decode()).toString("latin1");
    for (const match of decoded.matchAll(/<([0-9A-Fa-f]*)>\s*Tj/g)) {
      parts.push(Buffer.from(match[1] ?? "", "hex").toString("latin1"));
    }
  }
  return { text: parts.join("\n"), pages: doc.getPageCount() };
}

const built = (pack: EvidencePack) => {
  if (!pack.ok) throw new Error(pack.message);
  return pack;
};

describe("evidence packs", { timeout: SLOW }, () => {
  let handle: DatabaseHandle;
  let db: Database;
  let w: ReturnType<typeof world>;
  let refundId: string;
  let deps: EvidencePackDeps;

  beforeAll(async () => {
    handle = await createTestDatabase();
    db = handle.db;
    w = world();
    await writeTicket(db, ticket);
    await db.insert(seedOrders).values(
      ORDERS.map(({ n, minor, payerEmail }) => ({
        orderNumber: `KIK-${n}`,
        runId: "run-illustrative",
        paypalOrderId: `ORD-${n}`,
        paypalCaptureId: `CAP-${n}`,
        amountMinor: minor,
        currency: "USD",
        payerEmail,
        buyer: "A",
        trackingNumber: `TRK${n}`,
        role: "illustrative",
        seededAt: "2026-10-01T08:00:00Z",
      })),
    );
    const held = await propose({
      mandate,
      principal: PRINCIPAL,
      proposal: {
        tool: "create_refund",
        args: { capture_id: "CAP-1037", amount: { value: "240.00", currency_code: "USD" } },
        justification: { ticket_id: "TKT-1037", claim: "damaged" },
      },
      now: NOW,
      ...w,
      db,
      clock: () => NOW,
    });
    if (!held.ok || held.replay || held.record.decision !== "step_up") {
      throw new Error("not stepped up");
    }
    const answered = await answerStepUp({
      db,
      rail: w.rail,
      stepUpSeq: held.seqs.decision,
      answer: "approve",
      intentHash: held.record.intentHash,
      channel: "approvals_page",
      now: LATER,
      clock: () => LATER,
    });
    if (answered.kind !== "answered") throw new Error("not answered");
    const id = answered.execution?.refund?.id;
    if (!id) throw new Error("no refund");
    refundId = id;
    // PayPal's own time for KIK-1037's refund (the fake sandbox doesn't make one up).
    const refunded = w.rail.orders.get("ORD-1037")?.purchaseUnits[0]?.refunds[0];
    if (!refunded) throw new Error("no refund on the order");
    refunded.createTime = REFUND_TIME;
    // KIK-1040 has a refund that hasn't completed, and PayPal gave it no time.
    w.rail.orders.get("ORD-1040")?.purchaseUnits[0]?.refunds.push({
      id: "REFUND-PENDING-40",
      status: "PENDING",
      amount: usd(1000),
      captureId: "CAP-1040",
    });
  }, SLOW);

  beforeEach(() => {
    w.rail.failures = {};
    deps = { db, rail: w.rail, carrier: w.carrier, now: PACK_AT };
  });

  afterAll(async () => {
    await handle.close();
  });

  it("holds every fact from records, and no payer email, ticket sender or ticket text", async () => {
    const { facts } = built(await buildEvidencePack("PP-D-1037", deps));
    expect(facts.dispute).toEqual({
      id: "PP-D-1037",
      status: "WAITING_FOR_SELLER_RESPONSE",
      reason: "MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED",
      reasonWords: "Item not as described",
      lifeCycleStage: "CHARGEBACK",
      amount: { minor: 24000, currency: "USD", display: "$240.00" },
      sellerResponseDueDate: "2026-11-01T23:59:59Z",
    });
    expect(facts.capture).toEqual({
      id: "CAP-1037",
      amount: { minor: 24000, currency: "USD", display: "$240.00" },
      status: "COMPLETED",
      time: "2026-10-01T08:00:05Z",
    });
    expect(facts.orderNumber).toBe("KIK-1037");
    expect(facts.shipping).toEqual([
      {
        trackingNumber: "TRK1037",
        trackerStatus: "SHIPPED",
        carrier: {
          source: "Carrier (simulated)",
          carrierName: "Illustrative Post",
          status: "delivered",
          scanEvents: [
            { at: "2026-10-02T08:00:00Z", description: "Accepted", place: "Nairobi" },
            {
              at: "2026-10-04T15:30:00Z",
              description: "Delivered to recipient",
              place: "Mombasa",
            },
          ],
        },
      },
    ]);
    expect(facts.refunds).toEqual([
      {
        id: refundId,
        amount: { minor: 24000, currency: "USD", display: "$240.00" },
        status: "COMPLETED",
        time: REFUND_TIME,
      },
    ]);
    expect(facts.decisions).toHaveLength(1);
    expect(facts.decisions?.[0]).toMatchObject({
      actionWords: "Refund",
      amount: { display: "$240.00" },
      decision: "step_up",
      decisionWords: "Step-up",
      claimWords: expect.any(String),
    });
    expect(facts.decisions?.[0]?.reasons.length).toBeGreaterThan(0);
    expect(facts.audit).toMatchObject({
      intact: true,
      exportName: "countersign-evidence-capture-CAP-1037.json",
    });
    expect(facts.audit?.entryCount).toBeGreaterThanOrEqual(4);
    expect(facts.notAvailable).toEqual([]);
    expect(facts.preparedAt).toBe(PACK_AT.toISOString());

    const text = JSON.stringify(facts);
    for (const secret of [PAYER_1037, TICKET_SUBJECT, TICKET_BODY, "TKT-1037", "@"]) {
      expect(text).not.toContain(secret);
    }
  });

  it("stores an export that passes checkEvidence and a PDF with every section, under 1 MB", async () => {
    const { documents, facts } = built(await buildEvidencePack("PP-D-1037", deps));
    expect(documents.map(({ kind, name, contentType }) => ({ kind, name, contentType }))).toEqual([
      {
        kind: "export",
        name: "countersign-evidence-capture-CAP-1037.json",
        contentType: "application/json",
      },
      { kind: "pdf", name: "countersign-evidence-PP-D-1037.pdf", contentType: "application/pdf" },
    ]);
    const [exportDoc, pdfDoc] = await Promise.all(
      documents.map((document) => readEvidenceDocument(db, document.id)),
    );
    if (!exportDoc || !pdfDoc) throw new Error("not stored");
    const checked = checkEvidence(JSON.parse(Buffer.from(exportDoc.bytes).toString("utf8")));
    expect(checked.ok && checked.problems).toEqual([]);
    expect(facts.audit?.exportSha256).toBe(exportDoc.sha256);

    expect(pdfDoc.size).toBeLessThan(1024 * 1024);
    const { text, pages } = await pdfText(pdfDoc.bytes);
    expect(pages).toBeGreaterThanOrEqual(1);
    expect(pages).toBeLessThanOrEqual(6);
    expect(text).toContain("Evidence for dispute PP-D-1037");
    expect(text).toContain(
      "Prepared by Countersign for Kikapu Studio (illustrative) from PayPal sandbox records on 22 Oct 2026.",
    );
    for (const section of PDF_SECTIONS) expect(text).toContain(section);
    expect(text).toContain(CARRIER_SIMULATED);
    expect(text).toContain("Carrier (simulated): Illustrative Post, delivered");
    expect(text).toContain(exportDoc.sha256);
    expect(text).toContain(RECOMPUTE_LINE);
    expect(text).toContain(refundId);
    expect(text).toContain(`Time: ${REFUND_TIME}`);
    expect(text).not.toContain(PAYER_1037);
    const loaded = await PDFDocument.load(pdfDoc.bytes);
    expect(loaded.getCreationDate()?.toISOString()).toBe(PACK_AT.toISOString());
  });

  it("stores each document with the SHA-256 and size of its bytes", async () => {
    const { documents } = built(await buildEvidencePack("PP-D-1037", deps));
    for (const document of documents) {
      const stored = await readEvidenceDocument(db, document.id);
      if (!stored) throw new Error("not stored");
      expect(document.id).toMatch(/^doc_[0-9a-f]{24}$/);
      expect(stored.disputeId).toBe("PP-D-1037");
      expect(stored.sha256).toBe(sha256Hex(stored.bytes));
      expect(document.sha256).toBe(stored.sha256);
      expect(document.size).toBe(stored.bytes.byteLength);
    }
  });

  it("suggests fulfilment and refund items, each with the PDF", async () => {
    const { suggested, documents } = built(await buildEvidencePack("PP-D-1037", deps));
    const pdfId = documents.find((document) => document.kind === "pdf")?.id;
    expect(suggested).toEqual([
      {
        evidenceType: "PROOF_OF_FULFILLMENT",
        trackingNumbers: ["TRK1037"],
        refundIds: [],
        documentId: pdfId,
      },
      {
        evidenceType: "PROOF_OF_REFUND",
        trackingNumbers: [],
        refundIds: [refundId],
        documentId: pdfId,
      },
    ]);
  });

  it("suggests other when nothing was delivered and no refund completed", async () => {
    const pack = built(await buildEvidencePack("PP-D-1040", deps));
    const pdfId = pack.documents.find((document) => document.kind === "pdf")?.id;
    expect(pack.suggested).toEqual([
      { evidenceType: "OTHER", trackingNumbers: [], refundIds: [], documentId: pdfId },
    ]);
    // No decisions name KIK-1040, so there's no export to store.
    expect(pack.facts.decisions).toEqual([]);
    expect(pack.facts.audit).toBeNull();
    expect(pack.documents.map((document) => document.kind)).toEqual(["pdf"]);
  });

  it("gives a refund PayPal gave no time as null, and the PDF says Not available", async () => {
    const pack = built(await buildEvidencePack("PP-D-1040", deps));
    expect(pack.facts.refunds).toEqual([
      {
        id: "REFUND-PENDING-40",
        amount: { minor: 1000, currency: "USD", display: "$10.00" },
        status: "PENDING",
        time: null,
      },
    ]);
    const pdf = pack.documents.find((document) => document.kind === "pdf");
    const stored = pdf && (await readEvidenceDocument(db, pdf.id));
    if (!stored) throw new Error("not stored");
    const { text } = await pdfText(stored.bytes);
    expect(text).toContain("Refund REFUND-PENDING-40: $10.00, PENDING");
    expect(text).toContain("Time: Not available");
  });

  it("lists an unreadable carrier read as not available and still builds", async () => {
    const carrier: CarrierAdapter = {
      async getShipment() {
        throw new Error("carrier down");
      },
    };
    const pack = built(await buildEvidencePack("PP-D-1037", { ...deps, carrier }));
    expect(pack.facts.notAvailable).toEqual(["Not available: carrier-shipment TRK1037"]);
    expect(pack.facts.shipping?.[0]?.carrier).toBeNull();
    expect(pack.suggested.map((item) => item.evidenceType)).toEqual(["PROOF_OF_REFUND"]);
    const pdf = pack.documents.find((document) => document.kind === "pdf");
    const stored = pdf && (await readEvidenceDocument(db, pdf.id));
    if (!stored) throw new Error("not stored");
    expect((await pdfText(stored.bytes)).text).toContain("Not available: carrier-shipment TRK1037");
  });

  it("lists an unreadable order, and so its trackers and refunds, as not available", async () => {
    w.rail.failures.getOrder = httpError("get-order", 500);
    const pack = built(await buildEvidencePack("PP-D-1037", deps));
    expect(pack.facts.notAvailable).toEqual(["Not available: get-order ORD-1037"]);
    expect(pack.facts.shipping).toBeNull();
    expect(pack.facts.refunds).toBeNull();
    expect(pack.suggested.map((item) => item.evidenceType)).toEqual(["OTHER"]);
  });

  it("doesn't build for a dispute that can't be read, and says so", async () => {
    w.rail.failures.getDispute = httpError("get-dispute", 503);
    expect(await buildEvidencePack("PP-D-1037", deps)).toEqual({
      ok: false,
      code: "DISPUTE_UNREADABLE",
      message: PACK_MESSAGES.DISPUTE_UNREADABLE,
    });
  });

  it("doesn't build for a dispute that names no capture the shop holds, and says so", async () => {
    for (const captureIds of [[], ["CAP-NOT-OURS"]]) {
      w.rail.disputeDetails.set("PP-D-9", {
        id: "PP-D-9",
        status: "WAITING_FOR_SELLER_RESPONSE",
        amount: usd(100),
        captureIds,
      });
      expect(await buildEvidencePack("PP-D-9", deps)).toEqual({
        ok: false,
        code: "NO_CAPTURE",
        message: PACK_MESSAGES.NO_CAPTURE,
      });
    }
  });

  it("replaces text Helvetica can't print with a question mark", () => {
    expect(winAnsi("Café — 東京 ✓")).toBe("Café — ?? ?");
  });
});
