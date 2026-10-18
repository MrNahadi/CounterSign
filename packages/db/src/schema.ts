import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  customType,
  index,
  integer,
  jsonb,
  pgTable,
  text,
} from "drizzle-orm/pg-core";

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

/** The channels a ticket arrives on. */
export const TICKET_CHANNELS = ["email", "chat"] as const;
export type TicketChannel = (typeof TICKET_CHANNELS)[number];

/** One file a customer attached to a ticket. */
export type TicketAttachment = { id: string; contentType: string };

// The ticket store (ADR 0029): one row per message a customer sent. Written once through
// `writeTicket`, never updated; the gate reads it by ID. `receivedAt` is ISO 8601 text that
// passes the shared timestamp rule. `threadId` groups a conversation (ADR 0030): a thread's ID
// is its first ticket's ID. Not hashed, not append-only, and no trigger.
export const tickets = pgTable(
  "tickets",
  {
    id: text("id").primaryKey(),
    channel: text("channel").notNull(),
    senderEmail: text("sender_email"),
    senderPhone: text("sender_phone"),
    subject: text("subject"),
    body: text("body").notNull(),
    attachments: jsonb("attachments").$type<TicketAttachment[]>().notNull(),
    receivedAt: text("received_at").notNull(),
    simulated: boolean("simulated").notNull(),
    threadId: text("thread_id").notNull(),
  },
  (table) => [
    check("tickets_channel_check", sql`${table.channel} IN ('email', 'chat')`),
    index("tickets_thread_id_idx").on(table.threadId),
  ],
);

export type TicketRow = typeof tickets.$inferSelect;
export type NewTicketRow = typeof tickets.$inferInsert;

// Postgres `bytea`. PGlite reads it as a Uint8Array and postgres.js as a Buffer (a Uint8Array
// too); writes go as a Buffer, which both drivers send as bytes.
const bytea = customType<{ data: Uint8Array; driverData: Uint8Array }>({
  dataType: () => "bytea",
  toDriver: (value) => Buffer.from(value.buffer, value.byteOffset, value.byteLength),
  fromDriver: (value) => new Uint8Array(value),
});

// A file a customer attached to a ticket (ADR 0030), written once, before the ticket that lists
// it, so there's no foreign key. `size` is the byte count of `bytes`.
export const ticketAttachments = pgTable(
  "ticket_attachments",
  {
    id: text("id").primaryKey(),
    ticketId: text("ticket_id").notNull(),
    contentType: text("content_type").notNull(),
    size: integer("size").notNull(),
    bytes: bytea("bytes").notNull(),
  },
  (table) => [index("ticket_attachments_ticket_id_idx").on(table.ticketId)],
);

export type TicketAttachmentRow = typeof ticketAttachments.$inferSelect;
export type NewTicketAttachmentRow = typeof ticketAttachments.$inferInsert;
