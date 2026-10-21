import { z } from "zod";
import { RESOLVE_UNREACHABLE } from "./resolve-routes";
import {
  type Channel,
  MAX_BODY_CHARS,
  MAX_PHOTOS,
  MAX_SUBJECT_CHARS,
  MessageAcceptedSchema,
  type MessageRequest,
  MessageRequestSchema,
  type Mode,
  PHOTO_TYPES,
  ResolveMessageSchema,
} from "./resolve-schemas";

// The inbox's "Simulate a message" dialog and mode switch (ADR 0030): what the form becomes
// before it's sent, the browser-side photo checks, and the send itself. Browser-safe: no
// `@countersign/mandate` and nothing server-only. Resolve checks every rule again.

export const MESSAGES_PATH = "/api/resolve/messages";
export const DEFAULT_MODE: Mode = "protected";
export const MODE_STORAGE_KEY = "countersign-resolve-mode";
export const MAX_PHOTO_BYTES = 2 * 1024 * 1024;

export const MODE_OPTIONS: readonly { value: Mode; label: string }[] = [
  { value: "protected", label: "Protected" },
  { value: "baseline", label: "Baseline" },
];
export const CHANNEL_OPTIONS: readonly { value: Channel; label: string }[] = [
  { value: "email", label: "Email" },
  { value: "chat", label: "Chat" },
];

export const BASELINE_NOTE =
  "Baseline: the same agent wired straight to PayPal's tools, with no Countersign checks. Sandbox only.";
export const SIMULATED_NOTE = "Simulated: no email is sent or received.";

export type ComposerPhoto = { name: string; type: string; size: number; bytes: Uint8Array };

export type ComposerForm = {
  channel: Channel;
  senderEmail: string;
  senderPhone: string;
  subject: string;
  body: string;
  photos: readonly ComposerPhoto[];
};

export type ComposerField = "senderEmail" | "senderPhone" | "subject" | "body" | "photos";

export type ComposedMessage =
  | { ok: true; request: MessageRequest }
  | { ok: false; field: ComposerField; problem: string };

const EMAIL = z.email().max(254);
const PHONE = /^\+?[0-9][0-9 ()-]{3,30}$/;

export function parseMode(value: unknown): Mode {
  return value === "baseline" ? "baseline" : DEFAULT_MODE;
}

/** Why a picked photo can't be sent, in one sentence; null when it can. */
export function checkPhoto(photo: { name: string; type: string; size: number }): string | null {
  if (!(PHOTO_TYPES as readonly string[]).includes(photo.type))
    return `${photo.name} isn't a JPEG, PNG or WebP image.`;
  if (photo.size === 0) return `${photo.name} is empty.`;
  if (photo.size > MAX_PHOTO_BYTES) return `${photo.name} is larger than 2 MB.`;
  return null;
}

/** Standard base64, in the browser and on the server. */
export function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

const refuse = (field: ComposerField, problem: string): ComposedMessage => ({
  ok: false,
  field,
  problem,
});

/** The dialog's form as Resolve's `POST /messages` body, or the first field to fix. */
export function messageRequest(form: ComposerForm, mode: Mode): ComposedMessage {
  const senderEmail = form.senderEmail.trim();
  const senderPhone = form.channel === "chat" ? form.senderPhone.trim() : "";
  const subject = form.subject.trim();
  const body = form.body.trim();

  if (form.channel === "email" && senderEmail === "")
    return refuse("senderEmail", "Add the sender's email address.");
  if (form.channel === "chat" && senderEmail === "" && senderPhone === "")
    return refuse("senderEmail", "Add the sender's email address or phone number.");
  if (senderEmail !== "" && !EMAIL.safeParse(senderEmail).success)
    return refuse("senderEmail", "Use an email address like name@example.com.");
  if (senderPhone !== "" && !PHONE.test(senderPhone))
    return refuse("senderPhone", "Use digits for the phone number, with an optional + first.");
  if (form.channel === "email") {
    if (subject === "") return refuse("subject", "Add a subject.");
    if (subject.length > MAX_SUBJECT_CHARS)
      return refuse("subject", `Keep the subject to ${MAX_SUBJECT_CHARS} characters.`);
  }
  if (body === "") return refuse("body", "Write the customer's message.");
  if (body.length > MAX_BODY_CHARS)
    return refuse(
      "body",
      `Keep the message to ${MAX_BODY_CHARS.toLocaleString("en-US")} characters.`,
    );
  if (form.photos.length > MAX_PHOTOS) return refuse("photos", `Add up to ${MAX_PHOTOS} photos.`);
  for (const photo of form.photos) {
    const problem = checkPhoto({ ...photo, size: Math.max(photo.size, photo.bytes.byteLength) });
    if (problem !== null) return refuse("photos", problem);
  }

  const request: MessageRequest = {
    channel: form.channel,
    ...(senderEmail === "" ? {} : { sender_email: senderEmail }),
    ...(senderPhone === "" ? {} : { sender_phone: senderPhone }),
    ...(form.channel === "email" ? { subject } : {}),
    body,
    attachments: form.photos.map((photo) => ({
      content_type: photo.type as MessageRequest["attachments"][number]["content_type"],
      data: toBase64(photo.bytes),
    })),
    mode,
  };
  const checked = MessageRequestSchema.safeParse(request);
  return checked.success
    ? { ok: true, request: checked.data }
    : refuse("body", "The message isn't valid. Check its fields and photos.");
}

export type SendResult = { ok: true; threadId: string } | { ok: false; message: string };

/** Posts the message through the console's route; Resolve's 400 sentence comes back as is. */
export async function sendMessage(
  request: MessageRequest,
  deps: { fetch?: typeof fetch } = {},
): Promise<SendResult> {
  let response: Response;
  try {
    response = await (deps.fetch ?? fetch)(MESSAGES_PATH, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(request),
    });
  } catch {
    return { ok: false, message: RESOLVE_UNREACHABLE };
  }
  let answer: unknown;
  try {
    answer = await response.json();
  } catch {
    return { ok: false, message: RESOLVE_UNREACHABLE };
  }
  if (response.status === 202) {
    const accepted = MessageAcceptedSchema.safeParse(answer);
    if (accepted.success) return { ok: true, threadId: accepted.data.thread_id };
  } else if (response.status === 400 || response.status === 502) {
    const refusal = ResolveMessageSchema.safeParse(answer);
    if (refusal.success) return { ok: false, message: refusal.data.message };
  }
  return { ok: false, message: RESOLVE_UNREACHABLE };
}
