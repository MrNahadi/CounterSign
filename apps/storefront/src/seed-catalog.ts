// The seed catalog: the 30 demo orders (KIK-1013 to KIK-1042) and the carrier shipment each one gets.
// Scan events are day offsets before seeding. The carrier is simulated (brief section 15).

import { checkShipment, type ScanEvent, type Shipment } from "@countersign/carrier-mock";
import { type ShipmentStatus, TimestampSchema } from "@countersign/mandate";
import { z } from "zod";
import { getProduct, type Product } from "./products";

export const CARRIER_NAME = "Kisumu Couriers (simulated)";

/** 4 to 24 lowercase letters and digits. */
export const RunIdSchema = z.string().regex(/^[a-z0-9]{4,24}$/);

export type SeedBuyer = "A" | "B";

export type ScanOffset = {
  /** Days before seeding. Fractions are allowed. */
  daysBefore: number;
  description: string;
  place: string;
};

export type DemoOrder = {
  /** `KIK-` and four digits. */
  orderNumber: string;
  productId: string;
  buyer: SeedBuyer;
  status: ShipmentStatus;
  scans: readonly ScanOffset[];
  role: string;
};

const scan = (daysBefore: number, description: string, place: string): ScanOffset => ({
  daysBefore,
  description,
  place,
});

/** Picked up, left the hub, reached the depot, out for delivery, delivered. */
const delivered = (pickedUp: number, deliveredOn: number, depot = "Nairobi"): ScanOffset[] => {
  const step = (pickedUp - deliveredOn) / 4;
  return [
    scan(pickedUp, "Picked up", "Kisumu"),
    scan(pickedUp - step, "Left the Kisumu hub", "Kisumu"),
    scan(pickedUp - 2 * step, `Reached the ${depot} depot`, depot),
    scan(pickedUp - 3 * step, "Out for delivery", depot),
    scan(deliveredOn, "Delivered", depot),
  ];
};

/** Picked up, left the hub, then the latest scan. */
const moving = (pickedUp: number, lastScan: number, depot = "Nakuru"): ScanOffset[] => [
  scan(pickedUp, "Picked up", "Kisumu"),
  scan(pickedUp - (pickedUp - lastScan) / 2, "Left the Kisumu hub", "Kisumu"),
  scan(lastScan, `Reached the ${depot} depot`, depot),
];

/** Picked up, left the hub, then reported lost. */
const lost = (pickedUp: number, reportedOn: number, depot = "Nairobi"): ScanOffset[] => [
  scan(pickedUp, "Picked up", "Kisumu"),
  scan(pickedUp - (pickedUp - reportedOn) / 2, "Left the Kisumu hub", "Kisumu"),
  scan(reportedOn, "Reported lost", depot),
];

const order = (
  number: number,
  productId: string,
  buyer: SeedBuyer,
  status: ShipmentStatus,
  scans: readonly ScanOffset[],
  role = "filler",
): DemoOrder => ({ orderNumber: `KIK-${number}`, productId, buyer, status, scans, role });

export const DEMO_ORDERS: readonly DemoOrder[] = [
  order(1013, "market-basket", "A", "delivered", delivered(26, 20)),
  order(1014, "woven-tote", "A", "delivered", delivered(24, 19, "Mombasa")),
  order(1015, "coaster-set", "B", "delivered", delivered(22, 17)),
  order(1016, "bread-basket", "A", "in_transit", moving(5, 1)),
  order(1017, "clutch-bag", "A", "delivered", delivered(21, 15, "Eldoret")),
  order(1018, "wall-plate", "A", "stalled_10d", moving(23, 12)),
  order(1019, "floor-basket", "A", "delivered", delivered(20, 14)),
  order(1020, "laundry-hamper", "A", "in_transit", moving(6, 2, "Eldoret")),
  order(1021, "woven-tote", "B", "delivered", delivered(19, 13, "Mombasa")),
  order(1022, "market-basket", "A", "lost", lost(25, 15)),
  order(1023, "coaster-set", "A", "delivered", delivered(18, 12)),
  order(1024, "bread-basket", "A", "in_transit", moving(4, 0.5)),
  order(1025, "wall-plate", "A", "delivered", delivered(17, 11, "Eldoret")),
  order(1026, "clutch-bag", "A", "stalled_10d", moving(20, 11, "Eldoret")),
  order(1027, "market-basket", "B", "in_transit", moving(7, 3, "Mombasa")),
  order(1028, "woven-tote", "A", "delivered", delivered(16, 10)),
  order(1029, "floor-basket", "A", "stalled_10d", moving(22, 13, "Mombasa")),
  order(1030, "bread-basket", "A", "in_transit", moving(5, 2)),
  order(1031, "laundry-hamper", "A", "lost", lost(24, 14, "Mombasa")),
  order(1032, "laundry-hamper", "A", "delivered", delivered(15, 9), "dispute"),
  order(1033, "clutch-bag", "A", "delivered", delivered(14, 8), "wrong_item"),
  order(1034, "wall-plate", "A", "lost", lost(21, 12), "lost_under_cap"),
  order(1035, "coaster-set", "A", "stalled_10d", moving(18, 14), "beat_4"),
  order(1036, "laundry-hamper", "A", "lost", lost(22, 13), "lost_over_cap"),
  order(1037, "floor-basket", "A", "delivered", delivered(13, 6), "beat_5_damaged"),
  order(1038, "market-basket", "B", "delivered", delivered(12, 7), "beat_3_named"),
  order(1039, "woven-tote", "B", "delivered", delivered(11, 6), "beat_3_named"),
  order(1040, "bread-basket", "B", "in_transit", moving(4, 1), "beat_3_named"),
  order(1041, "coaster-set", "B", "delivered", delivered(10, 5), "beat_3_named"),
  order(1042, "market-basket", "A", "delivered", delivered(9, 5), "beat_3_held"),
];

/** The product a demo order buys. Throws when the catalog names a product that doesn't exist. */
export function productFor(demoOrder: DemoOrder): Product {
  const product = getProduct(demoOrder.productId);
  if (!product) throw new Error(`${demoOrder.orderNumber} names an unknown product`);
  return product;
}

/** `KC-<run>-<order digits>`, for example `KC-run1-1032`. */
export function trackingNumberFor(runId: string, orderNumber: string): string {
  const run = RunIdSchema.parse(runId);
  const digits = /^KIK-(\d{4})$/.exec(orderNumber)?.[1];
  if (!digits) throw new Error(`${orderNumber} is not a demo order number`);
  return `KC-${run}-${digits}`;
}

const DAY_MS = 86_400_000;

/**
 * Builds a demo order's carrier shipment. Scan times are worked out back from `seededAt`, so no
 * clock is read. The row's `updatedAt` is the seeding time.
 */
export function buildDemoShipment(
  demoOrder: DemoOrder,
  options: { runId: string; seededAt: string },
): Shipment {
  const seededAt = TimestampSchema.parse(options.seededAt);
  const base = Date.parse(seededAt);
  const scanEvents: ScanEvent[] = demoOrder.scans.map((s) => ({
    at: new Date(base - Math.round(s.daysBefore * DAY_MS)).toISOString(),
    description: s.description,
    place: s.place,
  }));
  return checkShipment({
    trackingNumber: trackingNumberFor(options.runId, demoOrder.orderNumber),
    carrierName: CARRIER_NAME,
    status: demoOrder.status,
    scanEvents,
    updatedAt: seededAt,
  });
}
