// ticket.from_payer: the ticket came from the person who paid for the order.
// evidence.photo_present: the ticket has an image attachment.

import type { Intent, TraceEntry } from "@countersign/mandate";
import { entryFor } from "./entry";
import { orderFor, ticketFor } from "./lookups";
import type { RecordSnapshots } from "./snapshots";

// Blank counts as missing, so two empty emails can never match.
function normalizeEmail(email: string | null): string | null {
  const trimmed = email?.trim().toLowerCase();
  return trimmed ? trimmed : null;
}

// The ticket's sender email is the order's payer email, ignoring case and outer spaces.
export function ticketFromPayer(intent: Intent, records: RecordSnapshots): TraceEntry {
  const found = orderFor(intent, records);
  const { ticket, ref } = ticketFor(intent, records);
  const entry = entryFor("ticket.from_payer", [found.ref, ref]);
  // The payer to check is the one on the order the money was captured for.
  if (!found.order) return entry("unknown", found.missing);
  const { order } = found;
  if (!ticket) return entry("unknown", `No record of ticket ${intent.ticketId}`);
  const payer = normalizeEmail(order.payerEmail);
  const sender = normalizeEmail(ticket.senderEmail);
  if (!payer) return entry("unknown", `No payer email on order ${order.id}`);
  if (!sender) return entry("unknown", `No sender email on ticket ${ticket.id}`);
  return entry(sender === payer ? "pass" : "fail", `Sender ${sender}, payer ${payer}`);
}

// An image attachment on the ticket. AI may describe the photo, but never decides (original
// brief §8).
export function evidencePhotoPresent(intent: Intent, records: RecordSnapshots): TraceEntry {
  const { ticket, ref } = ticketFor(intent, records);
  const entry = entryFor("evidence.photo_present", [ref]);
  if (!ticket) return entry("unknown", `No record of ticket ${intent.ticketId}`);
  const image = ticket.attachments.find((attachment) =>
    attachment.contentType.trim().toLowerCase().startsWith("image/"),
  );
  return image
    ? entry("pass", `Ticket ${ticket.id} has image ${image.id}`)
    : entry("fail", `Ticket ${ticket.id} has no image attachment`);
}
