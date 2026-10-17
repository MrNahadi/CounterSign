import type { Intent } from "@countersign/mandate";
import { describe, expect, it } from "vitest";
import { type RecordSnapshots, runVerifiers, type TicketSnapshot } from "../src/index";
import { capture, intent, order, ticket } from "./fixtures";

function fromPayer(records: RecordSnapshots, asked: Intent = intent) {
  return runVerifiers(asked, records).find((entry) => entry.verifier === "ticket.from_payer");
}

describe("ticket.from_payer", () => {
  it("passes when the sender is the order's payer", () => {
    expect(fromPayer({ orders: [order], ticket })?.result).toBe("pass");
  });

  it("ignores case and outer spaces", () => {
    const shouting: TicketSnapshot = {
      ...ticket,
      senderEmail: "  SB-87z5X@Personal.Example.com\t",
    };
    expect(fromPayer({ orders: [order], ticket: shouting })?.result).toBe("pass");
  });

  it("fails when the sender isn't the payer", () => {
    const other: TicketSnapshot = { ...ticket, senderEmail: "grace.w@example.com" };
    expect(fromPayer({ orders: [order], ticket: other })?.result).toBe("fail");
  });

  it("fails on a sender one letter away from the payer", () => {
    const close: TicketSnapshot = { ...ticket, senderEmail: "sb-87z5y@personal.example.com" };
    expect(fromPayer({ orders: [order], ticket: close })?.result).toBe("fail");
  });

  it("names both emails in its detail", () => {
    const other: TicketSnapshot = { ...ticket, senderEmail: "grace.w@example.com" };
    expect(fromPayer({ orders: [order], ticket: other })?.detail).toBe(
      "Sender grace.w@example.com, payer sb-87z5x@personal.example.com",
    );
  });

  it("is unknown without a payer email on the order", () => {
    expect(fromPayer({ orders: [{ ...order, payerEmail: null }], ticket })?.result).toBe("unknown");
    expect(fromPayer({ orders: [{ ...order, payerEmail: "  " }], ticket })?.result).toBe("unknown");
  });

  it("is unknown without the order record", () => {
    expect(fromPayer({ ticket })?.result).toBe("unknown");
    expect(fromPayer({ orders: [{ ...order, id: "6O190127TN364715T" }], ticket })?.result).toBe(
      "unknown",
    );
    const noOrder: Intent = { ...intent, target: { ...intent.target, orderId: null } };
    expect(fromPayer({ orders: [order], ticket }, noOrder)?.result).toBe("unknown");
  });

  it("checks the payer of the capture's own order", () => {
    expect(fromPayer({ captures: [capture], orders: [order], ticket })?.result).toBe("pass");
    const elsewhere = { ...capture, orderId: "6O190127TN364715T" };
    expect(fromPayer({ captures: [elsewhere], orders: [order], ticket })?.result).toBe("unknown");
  });

  it("is unknown without a sender email on the ticket", () => {
    expect(fromPayer({ orders: [order], ticket: { ...ticket, senderEmail: null } })?.result).toBe(
      "unknown",
    );
    expect(fromPayer({ orders: [order], ticket: { ...ticket, senderEmail: "" } })?.result).toBe(
      "unknown",
    );
  });

  it("is unknown without the intent's ticket", () => {
    expect(fromPayer({ orders: [order] })?.result).toBe("unknown");
    expect(fromPayer({ orders: [order], ticket: { ...ticket, id: "tkt_0043" } })?.result).toBe(
      "unknown",
    );
  });

  it("names the order and ticket calls and record IDs", () => {
    const expected = [
      { call: "GET /v2/checkout/orders/{id}", id: "5O190127TN364715T" },
      { call: "ticket", id: "tkt_0042" },
    ];
    expect(fromPayer({ orders: [order], ticket })?.records).toEqual(expected);
    expect(fromPayer({})?.records).toEqual(expected);
  });

  it("names a null order ID when the intent has no order", () => {
    const noOrder: Intent = { ...intent, target: { ...intent.target, orderId: null } };
    expect(fromPayer({ ticket }, noOrder)?.records).toEqual([
      { call: "GET /v2/checkout/orders/{id}", id: null },
      { call: "ticket", id: "tkt_0042" },
    ]);
  });
});
