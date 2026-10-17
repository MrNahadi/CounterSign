import { sql } from "drizzle-orm";
import { bigint, check, jsonb, pgTable, text } from "drizzle-orm/pg-core";

// The audit log (ADR 0022). `payload` and `at` are the exact text that was hashed, never jsonb.
// The chain itself is enforced here: `seq` is the primary key and `prev_hash` is unique, so a
// row can't repeat a position or fork the chain. The append-only trigger is in the first
// migration, because drizzle-kit doesn't model triggers.
export const auditLog = pgTable("audit_log", {
  seq: bigint("seq", { mode: "number" }).primaryKey(),
  entryType: text("entry_type").notNull(),
  refId: text("ref_id"),
  at: text("at").notNull(),
  payload: text("payload").notNull(),
  prevHash: text("prev_hash").notNull().unique(),
  hash: text("hash").notNull().unique(),
});

export type AuditLogRow = typeof auditLog.$inferSelect;
export type NewAuditLogRow = typeof auditLog.$inferInsert;

/** The four shipment statuses the carrier mock can report (ADR 0023). */
export const SHIPMENT_STATUSES = ["lost", "stalled_10d", "in_transit", "delivered"] as const;
export type StoredShipmentStatus = (typeof SHIPMENT_STATUSES)[number];

/** One scan on a shipment. `at` is an ISO 8601 string, and events are stored in time order. */
export type ScanEvent = { at: string; description: string; place: string };

// Seeded carrier data (ADR 0023). The status is stored, never worked out from the clock. Times
// are ISO 8601 text; the writer checks them with the shared timestamp rule. Not hashed, not
// append-only, and no trigger.
export const carrierShipments = pgTable(
  "carrier_shipments",
  {
    trackingNumber: text("tracking_number").primaryKey(),
    status: text("status").notNull(),
    carrierName: text("carrier_name").notNull(),
    scanEvents: jsonb("scan_events").$type<ScanEvent[]>().notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    check(
      "carrier_shipments_status_check",
      sql`${table.status} IN ('lost', 'stalled_10d', 'in_transit', 'delivered')`,
    ),
  ],
);

export type CarrierShipmentRow = typeof carrierShipments.$inferSelect;
export type NewCarrierShipmentRow = typeof carrierShipments.$inferInsert;

// One row per demo order (ADR 0023). Amounts are integer minor units. `payerEmail` is as PayPal
// returned it. `buyer` is `A` or `B`, and `role` is the order's demo role.
export const seedOrders = pgTable("seed_orders", {
  orderNumber: text("order_number").primaryKey(),
  runId: text("run_id").notNull(),
  paypalOrderId: text("paypal_order_id").notNull().unique(),
  paypalCaptureId: text("paypal_capture_id").notNull().unique(),
  amountMinor: bigint("amount_minor", { mode: "number" }).notNull(),
  currency: text("currency").notNull(),
  payerEmail: text("payer_email").notNull(),
  buyer: text("buyer").notNull(),
  trackingNumber: text("tracking_number").notNull(),
  role: text("role").notNull(),
  seededAt: text("seeded_at").notNull(),
});

export type SeedOrderRow = typeof seedOrders.$inferSelect;
export type NewSeedOrderRow = typeof seedOrders.$inferInsert;
