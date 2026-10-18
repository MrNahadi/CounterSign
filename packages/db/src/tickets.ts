// The ticket store's writer and reader (ADR 0029). A ticket is written once: the same ID with the
// same contents is a no-op, and with other contents it's refused, never overwritten.

import { TimestampSchema } from "@countersign/mandate";
import { eq } from "drizzle-orm";
import { z } from "zod";
import type { Database } from "./client";
import { TICKET_CHANNELS, type TicketChannel, type TicketRow, tickets } from "./schema";

const TicketAttachmentSchema = z.strictObject({
  id: z.string().min(1).max(256),
  contentType: z.string().min(1).max(256),
});

export const TicketSchema = z.strictObject({
  id: z.string().min(1).max(256),
  channel: z.enum(TICKET_CHANNELS),
  senderEmail: z.email().nullable(),
  senderPhone: z.string().min(1).max(64).nullable(),
  subject: z.string().nullable(),
  body: z.string(),
  attachments: z.array(TicketAttachmentSchema),
  receivedAt: TimestampSchema,
  simulated: z.boolean(),
});

/** One message a customer sent, as the ticket store keeps it. */
export type Ticket = {
  id: string;
  channel: TicketChannel;
  senderEmail: string | null;
  senderPhone: string | null;
  subject: string | null;
  body: string;
  attachments: { id: string; contentType: string }[];
  receivedAt: string;
  simulated: boolean;
};

/** Thrown when a ticket to write fails `TicketSchema`. The message holds no input values. */
export class InvalidTicketError extends Error {
  override readonly name = "InvalidTicketError";
}

/** Thrown when a ticket's ID is already stored with other contents. Nothing is changed. */
export class TicketConflictError extends Error {
  override readonly name = "TicketConflictError";
  readonly ticketId: string;
  constructor(ticketId: string) {
    super(`Ticket ${ticketId} is already stored with other contents.`);
    this.ticketId = ticketId;
  }
}

const describeIssue = (error: z.ZodError): string => {
  const issue = error.issues[0];
  if (!issue) return "ticket: invalid";
  const path = issue.path.length > 0 ? issue.path.map(String).join(".") : "ticket";
  return `${path}: ${issue.message}`.replace(/\s+/g, " ").trim();
};

// Stored attachments come back from jsonb, so they're parsed again rather than trusted.
const StoredAttachmentsSchema = z.array(TicketAttachmentSchema);

const fromRow = (row: TicketRow): Ticket => ({
  id: row.id,
  channel: z.enum(TICKET_CHANNELS).parse(row.channel),
  senderEmail: row.senderEmail,
  senderPhone: row.senderPhone,
  subject: row.subject,
  body: row.body,
  attachments: StoredAttachmentsSchema.parse(row.attachments).map(({ id, contentType }) => ({
    id,
    contentType,
  })),
  receivedAt: row.receivedAt,
  simulated: row.simulated,
});

// Field by field, in a fixed order, so jsonb's key order never matters.
const sameContents = (a: Ticket, b: Ticket): boolean =>
  a.id === b.id &&
  a.channel === b.channel &&
  a.senderEmail === b.senderEmail &&
  a.senderPhone === b.senderPhone &&
  a.subject === b.subject &&
  a.body === b.body &&
  a.receivedAt === b.receivedAt &&
  a.simulated === b.simulated &&
  a.attachments.length === b.attachments.length &&
  a.attachments.every(
    (item, i) =>
      item.id === b.attachments[i]?.id && item.contentType === b.attachments[i]?.contentType,
  );

/** The ticket with this ID, or null when none is stored. */
export const readTicket = async (db: Database, id: string): Promise<Ticket | null> => {
  const [row] = await db.select().from(tickets).where(eq(tickets.id, id)).limit(1);
  return row ? fromRow(row) : null;
};

/**
 * Writes a ticket once. Returns `written` for a new ID and `unchanged` when the same contents are
 * already stored. Throws `InvalidTicketError` for input that fails `TicketSchema`, and
 * `TicketConflictError` when the ID is stored with other contents.
 */
export const writeTicket = async (
  db: Database,
  input: Ticket,
): Promise<"written" | "unchanged"> => {
  const parsed = TicketSchema.safeParse(input);
  if (!parsed.success)
    throw new InvalidTicketError(`Invalid ticket: ${describeIssue(parsed.error)}`);
  const ticket: Ticket = parsed.data;
  const inserted = await db
    .insert(tickets)
    .values(ticket)
    .onConflictDoNothing({ target: tickets.id })
    .returning({ id: tickets.id });
  if (inserted.length > 0) return "written";
  const stored = await readTicket(db, ticket.id);
  if (stored && sameContents(stored, ticket)) return "unchanged";
  throw new TicketConflictError(ticket.id);
};
