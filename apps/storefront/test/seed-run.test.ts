import {
  carrierShipments,
  createTestDatabase,
  type DatabaseHandle,
  eq,
  seedOrders,
} from "@countersign/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEMO_ORDERS } from "../src/seed-catalog";
import { runSeed, SAME_BUYER_PROBLEM, type SeedRunInput } from "../src/seed-run";
import {
  BUYER_A_EMAIL,
  BUYER_B_EMAIL,
  FAKE_VAULT_A,
  FAKE_VAULT_B,
  fakeSandbox,
  paypalError,
} from "./fake-sandbox";

const SEEDED_AT = "2026-10-17T09:30:00.000Z";
const RUN = "run1";

type Json = Record<string, unknown>;
const unit = (order: Json) => (order.purchase_units as Json[])[0] as Json;
const captureOf = (order: Json) => ((unit(order).payments as Json).captures as Json[])[0] as Json;
const trackersOf = (order: Json) => (unit(order).shipping as { trackers: Json[] }).trackers;

describe("a seed run against a fake PayPal and PGlite", () => {
  let handle: DatabaseHandle;
  let sandbox: ReturnType<typeof fakeSandbox>;

  beforeEach(async () => {
    handle = await createTestDatabase();
    sandbox = fakeSandbox();
  });
  afterEach(async () => {
    await handle.close();
  });

  const seed = (overrides: Partial<SeedRunInput> = {}) =>
    runSeed({
      paypal: sandbox.client(),
      db: handle.db,
      orders: DEMO_ORDERS,
      runId: RUN,
      vaultTokens: { A: FAKE_VAULT_A, B: FAKE_VAULT_B },
      clock: () => SEEDED_AT,
      ...overrides,
    });

  const rows = () => handle.db.select().from(seedOrders);
  const shipments = () => handle.db.select().from(carrierShipments);
  const callsFor = (orderNumber: string) =>
    sandbox.calls.filter(
      (call) =>
        call.requestId?.includes(`-${orderNumber}-`) ||
        sandbox.orderFor(orderNumber).some((order) => call.path.includes(String(order.id))),
    );

  it("creates, tracks, reads back and records all 30 orders", async () => {
    const report = await seed();

    expect(report).toMatchObject({
      runId: RUN,
      total: 30,
      seeded: 30,
      failures: [],
      problem: null,
      counts: { delivered: 16, in_transit: 6, stalled_10d: 4, lost: 4 },
    });
    expect(await rows()).toHaveLength(30);
    expect(await shipments()).toHaveLength(30);
    expect(sandbox.ordersCreated()).toBe(30);

    for (const demo of DEMO_ORDERS) {
      const [order] = sandbox.orderFor(demo.orderNumber);
      if (!order) throw new Error(`no PayPal order for ${demo.orderNumber}`);
      const trackingNumber = `KC-${RUN}-${demo.orderNumber.slice(4)}`;
      const captureId = String(captureOf(order).id);
      expect(trackersOf(order)).toEqual([
        { id: `${captureId}-${trackingNumber}`, status: "SHIPPED" },
      ]);
      expect((order.payer as Json).email_address).toBe(
        demo.buyer === "A" ? BUYER_A_EMAIL : BUYER_B_EMAIL,
      );
      const [row] = await handle.db
        .select()
        .from(seedOrders)
        .where(eq(seedOrders.orderNumber, demo.orderNumber));
      expect(row).toMatchObject({
        runId: RUN,
        paypalOrderId: order.id,
        paypalCaptureId: captureId,
        buyer: demo.buyer,
        trackingNumber,
        role: demo.role,
        seededAt: SEEDED_AT,
        currency: "USD",
      });
      const [shipment] = await handle.db
        .select()
        .from(carrierShipments)
        .where(eq(carrierShipments.trackingNumber, trackingNumber));
      expect(shipment?.status).toBe(demo.status);
      expect(shipment?.carrierName).toBe("Kisumu Couriers (simulated)");
    }

    const [hamper] = await handle.db
      .select()
      .from(seedOrders)
      .where(eq(seedOrders.orderNumber, "KIK-1032"));
    expect(hamper).toMatchObject({
      amountMinor: 12000,
      payerEmail: BUYER_A_EMAIL,
      role: "dispute",
    });
  });

  it("names every request and reference after the run and order, with at most 3 in flight", async () => {
    await seed();

    const posts = sandbox.calls.filter((call) => call.method === "POST");
    for (const post of posts) {
      expect(post.requestId).toMatch(/^countersign-seed-run1-KIK-10\d\d-(create|track)$/);
    }
    const creates = posts.filter((call) => call.path === "/v2/checkout/orders");
    expect(creates.map((call) => call.requestId)).toEqual(
      DEMO_ORDERS.map((demo) => `countersign-seed-${RUN}-${demo.orderNumber}-create`),
    );
    for (const create of creates) {
      const body = create.body ?? {};
      const purchase = (body.purchase_units as Json[])[0] as Json;
      const orderNumber = String(purchase.reference_id);
      expect(purchase.custom_id).toBe(RUN);
      expect(purchase.invoice_id).toBe(`${orderNumber}-${RUN}`);
      const vault = (body.payment_source as { paypal: { vault_id: string } }).paypal;
      const demo = DEMO_ORDERS.find((d) => d.orderNumber === orderNumber);
      expect(vault.vault_id).toBe(demo?.buyer === "A" ? FAKE_VAULT_A : FAKE_VAULT_B);
    }
    const tracks = posts.filter((call) => call.path.endsWith("/track"));
    expect(tracks).toHaveLength(30);
    for (const track of tracks) {
      const orderNumber = /-(KIK-\d{4})-track$/.exec(track.requestId ?? "")?.[1] ?? "";
      expect(track.body).toMatchObject({
        tracking_number: `KC-${RUN}-${orderNumber.slice(4)}`,
        carrier: "OTHER",
        carrier_name_other: "Kisumu Couriers (simulated)",
        notify_payer: false,
      });
    }
    expect(sandbox.maxOrdersInFlight()).toBe(3);
  });

  it("changes nothing when the same run runs again", async () => {
    await seed();
    const callsBefore = sandbox.calls.length;
    const rowsBefore = await rows();

    const again = await seed({ clock: () => "2026-10-17T11:00:00.000Z" });

    expect(again).toMatchObject({ seeded: 30, failures: [], problem: null });
    expect(again.counts).toEqual({ delivered: 16, in_transit: 6, stalled_10d: 4, lost: 4 });
    expect(sandbox.calls.length).toBe(callsBefore);
    expect(sandbox.ordersCreated()).toBe(30);
    expect(sandbox.trackersAdded()).toBe(30);
    expect(await rows()).toEqual(rowsBefore);
  });

  it("seeds the rest when 2 orders fail, reports them, and completes them on a rerun", async () => {
    sandbox.hooks.fail = (orderNumber, call) => {
      if (orderNumber === "KIK-1020" && call === "create")
        return paypalError(422, "UNPROCESSABLE_ENTITY", "dbg1020");
      if (orderNumber === "KIK-1030" && call === "get")
        return paypalError(500, "INTERNAL_SERVER_ERROR", "dbg1030");
      return undefined;
    };

    const report = await seed();

    expect(report.seeded).toBe(28);
    expect(report.failures).toEqual([
      expect.objectContaining({
        orderNumber: "KIK-1020",
        call: "create-order",
        debugId: "dbg1020",
      }),
      expect.objectContaining({ orderNumber: "KIK-1030", call: "get-order", debugId: "dbg1030" }),
    ]);
    expect(report.failures[0]?.reason).toContain("HTTP 422");
    expect(report.failures[1]?.reason).toContain("HTTP 500");
    expect(await rows()).toHaveLength(28);
    const tracking = (await shipments()).map((s) => s.trackingNumber);
    expect(tracking).not.toContain("KC-run1-1020");
    expect(tracking).not.toContain("KC-run1-1030");

    sandbox.hooks.fail = undefined;
    const before = sandbox.calls.length;
    const rerun = await seed();

    expect(rerun).toMatchObject({ seeded: 30, failures: [], problem: null });
    expect(await rows()).toHaveLength(30);
    expect(await shipments()).toHaveLength(30);
    expect(sandbox.ordersCreated()).toBe(30);
    expect(sandbox.trackersAdded()).toBe(30);
    // Only the two failed orders are retried; KIK-1030's create and tracker are replays.
    const retried = sandbox.calls.slice(before);
    expect(new Set(retried.map((call) => /KIK-\d{4}/.exec(call.requestId ?? "")?.[0]))).toEqual(
      new Set(["KIK-1020", "KIK-1030", undefined]),
    );
    const replays = retried.filter((call) => call.requestId?.includes("-KIK-1030-"));
    expect(replays.map((call) => call.replayed)).toEqual([true, true]);
  });

  it("fails an order without a payer email or a completed capture for the price, with no tracker", async () => {
    sandbox.hooks.createAnswer = (orderNumber, answer) => {
      if (orderNumber === "KIK-1016") delete answer.payer;
      if (orderNumber === "KIK-1017") captureOf(answer).status = "PENDING";
      if (orderNumber === "KIK-1018")
        captureOf(answer).amount = { currency_code: "USD", value: "40.00" };
      if (orderNumber === "KIK-1019") answer.status = "PAYER_ACTION_REQUIRED";
    };

    const report = await seed();

    expect(report.seeded).toBe(26);
    expect(report.failures.map((f) => [f.orderNumber, f.call])).toEqual([
      ["KIK-1016", "create-order"],
      ["KIK-1017", "create-order"],
      ["KIK-1018", "create-order"],
      ["KIK-1019", "create-order"],
    ]);
    expect(report.failures.map((f) => f.reason)).toEqual([
      expect.stringContaining("payer email"),
      expect.stringContaining("PENDING"),
      expect.stringContaining("$40.00"),
      expect.stringContaining("PAYER_ACTION_REQUIRED"),
    ]);
    for (const orderNumber of ["KIK-1016", "KIK-1017", "KIK-1018", "KIK-1019"]) {
      expect(callsFor(orderNumber).filter((call) => call.path.endsWith("/track"))).toEqual([]);
      const [order] = sandbox.orderFor(orderNumber);
      expect(order && trackersOf(order)).toEqual([]);
    }
    const numbers = (await rows()).map((row) => row.orderNumber);
    expect(numbers).not.toContain("KIK-1016");
    expect(numbers).not.toContain("KIK-1019");
  });

  it("writes nothing for an order whose read-back lacks the tracker", async () => {
    sandbox.hooks.getAnswer = (orderNumber, answer) => {
      if (orderNumber === "KIK-1021") (unit(answer).shipping as { trackers: Json[] }).trackers = [];
      if (orderNumber === "KIK-1022") captureOf(answer).status = "REFUNDED";
    };

    const report = await seed();

    expect(report.failures.map((f) => [f.orderNumber, f.call])).toEqual([
      ["KIK-1021", "get-order"],
      ["KIK-1022", "get-order"],
    ]);
    const tracking = (await shipments()).map((s) => s.trackingNumber);
    expect(tracking).not.toContain("KC-run1-1021");
    expect(tracking).not.toContain("KC-run1-1022");
    expect(await rows()).toHaveLength(28);
  });

  it("writes the shipment and the seed row in one transaction", async () => {
    // A row from elsewhere already holds the capture ID the fake gives KIK-1013, so its seed row
    // insert fails. The shipment written before it in the same transaction must roll back.
    await handle.db.insert(seedOrders).values({
      orderNumber: "KIK-0001",
      runId: "other",
      paypalOrderId: "ORDOTHER",
      paypalCaptureId: "CAP1013V1",
      amountMinor: 100,
      currency: "USD",
      payerEmail: BUYER_A_EMAIL,
      buyer: "A",
      trackingNumber: "KC-other-0001",
      role: "filler",
      seededAt: SEEDED_AT,
    });

    const report = await seed({ databaseReason: () => "duplicate capture" });

    expect(report.seeded).toBe(29);
    expect(report.failures).toEqual([
      { orderNumber: "KIK-1013", call: "write-rows", reason: "duplicate capture", debugId: null },
    ]);
    const tracking = (await shipments()).map((s) => s.trackingNumber);
    expect(tracking).not.toContain("KC-run1-1013");
  });

  it("replaces an earlier run's seed rows", async () => {
    await seed({ runId: "run0" });
    const report = await seed();

    expect(report.seeded).toBe(30);
    const all = await rows();
    expect(all).toHaveLength(30);
    expect(new Set(all.map((row) => row.runId))).toEqual(new Set([RUN]));
    expect(await shipments()).toHaveLength(60);
  });

  it("fails the run when buyers A and B are the same PayPal account", async () => {
    sandbox = fakeSandbox({
      emails: { [FAKE_VAULT_A]: BUYER_A_EMAIL, [FAKE_VAULT_B]: BUYER_A_EMAIL.toUpperCase() },
    });

    const report = await seed();

    expect(SAME_BUYER_PROBLEM).toBe("Buyers A and B are the same PayPal account");
    expect(report.problem).toBe(SAME_BUYER_PROBLEM);
    expect(report.seeded).toBeLessThan(30);
  });

  it("refuses a malformed run ID or a missing vault token before any call", async () => {
    await expect(seed({ runId: "Run-1" })).rejects.toThrow(/run ID/);
    await expect(seed({ vaultTokens: { A: FAKE_VAULT_A, B: "" } })).rejects.toThrow(/buyer B/);
    expect(sandbox.calls).toEqual([]);
  });

  it("never puts a vault token in its report", async () => {
    sandbox.hooks.fail = (orderNumber, call) =>
      orderNumber === "KIK-1013" && call === "create"
        ? paypalError(400, "INVALID_REQUEST", "dbg1013")
        : undefined;
    const report = await seed();
    const text = JSON.stringify(report);
    expect(text).not.toContain(FAKE_VAULT_A);
    expect(text).not.toContain(FAKE_VAULT_B);
  });
});
