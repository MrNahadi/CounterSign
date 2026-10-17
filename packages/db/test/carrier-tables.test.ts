import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  auditLog,
  carrierShipments,
  createTestDatabase,
  type DatabaseHandle,
  type NewCarrierShipmentRow,
  type NewSeedOrderRow,
  seedOrders,
} from "../src/index";

const shipment = (trackingNumber: string, status = "in_transit"): NewCarrierShipmentRow => ({
  trackingNumber,
  status,
  carrierName: "Kisumu Couriers (simulated)",
  scanEvents: [
    { at: "2026-10-10T08:00:00.000Z", description: "Picked up", place: "Kisumu" },
    { at: "2026-10-12T14:30:00.000Z", description: "Arrived at hub", place: "Nairobi" },
  ],
  updatedAt: "2026-10-17T09:00:00.000Z",
});

const order = (orderNumber: string, orderId: string, captureId: string): NewSeedOrderRow => ({
  orderNumber,
  runId: "run1",
  paypalOrderId: orderId,
  paypalCaptureId: captureId,
  amountMinor: 4800,
  currency: "USD",
  payerEmail: "buyer-a@example.com",
  buyer: "A",
  trackingNumber: `KC-run1-${orderNumber.slice(4)}`,
  role: "filler",
  seededAt: "2026-10-17T09:00:00.000Z",
});

// Drizzle wraps driver errors; the database's own message is on the cause.
const failureText = async (run: () => Promise<unknown>): Promise<string> => {
  try {
    await run();
  } catch (error) {
    const cause = error instanceof Error && error.cause instanceof Error ? error.cause.message : "";
    return `${error instanceof Error ? error.message : String(error)} ${cause}`;
  }
  throw new Error("expected the statement to fail");
};

describe("the carrier_shipments and seed_orders tables on a fresh in-memory PGlite", () => {
  let handle: DatabaseHandle;

  beforeAll(async () => {
    handle = await createTestDatabase();
  });

  beforeEach(async () => {
    await handle.db.execute(sql`TRUNCATE carrier_shipments, seed_orders, audit_log`);
  });

  afterAll(async () => {
    await handle.close();
  });

  it("come from the migrations, and a second migrate applies nothing", async () => {
    expect(await handle.migrate()).toBe(0);
    expect(await handle.db.select().from(carrierShipments)).toEqual([]);
    expect(await handle.db.select().from(seedOrders)).toEqual([]);
  });

  it("store a shipment with its scan events in order, keyed by tracking number", async () => {
    await handle.db.insert(carrierShipments).values(shipment("KC-run1-1013"));
    const [stored] = await handle.db.select().from(carrierShipments);
    expect(stored).toEqual(shipment("KC-run1-1013"));
    const text = await failureText(() =>
      handle.db.insert(carrierShipments).values(shipment("KC-run1-1013")),
    );
    expect(text).toMatch(/carrier_shipments_pkey/);
  });

  it.each(["lost", "stalled_10d", "in_transit", "delivered"])(
    "accepts the status %s",
    async (status) => {
      await handle.db.insert(carrierShipments).values(shipment("KC-run1-1013", status));
      const [stored] = await handle.db.select().from(carrierShipments);
      expect(stored?.status).toBe(status);
    },
  );

  it.each(["", "Delivered", "stalled", "returned", "unknown"])(
    "rejects the status %j",
    async (status) => {
      const text = await failureText(() =>
        handle.db.insert(carrierShipments).values(shipment("KC-run1-1013", status)),
      );
      expect(text).toMatch(/carrier_shipments_status_check/);
      expect(await handle.db.select().from(carrierShipments)).toEqual([]);
    },
  );

  it("stores a seed order, with the amount as a number of minor units", async () => {
    await handle.db.insert(seedOrders).values(order("KIK-1013", "ORDER00001", "CAP0000001"));
    const [stored] = await handle.db.select().from(seedOrders);
    expect(stored).toEqual(order("KIK-1013", "ORDER00001", "CAP0000001"));
    expect(typeof stored?.amountMinor).toBe("number");
  });

  it("rejects a repeated order number", async () => {
    await handle.db.insert(seedOrders).values(order("KIK-1013", "ORDER00001", "CAP0000001"));
    const text = await failureText(() =>
      handle.db.insert(seedOrders).values(order("KIK-1013", "ORDER00002", "CAP0000002")),
    );
    expect(text).toMatch(/seed_orders_pkey/);
  });

  it("rejects a repeated PayPal order ID", async () => {
    await handle.db.insert(seedOrders).values(order("KIK-1013", "ORDER00001", "CAP0000001"));
    const text = await failureText(() =>
      handle.db.insert(seedOrders).values(order("KIK-1014", "ORDER00001", "CAP0000002")),
    );
    expect(text).toMatch(/seed_orders_paypal_order_id_unique/);
    expect(await handle.db.select().from(seedOrders)).toHaveLength(1);
  });

  it("rejects a repeated PayPal capture ID", async () => {
    await handle.db.insert(seedOrders).values(order("KIK-1013", "ORDER00001", "CAP0000001"));
    const text = await failureText(() =>
      handle.db.insert(seedOrders).values(order("KIK-1014", "ORDER00002", "CAP0000001")),
    );
    expect(text).toMatch(/seed_orders_paypal_capture_id_unique/);
    expect(await handle.db.select().from(seedOrders)).toHaveLength(1);
  });

  it("leaves audit_log append-only", async () => {
    await handle.db.insert(auditLog).values({
      seq: 1,
      entryType: "decision",
      refId: "int_1",
      at: "2026-10-17T09:00:00.000Z",
      payload: '{"seq":1}',
      prevHash: "0".repeat(64),
      hash: "a".repeat(64),
    });
    const text = await failureText(() =>
      handle.db.update(auditLog).set({ payload: '{"seq":2}' }).where(sql`${auditLog.seq} = 1`),
    );
    expect(text).toMatch(/audit_log is append-only/);
  });
});
