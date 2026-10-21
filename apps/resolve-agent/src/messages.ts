import { type Database, readThread } from "@countersign/db";
import { z } from "zod";
import type { IncomingMessage } from "./intake";
import type { RunMode } from "./runs";

// Reading `POST /messages` (ADR 0030). Every check runs before anything is stored, and a refusal
// is one plain sentence naming the problem, never the value sent. The sender is what the customer
// typed: Resolve doesn't check it; the gate compares it with the payer (ADR 0029).

export const MAX_ATTACHMENTS = 3;
export const MAX_ATTACHMENT_BYTES = 2 * 1024 * 1024;
export const MAX_BODY_CHARS = 4_000;
export const MAX_SUBJECT_CHARS = 200;

export const IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;
type ImageType = (typeof IMAGE_TYPES)[number];

const MessageSchema = z.strictObject({
  channel: z.enum(["email", "chat"]),
  thread_id: z.string().min(1).max(256).optional(),
  sender_email: z.email().max(254).optional(),
  sender_phone: z
    .string()
    .regex(/^\+?[0-9][0-9 ()-]{3,30}$/)
    .optional(),
  subject: z.string().max(MAX_SUBJECT_CHARS).regex(/\S/).optional(),
  body: z.string().max(MAX_BODY_CHARS).regex(/\S/),
  attachments: z
    .array(z.strictObject({ content_type: z.string().max(256), data: z.string() }))
    .max(MAX_ATTACHMENTS)
    .default([]),
  mode: z.enum(["protected", "baseline"]).default("protected"),
});

// One sentence per field, so a refusal names the problem and never echoes what was sent.
const FIELD_PROBLEMS: Record<string, string> = {
  channel: "The channel must be email or chat.",
  thread_id: "The thread ID isn't valid.",
  sender_email: "The sender's email address isn't valid.",
  sender_phone: "The sender's phone number isn't valid.",
  subject: `The subject must be 1 to ${MAX_SUBJECT_CHARS} characters.`,
  body: `The message must be 1 to ${MAX_BODY_CHARS.toLocaleString("en-US")} characters.`,
  attachments: `A message can have up to ${MAX_ATTACHMENTS} photos, each with a content type and data.`,
  mode: "The mode must be protected or baseline.",
};

export type ParsedMessage = { message: IncomingMessage; mode: RunMode };

export type MessageCheck = { ok: true; value: ParsedMessage } | { ok: false; problem: string };

const refuse = (problem: string): MessageCheck => ({ ok: false, problem });

const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

const startsWith = (bytes: Uint8Array, signature: readonly number[], offset = 0): boolean =>
  bytes.length >= offset + signature.length &&
  signature.every((byte, i) => bytes[offset + i] === byte);

/** The image type the first bytes show, whatever type was declared; null for anything else. */
export function sniffImageType(bytes: Uint8Array): ImageType | null {
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  // "RIFF", four bytes of size, then "WEBP".
  if (startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && startsWith(bytes, [0x57, 0x45, 0x42, 0x50], 8))
    return "image/webp";
  return null;
}

const ordinal = (index: number) => ["first", "second", "third"][index] ?? `${index + 1}th`;

function decodeAttachment(
  attachment: { content_type: string; data: string },
  index: number,
): { ok: true; value: IncomingMessage["attachments"][number] } | { ok: false; problem: string } {
  const which = `The ${ordinal(index)} photo`;
  const declared = IMAGE_TYPES.find((type) => type === attachment.content_type);
  if (declared === undefined)
    return { ok: false, problem: `${which} must be a JPEG, PNG or WebP image.` };
  // Base64 is 4 characters per 3 bytes, so anything longer than this is over the limit.
  if (attachment.data.length > Math.ceil(MAX_ATTACHMENT_BYTES / 3) * 4)
    return { ok: false, problem: `${which} is larger than 2 MB.` };
  if (attachment.data.length === 0 || !BASE64.test(attachment.data))
    return { ok: false, problem: `${which} isn't valid base64 data.` };
  const bytes = new Uint8Array(Buffer.from(attachment.data, "base64"));
  if (bytes.byteLength > MAX_ATTACHMENT_BYTES)
    return { ok: false, problem: `${which} is larger than 2 MB.` };
  if (sniffImageType(bytes) !== declared)
    return {
      ok: false,
      problem: `${which} isn't the ${declared.slice(6).toUpperCase()} image its type says.`,
    };
  return { ok: true, value: { contentType: declared, bytes } };
}

/**
 * Checks one message against requirements.md: its fields, channel rules, photos (by their first
 * bytes) and thread. Reads the thread from `db`; writes nothing.
 */
export async function checkMessage(db: Database, input: unknown): Promise<MessageCheck> {
  if (typeof input !== "object" || input === null || Array.isArray(input))
    return refuse("The message must be a JSON object.");
  const parsed = MessageSchema.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    if (issue?.code === "unrecognized_keys")
      return refuse(
        issue.path.length === 0
          ? "The message has a field Resolve doesn't take."
          : "A photo has a field Resolve doesn't take.",
      );
    const field = String(issue?.path[0] ?? "");
    return refuse(FIELD_PROBLEMS[field] ?? "The message isn't valid.");
  }
  const data = parsed.data;

  if (data.channel === "email") {
    if (data.sender_email === undefined)
      return refuse("An email needs the sender's email address.");
    if (data.subject === undefined) return refuse("An email needs a subject.");
    if (data.sender_phone !== undefined) return refuse("Only a chat can have a phone number.");
  } else {
    if (data.subject !== undefined) return refuse("Only an email can have a subject.");
    if (data.sender_email === undefined && data.sender_phone === undefined)
      return refuse("A chat needs the sender's email address or phone number.");
  }

  const attachments: IncomingMessage["attachments"] = [];
  for (const [index, attachment] of data.attachments.entries()) {
    const decoded = decodeAttachment(attachment, index);
    if (!decoded.ok) return refuse(decoded.problem);
    attachments.push(decoded.value);
  }

  const senderEmail = data.sender_email ?? null;
  const senderPhone = data.sender_phone ?? null;
  if (data.thread_id !== undefined) {
    const [first] = await readThread(db, data.thread_id);
    if (first === undefined) return refuse("There's no thread with that ID.");
    if (
      first.channel !== data.channel ||
      first.senderEmail !== senderEmail ||
      first.senderPhone !== senderPhone
    )
      return refuse("That thread has another channel or sender.");
  }

  return {
    ok: true,
    value: {
      mode: data.mode,
      message: {
        channel: data.channel,
        ...(data.thread_id === undefined ? {} : { threadId: data.thread_id }),
        senderEmail,
        senderPhone,
        subject: data.subject ?? null,
        body: data.body,
        attachments,
      },
    },
  };
}
