import { z } from "zod";
import { type ComposerPhoto, messageRequest } from "./composer";
import { RESOLVE_UNREACHABLE } from "./resolve-routes";
import {
  type MessageRequest,
  MessageRequestSchema,
  type Mode,
  type Run,
  type ThreadDetail,
  ThreadDetailSchema,
  ThreadIdSchema,
} from "./resolve-schemas";

// The customer's side of a simulated chat (`/chat`, ADR 0030): the customer gives an email
// address once, then sends messages with an optional photo and reads Resolve's replies. It
// shows messages and replies only, never the trace, tool calls or decisions. Browser-safe.

export const CHAT_NOTICE = "Simulated chat. Kikapu Studio is an illustrative shop.";
export const CHAT_UNANSWERED = "Resolve couldn't answer this one. The shop will reply soon.";
export const CHAT_WORKING = "Resolve is writing a reply";
export const CHAT_GONE = "This chat has ended. Start a new one.";
export const CHAT_POLL_MS = 2_000;
export const CHAT_STORAGE_KEY = "countersign-resolve-chat";
const THREADS_PATH = "/api/resolve/threads";
const ATTACHMENTS_PATH = "/api/resolve/attachments";

// The chat's touch controls (DESIGN.md: hit targets of 24px or more, 40px for the primary action
// on touch layouts). Sizes live here so a test can hold them to that.
const FOCUS =
  "focus-visible:outline focus-visible:outline-1 focus-visible:outline-brand-border-focus";
export const CHAT_CONTROLS = {
  send: `flex size-10 shrink-0 items-center justify-center rounded-xl bg-inverted-solid text-on-inverted-foreground hover:bg-inverted-solid-hover disabled:cursor-not-allowed disabled:bg-disabled disabled:text-disabled-foreground motion-safe:transition motion-safe:duration-200 motion-safe:ease-out motion-safe:active:scale-[0.97] focus-visible:outline-offset-2 ${FOCUS}`,
  attach: `flex size-10 shrink-0 items-center justify-center rounded-xl text-secondary-foreground hover:bg-transparent-hover hover:text-primary-foreground disabled:cursor-not-allowed disabled:text-disabled-foreground ${FOCUS}`,
  message: `h-10 min-w-0 flex-1 rounded-lg bg-component-on-container-strong px-2.5 text-body-sm text-primary-foreground shadow-default placeholder:text-tertiary-foreground focus-visible:outline-offset-[-1px] aria-invalid:inset-ring aria-invalid:inset-ring-danger-border-default ${FOCUS}`,
  email: `h-10 w-full rounded-lg bg-component-on-container-strong px-2.5 text-body-sm text-primary-foreground shadow-default placeholder:text-tertiary-foreground focus-visible:outline-offset-[-1px] aria-invalid:inset-ring aria-invalid:inset-ring-danger-border-default ${FOCUS}`,
  start: `inline-flex h-10 items-center justify-center gap-2 rounded-lg bg-inverted-solid px-3.5 text-body-sm font-medium text-on-inverted-foreground hover:bg-inverted-solid-hover motion-safe:transition motion-safe:duration-200 motion-safe:ease-out motion-safe:active:scale-[0.97] focus-visible:outline-offset-2 ${FOCUS}`,
  removePhoto: `flex size-6 shrink-0 items-center justify-center rounded-md text-secondary-foreground hover:bg-transparent-hover hover:text-primary-foreground ${FOCUS}`,
  startOver: `inline-flex h-6 shrink-0 items-center rounded-md px-1.5 text-caption-lg font-medium text-secondary-foreground hover:bg-transparent-hover hover:text-primary-foreground ${FOCUS}`,
} as const;

export type ChatForm = {
  email: string;
  body: string;
  photo: ComposerPhoto | null;
  threadId: string | null;
};

export type ChatField = "email" | "body" | "photo";

export type ChatMessage =
  | { ok: true; request: MessageRequest }
  | { ok: false; field: ChatField; problem: string };

/** Why the address can't start a chat, in one sentence; null when it can. */
export function emailProblem(email: string): string | null {
  const trimmed = email.trim();
  if (trimmed === "") return "Add your email address.";
  return z.email().max(254).safeParse(trimmed).success
    ? null
    : "Use an email address like name@example.com.";
}

/** The chat's form as Resolve's `POST /messages` body: a new thread, or a follow-up in one. */
export function chatRequest(form: ChatForm, mode: Mode): ChatMessage {
  const problem = emailProblem(form.email);
  if (problem !== null) return { ok: false, field: "email", problem };
  if (form.body.trim() === "") return { ok: false, field: "body", problem: "Write a message." };
  const composed = messageRequest(
    {
      channel: "chat",
      senderEmail: form.email,
      senderPhone: "",
      subject: "",
      body: form.body,
      photos: form.photo === null ? [] : [form.photo],
    },
    mode,
  );
  if (!composed.ok) {
    const field: ChatField =
      composed.field === "photos" ? "photo" : composed.field === "body" ? "body" : "email";
    return { ok: false, field, problem: composed.problem };
  }
  if (form.threadId === null) return composed;
  const followUp = MessageRequestSchema.safeParse({
    ...composed.request,
    thread_id: form.threadId,
  });
  return followUp.success
    ? { ok: true, request: followUp.data }
    : { ok: false, field: "body", problem: CHAT_GONE };
}

export type ChatEntry =
  | { kind: "customer"; key: string; body: string; photos: { id: string; src: string }[] }
  | { kind: "reply"; key: string; text: string }
  | { kind: "working"; key: string }
  | { kind: "unanswered"; key: string; text: string };

export type ChatView = {
  threadId: string;
  email: string | null;
  working: boolean;
  entries: ChatEntry[];
};

function answerOf(run: Run): ChatEntry {
  if (run.status === "queued" || run.status === "running")
    return { kind: "working", key: run.run_id };
  const text = run.reply?.trim() ?? "";
  if (run.status === "replied" && text !== "") return { kind: "reply", key: run.run_id, text };
  return { kind: "unanswered", key: run.run_id, text: CHAT_UNANSWERED };
}

/** What the customer sees of a thread: each message, then the latest run's answer. Null if it isn't a chat. */
export function chatView(thread: ThreadDetail): ChatView | null {
  if (thread.messages.some((message) => message.channel !== "chat")) return null;
  const entries: ChatEntry[] = [];
  for (const message of thread.messages) {
    entries.push({
      kind: "customer",
      key: message.ticket_id,
      body: message.body,
      photos: message.attachments.map((attachment) => ({
        id: attachment.id,
        src: `${ATTACHMENTS_PATH}/${attachment.id}`,
      })),
    });
    // A fallback rerun follows the run it replaces, so the last run of a message is its answer.
    const latest = thread.runs.filter((run) => run.ticket_id === message.ticket_id).at(-1);
    entries.push(
      latest === undefined
        ? { kind: "working", key: `${message.ticket_id}-working` }
        : answerOf(latest),
    );
  }
  return {
    threadId: thread.thread_id,
    email: thread.messages[0]?.sender_email ?? null,
    working: entries.some((entry) => entry.kind === "working"),
    entries,
  };
}

export type ChatLoad =
  | { ok: true; view: ChatView }
  | { ok: false; missing: boolean; message: string };

const unreachable: ChatLoad = { ok: false, missing: false, message: RESOLVE_UNREACHABLE };
const gone: ChatLoad = { ok: false, missing: true, message: CHAT_GONE };

/** Reads the chat's thread through the console's route. */
export async function loadChat(
  threadId: string,
  deps: { fetch?: typeof fetch } = {},
): Promise<ChatLoad> {
  if (!ThreadIdSchema.safeParse(threadId).success) return gone;
  let response: Response;
  try {
    response = await (deps.fetch ?? fetch)(`${THREADS_PATH}/${threadId}`, {
      headers: { accept: "application/json" },
      cache: "no-store",
    });
  } catch {
    return unreachable;
  }
  if (response.status === 404) return gone;
  if (response.status !== 200) return unreachable;
  let parsed: ReturnType<typeof ThreadDetailSchema.safeParse>;
  try {
    parsed = ThreadDetailSchema.safeParse(await response.json());
  } catch {
    return unreachable;
  }
  if (!parsed.success || parsed.data.thread_id !== threadId) return unreachable;
  const view = chatView(parsed.data);
  return view === null ? gone : { ok: true, view };
}

const StoredChatSchema = z.object({
  email: z.email().max(254),
  threadId: ThreadIdSchema.nullable(),
});
export type StoredChat = z.infer<typeof StoredChatSchema>;

/** The email and thread this browser chatted with last; null when there's none or it's junk. */
export function parseStoredChat(raw: string | null): StoredChat | null {
  if (raw === null || raw === "") return null;
  try {
    const parsed = StoredChatSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
