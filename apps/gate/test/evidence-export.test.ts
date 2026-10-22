import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createMemoryShipmentStore, createMockCarrier } from "@countersign/carrier-mock";
import {
  asc,
  auditLog,
  createTestDatabase,
  type Database,
  type DatabaseHandle,
  seedOrders,
  type Ticket,
  writeTicket,
} from "@countersign/db";
import { checkEvidence, verifyLog } from "@countersign/ledger";
import { parseMandate } from "@countersign/mandate";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { answerStepUp } from "../src/answer-step-up";
import { exportEvidence } from "../src/evidence-export";
import { propose } from "../src/propose";
import { handlePayPalWebhook } from "../src/webhook";
import { createFakeSandbox } from "./fake-sandbox";

// Evidence selection (ADR 0034) over a log built from real decisions: beat 4 refunded, beat 5
// held, approved, refunded and reconciled, a second proposal on beat 5's capture, and a refund
// nobody requested, once on that capture and once on another. PGlite and an injected time.

const SLOW = 120_000;
const NOW = new Date("2026-10-17T09:00:00+03:00");
const LATER = new Date(NOW.getTime() + 5 * 60 * 1000);
const EXPORT_AT = new Date(NOW.getTime() + 10 * 60 * 1000);
const PRINCIPAL = "support-agent";
const WEBHOOK_ID = "WH-FAKE-0123456789";

const mandateFile = fileURLToPath(
  new URL("../../../packages/mandate/fixtures/kikapu-studio-v3.json", import.meta.url),
);
const parsedMandate = parseMandate(JSON.parse(readFileSync(mandateFile, "utf8")));
if (!parsedMandate.ok) throw new Error(parsedMandate.error);
const mandate = parsedMandate.mandate;

const usd = (minor: number) => ({ minor, currency: "USD" as const });

const ORDERS = [
  { n: 1040, minor: 4500, payerEmail: "amina.k@example.com", shipment: "stalled_10d" },
  { n: 1037, minor: 24000, payerEmail: "wanjiru.m@example.com", shipment: "delivered" },
];

function world() {
  const rail = createFakeSandbox();
  const shipments = new Map<string, unknown>();
  for (const { n, minor, payerEmail, shipment } of ORDERS) {
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
  return { rail, carrier: createMockCarrier(createMemoryShipmentStore(shipments)) };
}

const ticketOf = (id: string, senderEmail: string, images: number): Ticket => ({
  id,
  channel: "email",
  senderEmail,
  senderPhone: null,
  subject: `About my order (${id})`,
  body: "Simulated ticket. My order needs sorting out.",
  attachments: Array.from({ length: images }, (_, index) => ({
    id: `ATT-${id}-${index}`,
    contentType: "image/jpeg",
  })),
  receivedAt: "2026-10-17T08:00:00+03:00",
  simulated: true,
  threadId: `THR-${id}`,
});

const refund = (n: number, value: string, ticketId: string, claim: string) => ({
  tool: "create_refund",
  args: { capture_id: `CAP-${n}`, amount: { value, currency_code: "USD" } },
  justification: { ticket_id: ticketId, claim },
});

const TRANSMISSION = {
  "paypal-transmission-id": "b2c3d4e5-transmission-id-header",
  "paypal-transmission-time": "2026-10-17T09:29:58Z",
  "paypal-cert-url": "https://api.sandbox.paypal.com/v1/notifications/certs/CERT-fake-cert-header",
  "paypal-auth-algo": "SHA256withRSA",
  "paypal-transmission-sig": "c2lnbmF0dXJlLXRyYW5zbWlzc2lvbi1zaWctaGVhZGVy",
};

describe("evidence selection", { timeout: SLOW }, () => {
  let handle: DatabaseHandle;
  let db: Database;
  let beat4Intent: string;
  let beat5Intent: string;
  let secondIntent: string;
  let mandateSeq: number;

  const seqsOf = async (rows: { seq: number }[]) => rows.map((row) => row.seq);
  const all = async () => db.select().from(auditLog).orderBy(asc(auditLog.seq));
  const fileSeqs = async (scope: { kind: "intent" | "capture"; id: string }) => {
    const out = await exportEvidence(db, scope, EXPORT_AT);
    if (out.kind !== "file") throw new Error("not found");
    return { file: out.file, seqs: out.file.entries.map((entry) => entry.seq) };
  };

  beforeAll(async () => {
    handle = await createTestDatabase();
    db = handle.db;
    const w = world();
    await writeTicket(db, ticketOf("TKT-1040", "amina.k@example.com", 0));
    await writeTicket(db, ticketOf("TKT-1037", "wanjiru.m@example.com", 1));
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
    const proposeAt = async (proposal: unknown) => {
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
    const beat4 = await proposeAt(refund(1040, "45.00", "TKT-1040", "not_received"));
    const beat5 = await proposeAt(refund(1037, "240.00", "TKT-1037", "damaged"));
    const answered = await answerStepUp({
      db,
      rail: w.rail,
      stepUpSeq: beat5.seqs.decision,
      answer: "approve",
      intentHash: beat5.record.intentHash,
      channel: "approvals_page",
      now: LATER,
      clock: () => LATER,
    });
    if (answered.kind !== "answered") throw new Error("not answered");
    const refundId = answered.execution?.refund?.id;
    if (!refundId) throw new Error("no refund");
    // A second proposal on beat 5's capture, a different intent.
    const second = await proposeAt(refund(1037, "10.00", "TKT-1037", "damaged"));
    w.rail.refunds.set("REFUND-DASH-37", {
      id: "REFUND-DASH-37",
      status: "COMPLETED",
      amount: usd(500),
      captureId: "CAP-1037",
    });
    w.rail.refunds.set("REFUND-DASH-36", {
      id: "REFUND-DASH-36",
      status: "COMPLETED",
      amount: usd(700),
      captureId: "CAP-1036",
    });
    for (const [event, id] of [
      ["WH-EVT-1", refundId],
      ["WH-EVT-2", "REFUND-DASH-37"],
      ["WH-EVT-3", "REFUND-DASH-36"],
    ] as const) {
      const reconciled = await handlePayPalWebhook(
        {
          headers: TRANSMISSION,
          body: Buffer.from(
            JSON.stringify({
              id: event,
              event_type: "PAYMENT.CAPTURE.REFUNDED",
              resource: { id },
            }),
          ),
        },
        { db, rail: () => w.rail, env: { PAYPAL_WEBHOOK_ID: WEBHOOK_ID }, clock: () => LATER },
      );
      expect(reconciled.status).toBe(200);
    }
    if (!beat4.record.intentId || !beat5.record.intentId || !second.record.intentId) {
      throw new Error("no intent");
    }
    beat4Intent = beat4.record.intentId;
    beat5Intent = beat5.record.intentId;
    secondIntent = second.record.intentId;
    const [mandateRow] = (await all()).filter((row) => row.entryType === "mandate.version");
    if (!mandateRow) throw new Error("no mandate entry");
    mandateSeq = mandateRow.seq;
  }, SLOW);

  afterAll(async () => {
    await handle.close();
  });

  it("selects an intent's entries and the mandate its decision points at", async () => {
    const rows = await all();
    const { file, seqs } = await fileSeqs({ kind: "intent", id: beat5Intent });
    const own = rows.filter((row) => row.refId === beat5Intent);
    expect(own.map((row) => row.entryType)).toEqual(
      expect.arrayContaining([
        "decision",
        "approval",
        "execution.requested",
        "execution.result",
        "reconciliation",
      ]),
    );
    expect(seqs).toEqual([...(await seqsOf(own)), mandateSeq].sort((a, b) => a - b));
    expect(file.scope).toEqual({ kind: "intent", id: beat5Intent });
    expect(file.exported_at).toBe(EXPORT_AT.toISOString());
    expect(file.entries.map((entry) => entry.payload)).toEqual(
      rows.filter((row) => seqs.includes(row.seq)).map((row) => row.payload),
    );
  });

  it("selects a capture's intents, its reconciliations and unmatched ones, and nothing else", async () => {
    const rows = await all();
    const { seqs } = await fileSeqs({ kind: "capture", id: "CAP-1037" });
    const refs = new Set([beat5Intent, secondIntent]);
    const own = rows.filter((row) => row.refId !== null && refs.has(row.refId));
    const unmatched = rows.filter(
      (row) =>
        row.entryType === "reconciliation" &&
        row.refId === null &&
        row.payload.includes('"captureId":"CAP-1037"'),
    );
    expect(unmatched).toHaveLength(1);
    expect(seqs).toEqual(
      [...(await seqsOf(own)), ...(await seqsOf(unmatched)), mandateSeq].sort((a, b) => a - b),
    );
    const other = rows.filter((row) => row.refId === beat4Intent).map((row) => row.seq);
    expect(seqs.some((seq) => other.includes(seq))).toBe(false);
    const dashboard36 = rows.filter((row) => row.payload.includes('"captureId":"CAP-1036"'));
    expect(dashboard36).toHaveLength(1);
    expect(seqs).not.toContain(dashboard36[0]?.seq);
  });

  it("builds a file that passes checkEvidence, with a fresh chain verdict", async () => {
    for (const scope of [
      { kind: "intent", id: beat5Intent },
      { kind: "capture", id: "CAP-1037" },
    ] as const) {
      const { file } = await fileSeqs(scope);
      const checked = checkEvidence(JSON.parse(JSON.stringify(file)));
      expect(checked).toMatchObject({ ok: true, problems: [] });
      const verdict = await verifyLog(db);
      expect(file.chain).toMatchObject({ intact: true, entry_count: (await all()).length });
      expect(verdict.intact).toBe(true);
    }
  });

  it("answers not found when nothing is selected, and never appends", async () => {
    const before = await all();
    expect(await exportEvidence(db, { kind: "intent", id: "int_nope" }, EXPORT_AT)).toEqual({
      kind: "not_found",
    });
    expect(await exportEvidence(db, { kind: "capture", id: "CAP-none" }, EXPORT_AT)).toEqual({
      kind: "not_found",
    });
    await exportEvidence(db, { kind: "capture", id: "CAP-1037" }, EXPORT_AT);
    expect((await all()).map((row) => row.hash)).toEqual(before.map((row) => row.hash));
  });
});
