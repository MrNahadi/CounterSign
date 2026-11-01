// A scenario message file and its senders: the rules the `resolve` CLI and Resolve's
// `POST /scenarios/:id` share. A file holds simulated messages, its photos sit beside it, and a
// sender is resolved to an email from `seed_orders`.

import { readFileSync } from "node:fs";
import { dirname, resolve as resolvePath } from "node:path";
import { asc, type Database, eq, seedOrders } from "@countersign/db";
import { firstIssueMessage } from "@countersign/mandate";
import { z } from "zod";
import { sniffImageType } from "./messages";

const OrderNumber = /^KIK-\d{4}$/;

const Sender = z.union([
  z.literal("buyer:A"),
  z.literal("buyer:B"),
  z.string().regex(/^payer:KIK-\d{4}$/),
  z.email({ error: "must be buyer:A, buyer:B, payer:<order number> or an email address" }),
]);
export type Sender = z.infer<typeof Sender>;

const FileMessage = z.strictObject({
  channel: z.enum(["email", "chat"]),
  sender: Sender,
  subject: z.string().min(1).optional(),
  body: z.string().min(1),
  // Photo paths, relative to the message file.
  attachments: z.array(z.string().min(1)).max(3).optional(),
  // The index of an earlier message in this file whose thread this one continues.
  follow_up_of: z.int().min(0).optional(),
});

export const MessageFileSchema = z
  .strictObject({
    // Says the people are illustrative and the messages simulated.
    description: z.string().min(1),
    messages: z.array(FileMessage).min(1),
  })
  .superRefine((file, ctx) => {
    file.messages.forEach((message, index) => {
      if (message.follow_up_of !== undefined && message.follow_up_of >= index) {
        ctx.addIssue({
          code: "custom",
          path: ["messages", index, "follow_up_of"],
          message: "must be the index of an earlier message",
        });
      }
    });
  });

export type MessageFile = z.infer<typeof MessageFileSchema>;
export type FileMessage = z.infer<typeof FileMessage>;

export type Photo = { contentType: string; data: string };
export type Loaded = { file: MessageFile; photos: Photo[][] };

/** Reads and checks the file, and reads every photo, before anything is stored. */
export function loadMessageFile(
  path: string,
): { ok: true; loaded: Loaded } | { ok: false; error: string } {
  let json: unknown;
  try {
    json = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    return {
      ok: false,
      error: error instanceof SyntaxError ? `${path} isn't valid JSON.` : `Can't read ${path}.`,
    };
  }
  const parsed = MessageFileSchema.safeParse(json);
  if (!parsed.success) return { ok: false, error: firstIssueMessage("Message file", parsed.error) };
  const photos: Photo[][] = [];
  for (const [index, message] of parsed.data.messages.entries()) {
    const read: Photo[] = [];
    for (const relative of message.attachments ?? []) {
      const photoPath = resolvePath(dirname(path), relative);
      let bytes: Buffer;
      try {
        bytes = readFileSync(photoPath);
      } catch {
        return { ok: false, error: `Message ${index + 1}: can't read the photo ${relative}.` };
      }
      const contentType = sniffImageType(new Uint8Array(bytes));
      if (contentType === null) {
        return {
          ok: false,
          error: `Message ${index + 1}: the photo ${relative} isn't a JPEG, PNG or WebP image.`,
        };
      }
      read.push({ contentType, data: bytes.toString("base64") });
    }
    photos.push(read);
  }
  return { ok: true, loaded: { file: parsed.data, photos } };
}

// ---- Senders ----

const notSeeded = (what: string) => `${what} isn't seeded. Run npm run seed first.`;

export type SenderResult =
  | { ok: true; email: string }
  // `unseeded` is "Order KIK-1035", "Buyer A" or "Buyer B" when the refusal is a missing seed
  // row, else null.
  | { ok: false; error: string; unseeded: string | null };

export async function senderEmail(db: Database, sender: Sender): Promise<SenderResult> {
  if (sender === "buyer:A" || sender === "buyer:B") {
    const buyer = sender.slice("buyer:".length);
    const [row] = await db
      .select()
      .from(seedOrders)
      .where(eq(seedOrders.buyer, buyer))
      .orderBy(asc(seedOrders.orderNumber))
      .limit(1);
    return row
      ? { ok: true, email: row.payerEmail }
      : { ok: false, error: notSeeded(`Buyer ${buyer}`), unseeded: `Buyer ${buyer}` };
  }
  if (sender.startsWith("payer:")) {
    const order = sender.slice("payer:".length);
    if (!OrderNumber.test(order)) {
      return { ok: false, error: `${sender} isn't an order number.`, unseeded: null };
    }
    const [row] = await db
      .select()
      .from(seedOrders)
      .where(eq(seedOrders.orderNumber, order))
      .limit(1);
    return row
      ? { ok: true, email: row.payerEmail }
      : { ok: false, error: notSeeded(`Order ${order}`), unseeded: `Order ${order}` };
  }
  return { ok: true, email: sender };
}

/** Every sender, and every follow-up's match with the message that starts its thread. */
export async function resolveSenders(
  db: Database,
  messages: readonly FileMessage[],
): Promise<{ ok: true; emails: string[] } | { ok: false; error: string }> {
  const emails: string[] = [];
  for (const [index, message] of messages.entries()) {
    const resolved = await senderEmail(db, message.sender);
    if (!resolved.ok) return { ok: false, error: `Message ${index + 1}: ${resolved.error}` };
    emails.push(resolved.email);
    let first = index;
    while (messages[first]?.follow_up_of !== undefined)
      first = messages[first]?.follow_up_of as number;
    if (
      first !== index &&
      (messages[first]?.channel !== message.channel || emails[first] !== resolved.email)
    ) {
      return {
        ok: false,
        error: `Message ${index + 1}: a follow-up must have the same channel and sender as message ${first + 1}.`,
      };
    }
  }
  return { ok: true, emails };
}
