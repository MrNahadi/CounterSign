import { bigint, pgTable, text } from "drizzle-orm/pg-core";

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
