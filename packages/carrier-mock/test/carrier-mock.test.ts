import { carrierShipments, createTestDatabase, type DatabaseHandle, sql } from "@countersign/db";
import { SHIPMENT_STATUSES } from "@countersign/mandate";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  type CarrierAdapter,
  createDatabaseShipmentStore,
  createMemoryShipmentStore,
  createMockCarrier,
  type Shipment,
  type ShipmentStore,
} from "../src/index";

const shipment = (overrides: Partial<Shipment> = {}): Shipment => ({
  trackingNumber: "KC-run1-1013",
  carrierName: "Kisumu Couriers (simulated)",
  status: "in_transit",
  scanEvents: [
    { at: "2026-10-10T08:00:00.000Z", description: "Picked up", place: "Kisumu" },
    { at: "2026-10-12T14:30:00.000Z", description: "Arrived at hub", place: "Nairobi" },
  ],
  updatedAt: "2026-10-17T09:00:00.000Z",
  ...overrides,
});

// Counts reads, so a test can show a lookup never reached the store.
const counting = (store: ShipmentStore) => {
  let reads = 0;
  const wrapped: ShipmentStore = {
    read: (trackingNumber) => {
      reads += 1;
      return store.read(trackingNumber);
    },
    write: (record) => store.write(record),
  };
  return { store: wrapped, reads: () => reads };
};

const malformedNumbers = ["", " ", "KC 1013", "KC_1013", "KC-1013\n", "a".repeat(65), "KC/1013"];

type StoreCase = {
  name: string;
  setup: () => Promise<{
    store: ShipmentStore;
    // Puts a record in the store without the writer's validation.
    putRaw: (record: Record<string, unknown>) => Promise<void>;
  }>;
};

let handle: DatabaseHandle;

beforeAll(async () => {
  handle = await createTestDatabase();
});

afterAll(async () => {
  await handle.close();
});

const storeCases: StoreCase[] = [
  {
    name: "the in-memory store",
    setup: async () => {
      const raw = new Map<string, unknown>();
      return {
        store: createMemoryShipmentStore(raw),
        putRaw: async (record) => {
          raw.set(String(record.trackingNumber), record);
        },
      };
    },
  },
  {
    name: "the database store",
    setup: async () => {
      await handle.db.execute(sql`TRUNCATE carrier_shipments`);
      return {
        store: createDatabaseShipmentStore(handle.db),
        putRaw: async (record) => {
          await handle.db.insert(carrierShipments).values(record as never);
        },
      };
    },
  },
];

describe.each(storeCases)("the mock carrier over $name", ({ setup }) => {
  let store: ShipmentStore;
  let putRaw: (record: Record<string, unknown>) => Promise<void>;
  let carrier: CarrierAdapter;

  beforeEach(async () => {
    ({ store, putRaw } = await setup());
    carrier = createMockCarrier(store);
  });

  it.each(SHIPMENT_STATUSES)("round-trips a %s shipment with its scan events", async (status) => {
    const written = shipment({ status });
    await store.write(written);
    expect(await carrier.getShipment(written.trackingNumber)).toEqual({
      kind: "found",
      shipment: written,
    });
  });

  it("replaces an earlier shipment with the same tracking number", async () => {
    await store.write(shipment({ status: "in_transit" }));
    const later = shipment({
      status: "delivered",
      scanEvents: [
        ...shipment().scanEvents,
        { at: "2026-10-14T11:00:00.000Z", description: "Delivered", place: "Eldoret" },
      ],
      updatedAt: "2026-10-18T09:00:00.000Z",
    });
    await store.write(later);
    expect(await carrier.getShipment("KC-run1-1013")).toEqual({ kind: "found", shipment: later });
  });

  it.each([
    ["an unknown status", { status: "returned" }],
    ["a malformed tracking number", { trackingNumber: "KC 1013" }],
    ["an empty carrier name", { carrierName: "" }],
    [
      "a scan time without an offset",
      { scanEvents: [{ at: "2026-10-10T08:00:00", description: "Picked up", place: "Kisumu" }] },
    ],
    [
      "scan events out of time order",
      {
        scanEvents: [
          { at: "2026-10-12T14:30:00.000Z", description: "Arrived at hub", place: "Nairobi" },
          { at: "2026-10-10T08:00:00.000Z", description: "Picked up", place: "Kisumu" },
        ],
      },
    ],
    ["a missing update time", { updatedAt: undefined }],
  ])("refuses to write a shipment with %s, and keeps the earlier one", async (_, overrides) => {
    await store.write(shipment());
    const bad = { ...shipment(), ...overrides } as unknown as Shipment;
    await expect(store.write(bad)).rejects.toThrow(/Invalid shipment/);
    expect(await carrier.getShipment("KC-run1-1013")).toEqual({
      kind: "found",
      shipment: shipment(),
    });
  });

  it("reports an unknown tracking number as not found", async () => {
    await store.write(shipment());
    expect(await carrier.getShipment("KC-run1-1014")).toEqual({
      kind: "not_found",
      trackingNumber: "KC-run1-1014",
    });
  });

  it.each(malformedNumbers)(
    "reports the malformed tracking number %j as not found without reading the store",
    async (trackingNumber) => {
      const spy = counting(store);
      const result = await createMockCarrier(spy.store).getShipment(trackingNumber);
      expect(result).toEqual({ kind: "not_found", trackingNumber });
      expect(spy.reads()).toBe(0);
    },
  );

  it("reads the store for a well-formed tracking number of 64 characters", async () => {
    const spy = counting(store);
    const longest = "A".repeat(64);
    expect(await createMockCarrier(spy.store).getShipment(longest)).toEqual({
      kind: "not_found",
      trackingNumber: longest,
    });
    expect(spy.reads()).toBe(1);
  });

  it.each([
    [
      "scan events that aren't a list",
      { scanEvents: { at: "2026-10-10T08:00:00.000Z" } },
      /scanEvents/,
    ],
    [
      "a scan event with a bad time",
      {
        scanEvents: [{ at: "2026-02-31T08:00:00.000Z", description: "Picked up", place: "Kisumu" }],
      },
      /scanEvents\.0\.at/,
    ],
    [
      "scan events out of time order",
      {
        scanEvents: [
          { at: "2026-10-12T14:30:00.000Z", description: "Arrived at hub", place: "Nairobi" },
          { at: "2026-10-10T08:00:00.000Z", description: "Picked up", place: "Kisumu" },
        ],
      },
      /time order/,
    ],
    ["an update time that isn't a timestamp", { updatedAt: "yesterday" }, /updatedAt/],
    ["an empty carrier name", { carrierName: "" }, /carrierName/],
  ])("reports a stored row with %s as unreadable, with no status", async (_, overrides, detail) => {
    await putRaw({ ...shipment(), ...overrides });
    const result = await carrier.getShipment("KC-run1-1013");
    expect(result).toEqual({
      kind: "unreadable",
      trackingNumber: "KC-run1-1013",
      detail: expect.stringMatching(detail),
    });
    expect(result).not.toHaveProperty("shipment");
    expect(result).not.toHaveProperty("status");
    if (result.kind === "unreadable") expect(result.detail).not.toMatch(/\n/);
  });
});

describe("the in-memory store", () => {
  it("reports a stored record with an unknown status as unreadable", async () => {
    const raw = new Map<string, unknown>([["KC-run1-1013", { ...shipment(), status: "returned" }]]);
    const result = await createMockCarrier(createMemoryShipmentStore(raw)).getShipment(
      "KC-run1-1013",
    );
    expect(result).toEqual({
      kind: "unreadable",
      trackingNumber: "KC-run1-1013",
      detail: expect.stringMatching(/status/),
    });
  });

  it("reports a stored record filed under another tracking number as unreadable", async () => {
    const raw = new Map<string, unknown>([
      ["KC-run1-1013", shipment({ trackingNumber: "KC-run1-1014" })],
    ]);
    const result = await createMockCarrier(createMemoryShipmentStore(raw)).getShipment(
      "KC-run1-1013",
    );
    expect(result).toEqual({
      kind: "unreadable",
      trackingNumber: "KC-run1-1013",
      detail: expect.stringMatching(/tracking number/),
    });
  });

  it("keeps its own copy, so changing a written shipment afterwards changes nothing", async () => {
    const store = createMemoryShipmentStore();
    const written = shipment();
    await store.write(written);
    written.scanEvents.push({
      at: "2026-10-14T11:00:00.000Z",
      description: "Lost",
      place: "Nakuru",
    });
    expect(await createMockCarrier(store).getShipment("KC-run1-1013")).toEqual({
      kind: "found",
      shipment: shipment(),
    });
  });
});
