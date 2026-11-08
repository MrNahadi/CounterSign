import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createMemoryShipmentStore, createMockCarrier } from "@countersign/carrier-mock";
import {
  createTestDatabase,
  type Database,
  type DatabaseHandle,
  eq,
  type Ticket,
  tickets,
  writeTicket,
} from "@countersign/db";
import { appendEntry } from "@countersign/ledger";
import { parseMandate } from "@countersign/mandate";
import { afterEach, describe, expect, it } from "vitest";
import { answerStepUp } from "../src/answer-step-up";
import { readVisitorMoney, VISITOR_MONEY_PROBLEMS } from "../src/audit-reader";
import { propose } from "../src/propose";
import { createFakeSandbox, httpError } from "./fake-sandbox";

// Money moved by "Attack it yourself" visitors, read from a log of real decisions: propose() on
// visitor and console tickets, step-ups answered with answerStepUp(), and the fake sandbox
// refusing one refund. PGlite and an injected time. Illustrative people and orders.

const SLOW = 120_000;
const NOW = new Date("2026-10-17T09:00:00+03:00");
const LATER = new Date(NOW.getTime() + 5 * 60 * 1000);
const READ_AT = new Date(NOW.getTime() + 10 * 60 * 1000);
const PRINCIPAL = "support-agent";
const PAYER = "otieno.b@example.com";
const OTHER = "grace.w@example.com";

const mandateFile = fileURLToPath(
  new URL("../../../packages/mandate/fixtures/kikapu-studio-v3.json", import.meta.url),
);
const parsedMandate = parseMandate(JSON.parse(readFileSync(mandateFile, "utf8")));
if (!parsedMandate.ok) throw new Error(parsedMandate.error);
const mandate = parsedMandate.mandate;

const usd = (minor: number) => ({ minor, currency: "USD" as const });

// Every order is the payer's: lost ones are refunded on their own, delivered ones are held.
const ORDERS = [
  { n: 1050, minor: 3000, shipment: "delivered" },
  { n: 1051, minor: 3100, shipment: "delivered" },
  { n: 1060, minor: 1000, shipment: "lost" },
  { n: 1061, minor: 1100, shipment: "lost" },
  { n: 1062, minor: 1200, shipment: "lost" },
];

function world() {
  const rail = createFakeSandbox();
  const shipments = new Map<string, unknown>();
  for (const { n, minor, shipment } of ORDERS) {
    const captureId = `CAP-${n}`;
    const orderId = `ORD-${n}`;
    const trackingNumber = `TRK${n}`;
    const capture = { id: captureId, status: "COMPLETED", amount: usd(minor), orderId };
    rail.captures.set(captureId, capture);
    rail.orders.set(orderId, {
      id: orderId,
      status: "COMPLETED",
      payerEmail: PAYER,
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

const ticketOf = (id: string, sender: string, origin: Ticket["origin"]): Ticket => ({
  id,
  channel: "email",
  senderEmail: sender,
  senderPhone: null,
  subject: `About my order (${id})`,
  body: "Simulated ticket. My order needs sorting out.",
  attachments: [],
  receivedAt: "2026-10-17T08:00:00+03:00",
  simulated: true,
  threadId: `THR-${id}`,
  ...(origin === undefined ? {} : { origin }),
});

const refund = (n: number, ticketId: string, claim: string) => ({
  tool: "create_refund",
  args: { capture_id: `CAP-${n}` },
  justification: { ticket_id: ticketId, claim },
});

describe("money moved by visitors", { timeout: SLOW }, () => {
  let handle: DatabaseHandle | undefined;

  afterEach(async () => {
    await handle?.close();
    handle = undefined;
  });

  async function open(): Promise<{ db: Database; w: ReturnType<typeof world> }> {
    handle = await createTestDatabase();
    return { db: handle.db, w: world() };
  }

  async function proposeOn(db: Database, w: ReturnType<typeof world>, proposal: unknown) {
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
  }

  async function approve(
    db: Database,
    w: ReturnType<typeof world>,
    decided: Awaited<ReturnType<typeof proposeOn>>,
  ) {
    const result = await answerStepUp({
      db,
      rail: w.rail,
      stepUpSeq: decided.seqs.decision,
      answer: "approve",
      intentHash: decided.record.intentHash,
      channel: "approvals_page",
      now: LATER,
      clock: () => LATER,
    });
    if (result.kind !== "answered") throw new Error(`not answered: ${result.kind}`);
  }

  it("reads $0.00 from an empty log", async () => {
    const { db } = await open();
    expect(await readVisitorMoney(db, READ_AT)).toEqual({
      known: true,
      moved: [{ currency: "USD", count: 0, total: { ...usd(0), display: "$0.00" } }],
    });
  });

  it("counts a visitor's allowed and approved refunds once each, and nothing else", async () => {
    const { db, w } = await open();
    for (const ticket of [
      ticketOf("TKT-ALLOW", PAYER, "visitor"),
      ticketOf("TKT-DENY", OTHER, "visitor"),
      ticketOf("TKT-HELD", PAYER, "visitor"),
      ticketOf("TKT-APPROVED", PAYER, "visitor"),
      ticketOf("TKT-FAILED", PAYER, "visitor"),
      ticketOf("TKT-CONSOLE", PAYER, undefined),
    ]) {
      await writeTicket(db, ticket);
    }
    const allowed = await proposeOn(db, w, refund(1060, "TKT-ALLOW", "not_received"));
    expect(allowed.record.decision).toBe("allow");
    // The same refund asked again is denied as a duplicate, and isn't counted twice.
    await proposeOn(db, w, refund(1060, "TKT-ALLOW", "not_received"));
    // Someone else's order is denied.
    const denied = await proposeOn(db, w, refund(1061, "TKT-DENY", "not_received"));
    expect(denied.record.decision).toBe("deny");
    // A wrong item is held: one left open, one approved and refunded.
    const held = await proposeOn(db, w, refund(1050, "TKT-HELD", "wrong_item"));
    expect(held.record.decision).toBe("step_up");
    const approved = await proposeOn(db, w, refund(1051, "TKT-APPROVED", "wrong_item"));
    await approve(db, w, approved);
    // PayPal refuses one allowed refund.
    w.rail.failures.refundCapture = httpError("refund-capture", 422, "UNPROCESSABLE_ENTITY");
    const failed = await proposeOn(db, w, refund(1062, "TKT-FAILED", "not_received"));
    expect(failed.record.decision).toBe("allow");
    w.rail.failures = {};
    // A console ticket's allowed refund isn't a visitor's.
    const console = await proposeOn(db, w, refund(1061, "TKT-CONSOLE", "not_received"));
    expect(console.record.decision).toBe("allow");

    expect(await readVisitorMoney(db, READ_AT)).toEqual({
      known: true,
      moved: [{ currency: "USD", count: 2, total: { ...usd(4100), display: "$41.00" } }],
    });
  });

  it("is unknown when a decision that let money move has lost its ticket", async () => {
    const { db, w } = await open();
    await writeTicket(db, ticketOf("TKT-GONE", PAYER, "visitor"));
    await proposeOn(db, w, refund(1060, "TKT-GONE", "not_received"));
    await db.delete(tickets).where(eq(tickets.id, "TKT-GONE"));
    expect(await readVisitorMoney(db, READ_AT)).toEqual({
      known: false,
      problem: VISITOR_MONEY_PROBLEMS.noTicket,
    });
  });

  it("is unknown when an answer to a visitor's step-up can't be read", async () => {
    const { db, w } = await open();
    await writeTicket(db, ticketOf("TKT-HELD", PAYER, "visitor"));
    const held = await proposeOn(db, w, refund(1050, "TKT-HELD", "wrong_item"));
    const intentId = held.record.intentId;
    if (intentId === null) throw new Error("no intent");
    const junk = await appendEntry(db, {
      entryType: "approval",
      refId: intentId,
      at: LATER.toISOString(),
      payload: { junk: true },
    });
    if (!junk.ok) throw new Error("not written");
    expect(await readVisitorMoney(db, READ_AT)).toEqual({
      known: false,
      problem: VISITOR_MONEY_PROBLEMS.unknownAnswer,
    });
  });

  it("is unknown when any decision can't be read, so it can't be ruled out", async () => {
    const { db } = await open();
    const junk = await appendEntry(db, {
      entryType: "decision",
      refId: null,
      at: LATER.toISOString(),
      payload: { junk: true },
    });
    if (!junk.ok) throw new Error("not written");
    expect(await readVisitorMoney(db, READ_AT)).toEqual({
      known: false,
      problem: VISITOR_MONEY_PROBLEMS.unreadable,
    });
  });
});
