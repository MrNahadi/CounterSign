import { describe, expect, it } from "vitest";
import { getProduct, PRODUCTS } from "../src/products";
import { buildDemoShipment, CARRIER_NAME, DEMO_ORDERS, productFor } from "../src/seed-catalog";

const SEEDED_AT = "2026-10-17T09:30:00.000Z";
const DAY = 86_400_000;
const daysBeforeSeeding = (at: string) => (Date.parse(SEEDED_AT) - Date.parse(at)) / DAY;
const byNumber = (n: number) => {
  const found = DEMO_ORDERS.find((o) => o.orderNumber === `KIK-${n}`);
  if (!found) throw new Error(`no KIK-${n}`);
  return found;
};
const shipmentOf = (n: number) =>
  buildDemoShipment(byNumber(n), { runId: "run1", seededAt: SEEDED_AT });

describe("products", () => {
  it("has the 8 products at the listed USD prices", () => {
    expect(PRODUCTS.map((p) => [p.name, p.price])).toEqual([
      ["Market basket", { minor: 4800, currency: "USD" }],
      ["Woven tote", { minor: 3600, currency: "USD" }],
      ["Coaster set", { minor: 1800, currency: "USD" }],
      ["Floor basket", { minor: 24000, currency: "USD" }],
      ["Laundry hamper", { minor: 12000, currency: "USD" }],
      ["Bread basket", { minor: 2400, currency: "USD" }],
      ["Clutch bag", { minor: 5600, currency: "USD" }],
      ["Wall plate", { minor: 6400, currency: "USD" }],
    ]);
  });

  it("gives each product a unique stable ID, a one-line description and a lookup", () => {
    expect(new Set(PRODUCTS.map((p) => p.id)).size).toBe(8);
    for (const product of PRODUCTS) {
      expect(product.id).toMatch(/^[a-z]+(-[a-z]+)*$/);
      expect(product.description).not.toMatch(/\n|!/);
      expect(getProduct(product.id)).toBe(product);
    }
    expect(getProduct("nope")).toBeUndefined();
  });
});

describe("demo orders", () => {
  it("has 30 orders, KIK-1013 to KIK-1042 in order, each with a catalog product", () => {
    expect(DEMO_ORDERS.map((o) => o.orderNumber)).toEqual(
      Array.from({ length: 30 }, (_, i) => `KIK-${1013 + i}`),
    );
    for (const demoOrder of DEMO_ORDERS) expect(productFor(demoOrder).id).toBe(demoOrder.productId);
  });

  it("has the status mix 16 delivered, 6 in transit, 4 stalled and 4 lost", () => {
    const count = (status: string) => DEMO_ORDERS.filter((o) => o.status === status).length;
    expect([count("delivered"), count("in_transit"), count("stalled_10d"), count("lost")]).toEqual([
      16, 6, 4, 4,
    ]);
  });

  it("has the fixed rows", () => {
    const fixed = (n: number) => {
      const o = byNumber(n);
      return [productFor(o).name, o.buyer, o.status];
    };
    expect(fixed(1032)).toEqual(["Laundry hamper", "A", "delivered"]);
    expect(fixed(1033)).toEqual(["Clutch bag", "A", "delivered"]);
    expect(fixed(1034)).toEqual(["Wall plate", "A", "lost"]);
    expect(fixed(1035)).toEqual(["Coaster set", "A", "stalled_10d"]);
    expect(fixed(1036)).toEqual(["Laundry hamper", "A", "lost"]);
    expect(fixed(1037)).toEqual(["Floor basket", "A", "delivered"]);
    expect([1038, 1039, 1040, 1041].map((n) => [byNumber(n).buyer, byNumber(n).status])).toEqual([
      ["B", "delivered"],
      ["B", "delivered"],
      ["B", "in_transit"],
      ["B", "delivered"],
    ]);
    expect(fixed(1042)).toEqual(["Market basket", "A", "delivered"]);
    expect(byNumber(1034).role).not.toBe(byNumber(1036).role);
  });

  it("has 19 filler orders, at least 3 for buyer B", () => {
    const filler = DEMO_ORDERS.filter((o) => o.role === "filler");
    expect(filler).toHaveLength(19);
    expect(filler.filter((o) => o.buyer === "B").length).toBeGreaterThanOrEqual(3);
    expect(
      DEMO_ORDERS.filter((o) => o.role !== "filler").every((o) => o.orderNumber >= "KIK-1032"),
    ).toBe(true);
  });
});

describe("buildDemoShipment", () => {
  it("names the tracking number from the run and the order digits, and the simulated carrier", () => {
    const shipment = shipmentOf(1032);
    expect(shipment.trackingNumber).toBe("KC-run1-1032");
    expect(shipment.carrierName).toBe("Kisumu Couriers (simulated)");
    expect(CARRIER_NAME).toBe(shipment.carrierName);
    expect(shipment.updatedAt).toBe(SEEDED_AT);
  });

  it("builds time-ordered events that start with a pickup and agree with the status", () => {
    for (const demoOrder of DEMO_ORDERS) {
      const shipment = buildDemoShipment(demoOrder, { runId: "run1", seededAt: SEEDED_AT });
      const events = shipment.scanEvents;
      const times = events.map((e) => Date.parse(e.at));
      expect(times, demoOrder.orderNumber).toEqual([...times].sort((a, b) => a - b));
      expect(events[0]?.description, demoOrder.orderNumber).toBe("Picked up");
      expect(shipment.status).toBe(demoOrder.status);
      const last = events[events.length - 1];
      if (!last) throw new Error("no events");
      const age = daysBeforeSeeding(last.at);
      if (demoOrder.status === "delivered") expect(last.description).toBe("Delivered");
      if (demoOrder.status === "lost") expect(last.description).toBe("Reported lost");
      if (demoOrder.status === "stalled_10d") expect(age).toBeGreaterThanOrEqual(10);
      if (demoOrder.status === "in_transit") {
        expect(age).toBeLessThan(10);
        expect(["Delivered", "Reported lost"]).not.toContain(last.description);
      }
      expect(age).toBeGreaterThanOrEqual(0);
    }
  });

  it("puts KIK-1035's last scan 14 days and KIK-1042's delivery 5 days before seeding", () => {
    const stalled = shipmentOf(1035).scanEvents.at(-1);
    const held = shipmentOf(1042).scanEvents.at(-1);
    expect(daysBeforeSeeding(stalled?.at ?? "")).toBe(14);
    expect(held?.description).toBe("Delivered");
    expect(daysBeforeSeeding(held?.at ?? "")).toBe(5);
  });

  it("works out dates from the seeding time it is given, with no clock", () => {
    const later = buildDemoShipment(byNumber(1042), {
      runId: "run1",
      seededAt: "2027-01-01T00:00:00Z",
    });
    expect(later.scanEvents.at(-1)?.at).toBe("2026-12-27T00:00:00.000Z");
  });

  it("refuses a bad run ID or seeding time", () => {
    const o = byNumber(1013);
    expect(() => buildDemoShipment(o, { runId: "Run 1", seededAt: SEEDED_AT })).toThrow();
    expect(() => buildDemoShipment(o, { runId: "abc", seededAt: SEEDED_AT })).toThrow();
    expect(() => buildDemoShipment(o, { runId: "run1", seededAt: "yesterday" })).toThrow();
  });
});
