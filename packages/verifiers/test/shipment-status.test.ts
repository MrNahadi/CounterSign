import { type Intent, SHIPMENT_STATUSES } from "@countersign/mandate";
import { describe, expect, it } from "vitest";
import { type OrderSnapshot, type RecordSnapshots, runVerifiers } from "../src/index";
import { capture, intent, order, shipment } from "./fixtures";

// The capture's record links the intent to its order, so it's there unless a test replaces it.
function status(records: RecordSnapshots, asked: Intent = intent) {
  return runVerifiers(asked, { captures: [capture], ...records }).find(
    (entry) => entry.verifier === "shipment.status",
  );
}

describe("shipment.status", () => {
  it.each(SHIPMENT_STATUSES)("passes with the carrier's value %s", (value) => {
    const entry = status({ orders: [order], shipments: [{ ...shipment, status: value }] });
    expect(entry?.result).toBe("pass");
    expect(entry?.value).toBe(value);
  });

  it("reads the status through the tracker's tracking number", () => {
    const other = { ...shipment, id: "KIK0099", status: "delivered" as const };
    const entry = status({ orders: [order], shipments: [other, shipment] });
    expect(entry?.value).toBe("stalled_10d");
  });

  it("is unknown when the order has no tracker", () => {
    const untracked: OrderSnapshot = { ...order, trackers: [] };
    const entry = status({ orders: [untracked], shipments: [shipment] });
    expect(entry?.result).toBe("unknown");
    expect(entry?.value).toBeUndefined();
  });

  it.each(["CANCELLED", "shipped", ""])("ignores a tracker whose status is %j", (value) => {
    const notLive: OrderSnapshot = {
      ...order,
      trackers: [{ ...order.trackers[0], status: value }],
    };
    expect(status({ orders: [notLive], shipments: [shipment] })?.result).toBe("unknown");
  });

  it("ignores a tracker for another capture on the same order", () => {
    const other: OrderSnapshot = {
      ...order,
      trackers: [{ ...order.trackers[0], id: "8YL89768KH2865639-KIK0042" }],
    };
    const entry = status({ orders: [other], shipments: [shipment] });
    expect(entry?.result).toBe("unknown");
    expect(entry?.detail).toBe(
      "No live tracker for capture 7YL89768KH2865638 on order 5O190127TN364715T",
    );
  });

  it("is unknown when the carrier has no record for the tracking number", () => {
    expect(status({ orders: [order] })?.result).toBe("unknown");
    expect(status({ orders: [order], shipments: [{ ...shipment, id: "KIK0099" }] })?.result).toBe(
      "unknown",
    );
  });

  it("is unknown without the order record", () => {
    expect(status({ shipments: [shipment] })?.result).toBe("unknown");
    const noOrder: Intent = { ...intent, target: { ...intent.target, orderId: null } };
    expect(status({ orders: [order], shipments: [shipment] }, noOrder)?.result).toBe("unknown");
  });

  it("is unknown without the capture record, even when the intent names the order", () => {
    const entry = status({ captures: [], orders: [order], shipments: [shipment] });
    expect(entry?.result).toBe("unknown");
    expect(entry?.value).toBeUndefined();
    expect(entry?.detail).toBe("No record of capture 7YL89768KH2865638");
  });

  it("is unknown when the capture isn't on the order", () => {
    const elsewhere = { ...capture, orderId: "6O190127TN364715T" };
    const entry = status({ captures: [elsewhere], orders: [order], shipments: [shipment] });
    expect(entry?.result).toBe("unknown");
  });

  it("passes when every live tracker agrees, and is unknown when they disagree", () => {
    const two: OrderSnapshot = {
      ...order,
      trackers: [
        ...order.trackers,
        { id: "7YL89768KH2865638-KIK0043", trackingNumber: "KIK0043", status: "SHIPPED" },
      ],
    };
    const second = { ...shipment, id: "KIK0043" };
    expect(status({ orders: [two], shipments: [shipment, second] })?.value).toBe("stalled_10d");
    const delivered = { ...second, status: "delivered" as const };
    const entry = status({ orders: [two], shipments: [shipment, delivered] });
    expect(entry?.result).toBe("unknown");
    expect(entry?.value).toBeUndefined();
  });

  it("names the order and carrier calls and record IDs", () => {
    expect(status({ orders: [order], shipments: [shipment] })?.records).toEqual([
      { call: "GET /v2/checkout/orders/{id}", id: "5O190127TN364715T" },
      { call: "carrier GET /shipments/{tracking_number}", id: "KIK0042" },
    ]);
    expect(status({ orders: [order] })?.records).toEqual([
      { call: "GET /v2/checkout/orders/{id}", id: "5O190127TN364715T" },
      { call: "carrier GET /shipments/{tracking_number}", id: "KIK0042" },
    ]);
    expect(status({})?.records).toEqual([
      { call: "GET /v2/checkout/orders/{id}", id: "5O190127TN364715T" },
    ]);
  });

  it("names the status and tracking number in its detail", () => {
    expect(status({ orders: [order], shipments: [shipment] })?.detail).toBe(
      "Carrier shows KIK0042 stalled_10d",
    );
  });
});
