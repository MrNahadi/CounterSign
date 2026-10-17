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
  "payee.allowlisted",
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
