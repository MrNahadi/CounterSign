import { randomBytes } from "node:crypto";
import {
  createRun,
  type Database,
  type RunMode,
  writeAttachment,
  writeTicket,
} from "@countersign/db";

// Storing one customer message (ADR 0030): each attachment, then the ticket, then a queued run.
// The message is already checked; the HTTP API (T-009) and the CLI validate it first. Every
// ticket Resolve writes is simulated: no email is sent or received.

/** `<prefix>_` plus 128 random bits, so IDs can't be guessed. */
export const newId = (prefix: "tkt" | "att" | "run" | "drf"): string =>
  `${prefix}_${randomBytes(16).toString("hex")}`;

export type IncomingMessage = {
  channel: "email" | "chat";
  /** An existing thread to add to; without one the ticket starts its own. */
  threadId?: string;
  senderEmail: string | null;
  senderPhone: string | null;
  subject: string | null;
  body: string;
  attachments: { contentType: string; bytes: Uint8Array }[];
};

export type StoredMessage = { ticketId: string; threadId: string; runId: string };

export type StoreOptions = {
  mode: RunMode;
  /** The model the run will ask for. */
  model: string;
  /** The edge's clock: the ticket's received time and the run's queued time. */
  clock: () => Date;
};

export async function storeMessage(
  db: Database,
  message: IncomingMessage,
  options: StoreOptions,
): Promise<StoredMessage> {
  const at = options.clock().toISOString();
  const ticketId = newId("tkt");
  const attachments: { id: string; contentType: string }[] = [];
  for (const { contentType, bytes } of message.attachments) {
    const id = newId("att");
    await writeAttachment(db, { id, ticketId, contentType, bytes });
    attachments.push({ id, contentType });
  }
  const threadId = message.threadId ?? ticketId;
  await writeTicket(db, {
    id: ticketId,
    channel: message.channel,
    senderEmail: message.senderEmail,
    senderPhone: message.senderPhone,
    subject: message.subject,
    body: message.body,
    attachments,
    receivedAt: at,
    simulated: true,
    threadId,
  });
  const runId = newId("run");
  await createRun(db, {
    id: runId,
    ticketId,
    threadId,
    mode: options.mode,
    model: options.model,
    queuedAt: at,
  });
  return { ticketId, threadId, runId };
}
