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
import { verifyLog } from "@countersign/ledger";
import { parseMandate } from "@countersign/mandate";
import { CALLS } from "@countersign/verifiers";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { readTicketRecord } from "../src/live-records";
import { type ProposeResult, propose } from "../src/propose";
import { createFakeSandbox, httpError } from "./fake-sandbox";

// propose() for the guarded actions other than a refund, and the ticket store read every action
// makes. Illustrative IDs and people in PayPal's sandbox shapes.

const SLOW = 60_000;
const NOW = new Date("2026-10-17T09:00:00+03:00");
const PRINCIPAL = "support-agent";
const PAYER = "amina.k@example.com";

const mandateFile = fileURLToPath(
  new URL("../../../packages/mandate/fixtures/kikapu-studio-v3.json", import.meta.url),
);
const parsedMandate = parseMandate(JSON.parse(readFileSync(mandateFile, "utf8")));
if (!parsedMandate.ok) throw new Error(parsedMandate.error);
const mandate = parsedMandate.mandate;

const usd = (minor: number) => ({ minor, currency: "USD" as const });

const DISPUTE = "PP-D-4012";
const INVOICE = "INV2-ABCD-EFGH-IJKL-MNOP";
const ORDER = "ORD-1050";

function world() {
  const rail = createFakeSandbox();
  rail.disputeDetails.set(DISPUTE, {
    id: DISPUTE,
    status: "WAITING_FOR_SELLER_RESPONSE",
    amount: usd(4500),
    captureIds: ["CAP-1038"],
  });
  rail.invoices.set(INVOICE, {
    id: INVOICE,
    status: "DRAFT",
    amount: usd(2500),
    invoiceNumber: "KIK-INV-0007",
    recipientEmails: [PAYER],
  });
  rail.orders.set(ORDER, {
    id: ORDER,
    status: "APPROVED",
    payerEmail: PAYER,
    payerId: "PAYER1050",
    purchaseUnits: [
      {
        referenceId: "KIK-1050",
        customId: null,
        invoiceId: null,
        amount: usd(3200),
        captures: [],
        trackers: [],
        refunds: [],
      },
    ],
  });
  const carrier = createMockCarrier(createMemoryShipmentStore(new Map()));
  return { rail, carrier };
}

const justification = { ticket_id: "TKT-2001" };

const PROPOSALS = {
  accept_dispute_claim: {
    tool: "accept_dispute_claim",
    args: { dispute_id: DISPUTE, note: "Refunding in full, sorry for the trouble." },
    justification,
  },
  provide_dispute_evidence: {
    tool: "provide_dispute_evidence",
    args: {
      dispute_id: DISPUTE,
      evidence: [{ evidence_type: "PROOF_OF_FULFILLMENT", notes: "Delivered on 2 October." }],
    },
    justification,
  },
  make_offer: {
    tool: "make_offer",
    args: {
      dispute_id: DISPUTE,
      offer_type: "REFUND",
      offer_amount: { value: "20.00", currency_code: "USD" },
      note: "Half back for the scratch.",
    },
    justification,
  },
  send_invoice: { tool: "send_invoice", args: { invoice_id: INVOICE }, justification },
  pay_order: { tool: "pay_order", args: { id: ORDER }, justification },
  create_payout: {
    tool: "create_payout",
    args: { receiver: " Grace.W@Example.com ", amount: { value: "50.00", currency_code: "USD" } },
    justification,
  },
} as const;

// The reads each action should make, besides the ticket store.
const EXPECTED_READS: Record<keyof typeof PROPOSALS, string[]> = {
  accept_dispute_claim: ["getDispute"],
  provide_dispute_evidence: ["getDispute"],
  make_offer: ["getDispute"],
  send_invoice: ["getInvoice"],
  pay_order: ["getOrder"],
  create_payout: [],
};

const EXPECTED_DECISIONS: Record<keyof typeof PROPOSALS, [string, string[]]> = {
  accept_dispute_claim: ["step_up", ["ALWAYS_NEEDS_APPROVAL"]],
  provide_dispute_evidence: ["step_up", ["ALWAYS_NEEDS_APPROVAL"]],
  make_offer: ["step_up", ["ALWAYS_NEEDS_APPROVAL"]],
  send_invoice: ["step_up", ["ALWAYS_NEEDS_APPROVAL"]],
  pay_order: ["deny", ["NO_MATCHING_RULE"]],
  create_payout: ["deny", ["NO_MATCHING_RULE"]],
};

// Calls that would move money or change a PayPal record.
const MONEY_MOVING = ["refundCapture", "captureOrder", "createOrder", "addTracker"];

describe("propose: the guarded actions other than a refund", { timeout: SLOW }, () => {
  let handle: DatabaseHandle;
  let db: Database;

  beforeAll(async () => {
    handle = await createTestDatabase();
    db = handle.db;
  }, SLOW);

  beforeEach(async () => {
    await db.execute(sql`TRUNCATE audit_log, tickets`);
    await writeTicket(db, {
      id: "TKT-2001",
      channel: "email",
      senderEmail: PAYER,
      senderPhone: null,
      subject: "About my order",
      body: "Simulated ticket.",
      attachments: [],
      receivedAt: "2026-10-17T08:00:00+03:00",
      simulated: true,
    });
  });

  afterAll(async () => {
    await handle.close();
  });

  const entries = () => db.select().from(auditLog).orderBy(asc(auditLog.seq));
  const run = (w: ReturnType<typeof world>, proposal: unknown) =>
    propose({ mandate, principal: PRINCIPAL, proposal, now: NOW, ...w, db });
  const decided = (result: ProposeResult) => {
    if (!result.ok || result.replay) throw new Error("not decided");
    return result;
  };

  for (const tool of Object.keys(PROPOSALS) as (keyof typeof PROPOSALS)[]) {
    it(`${tool} reads its own record, is decided and recorded, and executes nothing`, async () => {
      const w = world();
      const result = decided(await run(w, PROPOSALS[tool]));

      expect(w.rail.calls.map((call) => call.call)).toEqual(EXPECTED_READS[tool]);
      expect(result.problems).toEqual([]);
      const [decision, codes] = EXPECTED_DECISIONS[tool];
      expect(result.record.decision).toBe(decision);
      expect(result.record.reasons.map((reason) => reason.code)).toEqual(codes);
      expect(result.execution).toBeNull();
      expect(result.seqs.request).toBeNull();

      const types = (await entries()).map((row) => row.entryType);
      expect(types.filter((type) => type.startsWith("execution."))).toEqual([]);
      expect(types.filter((type) => type === "decision")).toHaveLength(1);
      expect(w.rail.calls.some((call) => MONEY_MOVING.includes(call.call))).toBe(false);
      expect((await verifyLog(db)).intact).toBe(true);
    });
  }

  it("decides a repeated dispute action again rather than treating it as a replay", async () => {
    const w = world();
    const first = decided(await run(w, PROPOSALS.accept_dispute_claim));
    const second = decided(await run(w, PROPOSALS.accept_dispute_claim));

    expect(second.record.intentId).toBe(first.record.intentId);
    expect(second.record.decision).toBe("step_up");
    expect(second.seqs.decision).toBeGreaterThan(first.seqs.decision);
    const types = (await entries()).map((row) => row.entryType);
    expect(types.filter((type) => type === "decision")).toHaveLength(2);
    expect(types.filter((type) => type.startsWith("execution."))).toEqual([]);
  });

  it("leaves the dispute out on a failed read, with one read problem, and denies TARGET_UNKNOWN", async () => {
    const w = world();
    w.rail.failures.getDispute = httpError("get-dispute", 500, "INTERNAL_SERVER_ERROR");
    const result = decided(await run(w, PROPOSALS.make_offer));

    expect(result.problems).toHaveLength(1);
    expect(result.problems[0]?.call).toBe("get-dispute");
    expect(result.record.decision).toBe("deny");
    expect(result.record.reasons.map((reason) => reason.code)).toEqual(["TARGET_UNKNOWN"]);
    expect(result.record.reasons[0]?.detail).toContain(DISPUTE);
  });

  it("denies an invoice that doesn't exist TARGET_UNKNOWN, with one read problem", async () => {
    const w = world();
    const proposal = { ...PROPOSALS.send_invoice, args: { invoice_id: "INV2-NONE" } };
    const result = decided(await run(w, proposal));

    expect(result.problems.map((problem) => problem.call)).toEqual(["get-invoice"]);
    expect(result.record.reasons.map((reason) => reason.code)).toEqual(["TARGET_UNKNOWN"]);
  });

  it("reads no ticket for a proposal that names none, and an unknown ticket ID adds no problem", async () => {
    const w = world();
    const none = decided(await run(w, { tool: "pay_order", args: { id: ORDER } }));
    const unknown = decided(
      await run(w, { ...PROPOSALS.pay_order, justification: { ticket_id: "TKT-NONE" } }),
    );

    expect(none.problems).toEqual([]);
    expect(unknown.problems).toEqual([]);
    expect(unknown.record.reasons.map((reason) => reason.code)).toEqual(["NO_MATCHING_RULE"]);
  });

  it("denies a refund whose ticket isn't stored, with ticket.from_payer unknown", async () => {
    const rail = createFakeSandbox();
    const capture = { id: "CAP-1035", status: "COMPLETED", amount: usd(1800), orderId: "ORD-1035" };
    rail.captures.set(capture.id, capture);
    rail.orders.set("ORD-1035", {
      id: "ORD-1035",
      status: "COMPLETED",
      payerEmail: PAYER,
      payerId: "PAYER1035",
      purchaseUnits: [
        {
          referenceId: "KIK-1035",
          customId: null,
          invoiceId: null,
          amount: usd(1800),
          captures: [capture],
          trackers: [
            {
              id: "CAP-1035-TRK1035",
              captureId: "CAP-1035",
              trackingNumber: "TRK1035",
              status: "SHIPPED",
            },
          ],
          refunds: [],
        },
      ],
    });
    const carrier = createMockCarrier(
      createMemoryShipmentStore(
        new Map([
          [
            "TRK1035",
            {
              trackingNumber: "TRK1035",
              carrierName: "Illustrative Post",
              status: "stalled_10d",
              scanEvents: [
                { at: "2026-10-02T08:00:00Z", description: "Accepted", place: "Nairobi" },
              ],
              updatedAt: "2026-10-05T08:00:00Z",
            },
          ],
        ]),
      ),
    );
    const proposal = {
      tool: "create_refund",
      args: { capture_id: "CAP-1035", amount: { value: "18.00", currency_code: "USD" } },
      justification: { ticket_id: "TKT-1035", claim: "not_received" },
    };
    const result = decided(
      await propose({ mandate, principal: PRINCIPAL, proposal, now: NOW, rail, carrier, db }),
    );

    const trace = Object.fromEntries(result.record.trace.map((e) => [e.verifier, e.result]));
    expect(trace["ticket.from_payer"]).toBe("unknown");
    expect(result.record.decision).not.toBe("allow");
    expect(result.execution).toBeNull();
    expect(rail.calls.some((call) => call.call === "refundCapture")).toBe(false);
  });
});

describe("readTicketRecord", () => {
  it("leaves the ticket out with one fixed problem when the store can't be read", async () => {
    const broken = {
      select() {
        throw new Error("connection to postgres://user:hunter2@db failed");
      },
    } as unknown as Database;
    const { records, problems } = await readTicketRecord(broken, "TKT-2001");

    expect(records).toEqual({});
    expect(problems).toEqual([
      { call: "ticket-store", message: "The ticket store read for TKT-2001 failed." },
    ]);
    expect(JSON.stringify(problems)).not.toContain("hunter2");
  });

  it(
    "maps a stored ticket into a ticket snapshot",
    async () => {
      const handle = await createTestDatabase();
      try {
        await writeTicket(handle.db, {
          id: "TKT-2002",
          channel: "chat",
          senderEmail: null,
          senderPhone: "+254700000000",
          subject: null,
          body: "Simulated ticket.",
          attachments: [{ id: "ATT-1", contentType: "image/jpeg" }],
          receivedAt: "2026-10-17T08:00:00+03:00",
          simulated: true,
        });
        const { records, problems } = await readTicketRecord(handle.db, "TKT-2002");
        expect(problems).toEqual([]);
        expect(records.ticket).toEqual({
          call: CALLS.ticket,
          id: "TKT-2002",
          senderEmail: null,
          attachments: [{ id: "ATT-1", contentType: "image/jpeg" }],
        });
      } finally {
        await handle.close();
      }
    },
    SLOW,
  );
});
