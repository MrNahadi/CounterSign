// The ticket store's writers and readers (ADRs 0029 and 0030). A ticket or attachment is written
// once: the same ID with the same contents is a no-op, and with other contents it's refused,
// never overwritten.

import { TimestampSchema } from "@countersign/mandate";
import { asc, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import type { Database } from "./client";
import {
  TICKET_CHANNELS,
  type TicketChannel,
  type TicketRow,
  ticketAttachments,
  tickets,
} from "./schema";

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
  threadId: z.string().min(1).max(256).optional(),
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
  /** The thread it belongs to (ADR 0030). Written as the ticket's own ID when left out. */
  threadId?: string;
};

/** A stored ticket with its thread, as the thread readers return it. */
export type ThreadTicket = Ticket & { threadId: string };

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

const describeIssue = (error: z.ZodError, subject = "ticket"): string => {
  const issue = error.issues[0];
  if (!issue) return `${subject}: invalid`;
  const path = issue.path.length > 0 ? issue.path.map(String).join(".") : subject;
  return `${path}: ${issue.message}`.replace(/\s+/g, " ").trim();
};

// Stored attachments come back from jsonb, so they're parsed again rather than trusted.
const StoredAttachmentsSchema = z.array(TicketAttachmentSchema);

const fromRow = (row: TicketRow): ThreadTicket => ({
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
  threadId: row.threadId,
});

// Field by field, in a fixed order, so jsonb's key order never matters.
const sameContents = (a: ThreadTicket, b: ThreadTicket): boolean =>
  a.id === b.id &&
  a.threadId === b.threadId &&
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

const readStored = async (db: Database, id: string): Promise<ThreadTicket | null> => {
  const [row] = await db.select().from(tickets).where(eq(tickets.id, id)).limit(1);
  return row ? fromRow(row) : null;
};

/** The ticket with this ID, or null when none is stored. Its thread comes from `readThread`. */
export const readTicket = async (db: Database, id: string): Promise<Ticket | null> => {
  const stored = await readStored(db, id);
  if (!stored) return null;
  const { threadId: _threadId, ...ticket } = stored;
  return ticket;
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
  const ticket: ThreadTicket = { ...parsed.data, threadId: parsed.data.threadId ?? parsed.data.id };
  const inserted = await db
    .insert(tickets)
    .values(ticket)
    .onConflictDoNothing({ target: tickets.id })
    .returning({ id: tickets.id });
  if (inserted.length > 0) return "written";
  const stored = await readStored(db, ticket.id);
  if (stored && sameContents(stored, ticket)) return "unchanged";
  throw new TicketConflictError(ticket.id);
};

// Received times are ISO 8601 text with any offset, so they're ordered as instants, not as text.
const receivedInstant = sql`${tickets.receivedAt}::timestamptz`;

/** A thread's tickets, oldest first. An unknown thread reads as none: an empty list. */
export const readThread = async (db: Database, threadId: string): Promise<ThreadTicket[]> => {
  const rows = await db
    .select()
    .from(tickets)
    .where(eq(tickets.threadId, threadId))
    .orderBy(asc(receivedInstant), asc(tickets.id));
  return rows.map(fromRow);
};

/** One thread in the thread list: its first ticket and the time of its latest ticket. */
export type ThreadSummary = {
  threadId: string;
  first: ThreadTicket;
  latestActivityAt: string;
};

/**
 * Every thread, newest activity first: each with its first ticket and the received time of its
 * latest ticket, as stored. Threads with the same latest instant are ordered by thread ID.
 */
export const listThreads = async (db: Database): Promise<ThreadSummary[]> => {
  const firsts = await db
    .selectDistinctOn([tickets.threadId])
    .from(tickets)
    .orderBy(asc(tickets.threadId), asc(receivedInstant), asc(tickets.id));
  const latests = await db
    .selectDistinctOn([tickets.threadId], {
      threadId: tickets.threadId,
      receivedAt: tickets.receivedAt,
    })
    .from(tickets)
    .orderBy(asc(tickets.threadId), desc(receivedInstant), desc(tickets.id));
  const latestById = new Map(latests.map((row) => [row.threadId, row.receivedAt]));
  const summaries = firsts.map((row) => {
    const first = fromRow(row);
    return {
      threadId: first.threadId,
      first,
      latestActivityAt: latestById.get(first.threadId) ?? first.receivedAt,
    };
  });
  return summaries.sort(
    (a, b) =>
      Date.parse(b.latestActivityAt) - Date.parse(a.latestActivityAt) ||
      (a.threadId < b.threadId ? -1 : a.threadId > b.threadId ? 1 : 0),
  );
};

export const AttachmentSchema = z.strictObject({
  id: z.string().min(1).max(256),
  ticketId: z.string().min(1).max(256),
  contentType: z.string().min(1).max(256),
  bytes: z.instanceof(Uint8Array),
});

/** One file a customer attached, with its bytes. `size` is worked out from the bytes. */
export type Attachment = {
  id: string;
  ticketId: string;
  contentType: string;
  bytes: Uint8Array;
};

/** A stored attachment, as `readAttachment` returns it. */
export type StoredAttachment = Attachment & { size: number };

/** Thrown when an attachment to write fails `AttachmentSchema`. The message holds no input. */
export class InvalidAttachmentError extends Error {
  override readonly name = "InvalidAttachmentError";
}

/** Thrown when an attachment's ID is already stored with other contents. Nothing is changed. */
export class AttachmentConflictError extends Error {
  override readonly name = "AttachmentConflictError";
  readonly attachmentId: string;
  constructor(attachmentId: string) {
    super(`Attachment ${attachmentId} is already stored with other contents.`);
    this.attachmentId = attachmentId;
  }
}

const sameBytes = (a: Uint8Array, b: Uint8Array): boolean =>
  a.byteLength === b.byteLength && a.every((byte, i) => byte === b[i]);

/** The attachment with this ID and its bytes, or null when none is stored. */
export const readAttachment = async (
  db: Database,
  id: string,
): Promise<StoredAttachment | null> => {
  const [row] = await db
    .select()
    .from(ticketAttachments)
    .where(eq(ticketAttachments.id, id))
    .limit(1);
  if (!row) return null;
  return {
    id: row.id,
    ticketId: row.ticketId,
    contentType: row.contentType,
    size: row.size,
    bytes: row.bytes,
  };
};

/**
 * Writes an attachment once. Returns `written` for a new ID and `unchanged` when the same
 * contents are already stored. Throws `InvalidAttachmentError` for input that fails
 * `AttachmentSchema`, and `AttachmentConflictError` when the ID is stored with other contents.
 */
export const writeAttachment = async (
  db: Database,
  input: Attachment,
): Promise<"written" | "unchanged"> => {
  const parsed = AttachmentSchema.safeParse(input);
  if (!parsed.success)
    throw new InvalidAttachmentError(
      `Invalid attachment: ${describeIssue(parsed.error, "attachment")}`,
    );
  const attachment = parsed.data;
  const inserted = await db
    .insert(ticketAttachments)
    .values({ ...attachment, size: attachment.bytes.byteLength })
    .onConflictDoNothing({ target: ticketAttachments.id })
    .returning({ id: ticketAttachments.id });
  if (inserted.length > 0) return "written";
  const stored = await readAttachment(db, attachment.id);
  if (
    stored &&
    stored.ticketId === attachment.ticketId &&
    stored.contentType === attachment.contentType &&
    sameBytes(stored.bytes, attachment.bytes)
  )
    return "unchanged";
  throw new AttachmentConflictError(attachment.id);
};
