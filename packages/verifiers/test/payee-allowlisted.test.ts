import type { Intent } from "@countersign/mandate";
import { describe, expect, it } from "vitest";
import { type PayeeListSnapshot, type RecordSnapshots, runVerifiers } from "../src/index";
import { capture, disputes, execution, intent, order, shipment, ticket } from "./fixtures";

const payeeList: PayeeListSnapshot = {
  call: "mandate payees",
  id: "kikapu-studio-ops v1",
  payees: [
    { email: "sisal.collective@example.com", name: "Nyanza Sisal Collective (illustrative)" },
    { email: "dyeworks@example.com", name: "Kisumu Dye Works (illustrative)" },
  ],
};

function payout(email: string): Intent {
  return {
    principal: "ops-agent",
    rail: "paypal",
    action: "paypal.payout",
    amount: { minor: 4500, currency: "USD" },
    target: { kind: "payee", email },
    ticketId: null,
    params: { note: null, reference: "KDW-2026-0412" },
    claim: null,
    mandateVersion: 1,
  };
}

function allowlisted(email: string, records: RecordSnapshots) {
  const [entry] = runVerifiers(payout(email), records, ["payee.allowlisted"]);
  return entry;
}

describe("payee.allowlisted", () => {
  it("passes for a listed email, naming the payee and the list's ID", () => {
    const entry = allowlisted("dyeworks@example.com", { payees: payeeList });
    expect(entry?.result).toBe("pass");
    expect(entry?.detail).toBe(
      "Kisumu Dye Works (illustrative) (dyeworks@example.com) is on payee list kikapu-studio-ops v1",
    );
  });

  it.each([
    "DyeWorks@Example.com",
    "  dyeworks@example.com",
    "dyeworks@example.com  ",
    " DYEWORKS@EXAMPLE.COM ",
  ])("passes for the listed email in another case or spacing: %j", (email) => {
    expect(allowlisted(email, { payees: payeeList })?.result).toBe("pass");
  });

  it("fails for an email that isn't listed, naming it and the list's ID", () => {
    const entry = allowlisted("Refunds.Desk@example.com ", { payees: payeeList });
    expect(entry?.result).toBe("fail");
    expect(entry?.detail).toBe("refunds.desk@example.com isn't on payee list kikapu-studio-ops v1");
  });

  it("fails for an email that only starts or ends like a listed one", () => {
    for (const email of ["dyeworks@example.com.evil.test", "xdyeworks@example.com"]) {
      expect(allowlisted(email, { payees: payeeList })?.result).toBe("fail");
    }
  });

  it("fails on an empty list, since the list was read and names nobody", () => {
    const empty: PayeeListSnapshot = { ...payeeList, payees: [] };
    expect(allowlisted("dyeworks@example.com", { payees: empty })?.result).toBe("fail");
  });

  it("is unknown with no payee list, naming the call it looked for", () => {
    const entry = allowlisted("dyeworks@example.com", {});
    expect(entry?.result).toBe("unknown");
    expect(entry?.detail).toBe("No payee list");
    expect(entry?.records).toEqual([{ call: "mandate payees", id: null }]);
  });

  it("is unknown for an intent whose target isn't a payee", () => {
    const entry = runVerifiers({ ...intent, action: "paypal.payout" }, { payees: payeeList }, [
      "payee.allowlisted",
    ])[0];
    expect(entry?.result).toBe("unknown");
    expect(entry?.detail).toBe("Not a payout");
  });

  it("names `mandate payees` and the list's ID in the trace entry's record", () => {
    const pass = allowlisted("dyeworks@example.com", { payees: payeeList });
    const fail = allowlisted("refunds.desk@example.com", { payees: payeeList });
    for (const entry of [pass, fail]) {
      expect(entry?.records).toEqual([{ call: "mandate payees", id: "kikapu-studio-ops v1" }]);
    }
  });

  it("runs only when a rule requires it, so a refund's trace is unchanged", () => {
    const records: RecordSnapshots = {
      captures: [capture],
      orders: [order],
      ticket,
      disputes: [disputes],
      shipments: [shipment],
      executions: [execution],
    };
    const without = runVerifiers(intent, records);
    expect(runVerifiers(intent, { ...records, payees: payeeList })).toEqual(without);
    expect(without.map((entry) => entry.verifier)).not.toContain("payee.allowlisted");
    expect(runVerifiers(payout("dyeworks@example.com"), { payees: payeeList })).toEqual([]);
  });
});
