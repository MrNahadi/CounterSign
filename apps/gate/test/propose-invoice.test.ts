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
import { type Mandate, parseMandate } from "@countersign/mandate";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { EXECUTABLE_ACTIONS, isExecutable } from "../src/executable";
import { EXECUTORS } from "../src/executors";
import { type ProposeResult, propose } from "../src/propose";
import { createFakeSandbox, type InvoiceSendAnswer } from "./fake-sandbox";

// An allowed invoice send through propose() and the invoice-send executor (ADR 0033), under a
// mandate that allows it, with the fake sandbox and PGlite. Illustrative IDs and people.

const SLOW = 60_000;
const NOW = new Date("2026-10-17T09:00:00+03:00");
const LATER = new Date("2026-10-17T09:05:00+03:00");
const PRINCIPAL = "support-agent";
const PAYER = "amina.k@example.com";
const INVOICE = "INV2-ABCD-EFGH-IJKL-MNOP";
const DISPUTE = "PP-D-4012";
const ORDER = "ORD-1039";

const mandateFile = fileURLToPath(
  new URL("../../../packages/mandate/fixtures/kikapu-studio-v3.json", import.meta.url),
);
const shipped = JSON.parse(readFileSync(mandateFile, "utf8"));

// The shipped mandate with invoice sends and order captures allowed outright.
function mandateAllowing(): Mandate {
  const json = structuredClone(shipped);
  json.rules = json.rules.map((rule: { id: string; action: unknown }) =>
    rule.id === "dispute-and-invoice-actions"
      ? {
          ...rule,
          action: [
            "paypal.dispute.accept_claim",
            "paypal.dispute.provide_evidence",
            "paypal.dispute.make_offer",
          ],
        }
      : rule,
  );
  json.rules.push(
    { id: "send-invoices", action: "paypal.invoice.send", decide: "allow" },
    { id: "order-captures", action: "paypal.order.capture", decide: "allow" },
  );
  const parsed = parseMandate(json);
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.mandate;
}
const mandate = mandateAllowing();

const usd = (minor: number) => ({ minor, currency: "USD" as const });

function world() {
  const rail = createFakeSandbox();
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
    captureIds: ["CAP-1038"],
  });
  rail.orders.set(ORDER, {
    id: ORDER,
    status: "APPROVED",
    payerEmail: PAYER,
    payerId: "PAYER1039",
    purchaseUnits: [
      {
        referenceId: "KIK-1039",
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
const bare = { tool: "send_invoice", args: { invoice_id: INVOICE }, justification };
const withNote = {
  tool: "send_invoice",
  args: {
    invoice_id: INVOICE,
    note: "Thanks for your order.",
    send_to_recipient: false,
    additional_recipients: ["accounts@example.com"],
  },
  justification,
};

describe("executors", () => {
  it("are exactly refund, invoice send, the three dispute actions and payout, one each", () => {
    expect([...EXECUTABLE_ACTIONS]).toEqual([
      "paypal.refund",
      "paypal.invoice.send",
      "paypal.dispute.accept_claim",
      "paypal.dispute.make_offer",
      "paypal.dispute.provide_evidence",
      "paypal.payout",
    ]);
    expect(Object.keys(EXECUTORS).sort()).toEqual([...EXECUTABLE_ACTIONS].sort());
    expect(isExecutable("paypal.invoice.send")).toBe(true);
    expect(isExecutable("paypal.payout")).toBe(true);
    expect(isExecutable("paypal.order.capture")).toBe(false);
  });
});

describe("propose: an allowed invoice send", { timeout: SLOW }, () => {
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
      subject: "About my invoice",
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
  const run = (w: ReturnType<typeof world>, proposal: unknown, now = NOW) =>
    propose({ mandate, principal: PRINCIPAL, proposal, now, ...w, db, clock: () => now });
  const decided = (result: ProposeResult) => {
    if (!result.ok || result.replay) throw new Error("not decided");
    return result;
  };
  const sends = (w: ReturnType<typeof world>) =>
    w.rail.calls.filter((call) => call.call === "sendInvoice");

  it("writes its request with the target, sends once without a request ID, and logs SENT", async () => {
    const w = world();
    const result = decided(await run(w, bare));

    expect(result.record.decision).toBe("allow");
    expect(result.response).toEqual({
      decision: "allowed",
      intent_id: result.record.intentId,
      intent_hash: result.record.intentHash,
    });
    expect(w.rail.invoiceSends).toEqual([{ invoiceId: INVOICE, sendToRecipient: true }]);
    expect(sends(w)).toHaveLength(1);
    expect(result.execution).toEqual({
      outcome: "executed",
      refund: null,
      invoice: { id: INVOICE, status: "SENT" },
      error: null,
      resultSeq: expect.any(Number),
      resultProblem: null,
      sent: true,
    });

    const rows = await entries();
    expect(rows.map((row) => row.entryType)).toEqual([
      "mandate.version",
      "decision",
      "execution.requested",
      "execution.result",
    ]);
    const request = JSON.parse(rows[2]?.payload ?? "null");
    expect(request).toMatchObject({
      intentId: result.record.intentId,
      intentHash: result.record.intentHash,
      action: "paypal.invoice.send",
      target: { invoiceId: INVOICE },
      captureId: null,
      requestId: null,
      replay: false,
      decisionSeq: result.seqs.decision,
      amount: usd(2500),
    });
    expect(result.seqs.request).toBe(rows[2]?.seq);
    expect(JSON.parse(rows[3]?.payload ?? "null")).toEqual({
      requestSeq: rows[2]?.seq,
      outcome: "executed",
      invoice: { id: INVOICE, status: "SENT" },
    });
    expect(result.execution?.resultSeq).toBe(rows[3]?.seq);
    expect((await verifyLog(db)).intact).toBe(true);
  });

  it("sends the hashed note and recipients, leaving nothing else", async () => {
    const w = world();
    decided(await run(w, withNote));
    expect(w.rail.invoiceSends).toEqual([
      {
        invoiceId: INVOICE,
        sendToRecipient: false,
        note: "Thanks for your order.",
        additionalRecipients: ["accounts@example.com"],
      },
    ]);
  });

  const outcomes: [string, InvoiceSendAnswer, object][] = [
    ["a 202 as SCHEDULED", "SCHEDULED", { outcome: "executed", invoice: { status: "SCHEDULED" } }],
    [
      "a 4xx as failed, with PayPal's error name and issues",
      { status: 422, name: "UNPROCESSABLE_ENTITY", issues: ["INVALID_INVOICE_STATUS"] },
      {
        outcome: "failed",
        error: {
          name: "UNPROCESSABLE_ENTITY",
          issues: ["INVALID_INVOICE_STATUS"],
          debugId: "fake-debug",
        },
      },
    ],
    [
      "a 5xx as unknown",
      { status: 503, name: "SERVICE_UNAVAILABLE" },
      { outcome: "unknown", error: { name: "SERVICE_UNAVAILABLE" } },
    ],
    ["a network failure as unknown", "network", { outcome: "unknown" }],
  ];
  for (const [what, answer, logged] of outcomes) {
    it(`logs ${what}`, async () => {
      const w = world();
      w.rail.invoiceSendAnswer = answer;
      const result = decided(await run(w, bare));

      expect(sends(w)).toHaveLength(1);
      expect(result.execution).toMatchObject({ ...logged, sent: true, resultProblem: null });
      const rows = await entries();
      expect(rows.at(-1)?.entryType).toBe("execution.result");
      expect(JSON.parse(rows.at(-1)?.payload ?? "null")).toMatchObject(logged);
      expect((await verifyLog(db)).intact).toBe(true);
    });
  }

  it("never sends the same allowed intent a second time, whatever the first send's outcome", async () => {
    for (const answer of ["SENT", { status: 422 }, "network"] as InvoiceSendAnswer[]) {
      await db.execute(sql`TRUNCATE audit_log`);
      const w = world();
      w.rail.invoiceSendAnswer = answer;
      const first = decided(await run(w, bare));
      const second = decided(await run(w, bare, LATER));

      expect(second.record.intentId).toBe(first.record.intentId);
      expect(second.record.decision).toBe("allow");
      expect(second.seqs.decision).toBeGreaterThan(first.seqs.decision);
      expect(second.seqs.request).toBeNull();
      expect(second.execution).toMatchObject({
        outcome: first.execution?.outcome,
        sent: false,
      });
      expect(second.execution?.invoice).toEqual(first.execution?.invoice);
      expect(sends(w)).toHaveLength(1);
      const types = (await entries()).map((row) => row.entryType);
      expect(types.filter((type) => type === "decision")).toHaveLength(2);
      expect(types.filter((type) => type === "execution.requested")).toHaveLength(1);
      expect(types.filter((type) => type === "execution.result")).toHaveLength(1);
    }
  });

  it("still denies an allow for an action without an executor ACTION_UNAVAILABLE, and sends nothing", async () => {
    const w = world();
    const result = decided(await run(w, { tool: "pay_order", args: { id: ORDER }, justification }));
    expect(result.record.decision).toBe("deny");
    expect(result.record.reasons.map((reason) => reason.code)).toEqual(["ACTION_UNAVAILABLE"]);
    expect(result.execution).toBeNull();
    // Only the order's read: nothing is captured.
    expect(w.rail.calls.map((call) => call.call)).toEqual(["getOrder"]);
    const types = (await entries()).map((row) => row.entryType);
    expect(types.filter((type) => type.startsWith("execution."))).toEqual([]);
  });
});
