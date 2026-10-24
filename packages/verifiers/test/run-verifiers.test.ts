import { type Intent, VERIFIERS } from "@countersign/mandate";
import { describe, expect, it } from "vitest";
import { type RecordSnapshots, runVerifiers } from "../src/index";
import { capture, disputes, execution, intent, order, shipment, ticket } from "./fixtures";

const records: RecordSnapshots = {
  captures: [capture],
  orders: [order],
  ticket,
  disputes: [disputes],
  shipments: [shipment],
  executions: [execution],
};

// Built in later phases. Until then they can only say unknown.
const NOT_BUILT_YET = [
  "ledger.velocity",
  "mpesa.receipt_verified",
  "mpesa.amount_matches_order",
  "mpesa.overpayment_covers_refund",
  "mpesa.recipient_is_payer",
  "mpesa.receipt_unused",
] as const;

describe("runVerifiers", () => {
  it("runs every refund verifier for a refund, whatever the rules need", () => {
    expect(runVerifiers(intent, records).map((entry) => entry.verifier)).toEqual([
      "capture.refundable",
      "ticket.from_payer",
      "dispute.none_open",
      "shipment.status",
      "evidence.photo_present",
      "ledger.not_duplicate",
    ]);
  });

  it("names a call and a record ID on every entry of the built checks", () => {
    for (const entry of runVerifiers(intent, records)) {
      expect(entry.records.length).toBeGreaterThan(0);
      for (const record of entry.records) {
        expect(record.call).not.toBe("");
        expect(record.id).not.toBe("");
      }
    }
  });

  it.each(NOT_BUILT_YET)("returns unknown for %s, which isn't built yet", (name) => {
    const entry = runVerifiers(intent, records, [name]).find((each) => each.verifier === name);
    expect(entry?.result).toBe("unknown");
  });

  it("runs the extra verifiers it's asked for once, after the refund set", () => {
    const names = runVerifiers(intent, records, ["payee.allowlisted", "capture.refundable"]).map(
      (entry) => entry.verifier,
    );
    expect(names).toHaveLength(7);
    expect(names.at(-1)).toBe("payee.allowlisted");
  });

  it("can run every verifier in the schema", () => {
    const names = runVerifiers(intent, records, VERIFIERS).map((entry) => entry.verifier);
    expect(new Set(names)).toEqual(new Set(VERIFIERS));
  });

  it("runs only the verifiers it's asked for on an action with no default set", () => {
    const payout: Intent = { ...intent, action: "paypal.payout" };
    expect(runVerifiers(payout, records).map((entry) => entry.verifier)).toEqual([]);
    expect(
      runVerifiers(payout, records, ["payee.allowlisted"]).map((entry) => entry.verifier),
    ).toEqual(["payee.allowlisted"]);
  });
});

describe("runVerifiers for a target that isn't a capture", () => {
  const CAPTURE_BASED = [
    "capture.refundable",
    "ticket.from_payer",
    "dispute.none_open",
    "shipment.status",
    "ledger.not_duplicate",
  ] as const;

  it.each<[Intent["target"], string]>([
    [{ kind: "dispute", disputeId: "PP-D-27803" }, "dispute PP-D-27803"],
    [{ kind: "invoice", invoiceId: "INV2-AB12" }, "invoice INV2-AB12"],
    [{ kind: "order", orderId: "5O190127TN364715T" }, "order 5O190127TN364715T"],
    [{ kind: "payee", email: "payee@example.com" }, "payee payee@example.com"],
  ])("returns unknown from every capture-based verifier, naming %o", (target, named) => {
    const other: Intent = { ...intent, action: "paypal.dispute.accept_claim", target };
    const trace = runVerifiers(other, records, CAPTURE_BASED);
    expect(trace.map((entry) => entry.verifier)).toEqual([...CAPTURE_BASED]);
    for (const entry of trace) {
      expect(entry.result).toBe("unknown");
      expect(entry.detail).toBe(`The target is ${named}, not a capture`);
    }
  });

  it("runs only the verifiers the rules require for an action other than a refund", () => {
    const other: Intent = {
      ...intent,
      action: "paypal.invoice.send",
      target: { kind: "invoice", invoiceId: "INV2-AB12" },
    };
    expect(runVerifiers(other, records)).toEqual([]);
    expect(runVerifiers(other, records, ["evidence.photo_present"])).toEqual([
      runVerifiers(intent, records, []).find((e) => e.verifier === "evidence.photo_present"),
    ]);
  });

  it("returns unknown from the ticket checks when there's no ticket ID", () => {
    const other: Intent = {
      ...intent,
      action: "paypal.payout",
      target: { kind: "payee", email: "payee@example.com" },
      ticketId: null,
    };
    const [photo] = runVerifiers(other, records, ["evidence.photo_present"]);
    expect(photo?.result).toBe("unknown");
    expect(photo?.detail).toBe("No ticket for this proposal");
  });
});
