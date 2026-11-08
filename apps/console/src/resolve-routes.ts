import type { z } from "zod";
import {
  type Answer,
  type ApprovalDeps,
  checkKey,
  refusalResponse,
  refuse,
  withSignIn,
} from "./approval-routes";
import {
  AttachmentIdSchema,
  type MessageAccepted,
  MessageAcceptedSchema,
  MessageRequestSchema,
  PHOTO_TYPES,
  ResolveMessageSchema,
  type ThreadDetail,
  ThreadDetailSchema,
  ThreadIdSchema,
  type ThreadList,
  ThreadListSchema,
} from "./resolve-schemas";
import { limitSession } from "./session-limits";

// The console's way to Resolve (ADR 0030): server code only, at `RESOLVE_AGENT_URL`. Every
// request is checked before it leaves and every answer is parsed before it's passed on. When
// Resolve can't be reached or answers something unreadable, the answer is one sentence and 502.

export const DEFAULT_RESOLVE_AGENT_URL = "http://127.0.0.1:8788";
export const RESOLVE_UNREACHABLE = "Resolve isn't reachable. Start it, then try again.";
export const NO_THREAD = "There's no thread with that ID.";
export const NO_PHOTO = "There's no photo with that ID.";
export const REQUEST_TIMEOUT_MS = 10_000;
export const MAX_PHOTO_BYTES = 2 * 1024 * 1024;
export const MAX_MESSAGE_BYTES = 10 * 1024 * 1024;
export const BAD_MESSAGE =
  "The message isn't valid. Check its fields and photos, then send it again.";
export const MESSAGE_TOO_LARGE = "The message is larger than 10 MB.";

export type ResolveEnv = Readonly<Record<string, string | undefined>>;

export type ResolveDeps = {
  env: ResolveEnv;
  fetch?: typeof fetch;
  timeoutMs?: number;
};

// A route to Resolve opens with the approvals sign-in, checked with the gate (ADR 0043), so its
// deps carry what both calls need. The key goes to the gate only.
export type RouteDeps = ResolveDeps & ApprovalDeps;

const unreachable = refuse(502, RESOLVE_UNREACHABLE);

export const INBOX_SIGN_IN = {
  title: "Inbox",
  line: "Sign in with the approver key to see the inbox.",
} as const;

export type InboxAccess =
  | { state: "open" }
  | { state: "signed-out"; message: string | null }
  | { state: "unreachable"; message: string };

/**
 * Whether the inbox page may read Resolve: the cookie's key, taken by the gate (ADR 0043). No key
 * shows the sign-in plain, a gate 401 shows it with "Sign in again.", anything else is unreachable.
 */
export async function inboxAccess(key: string | null, deps: ApprovalDeps): Promise<InboxAccess> {
  if (key === null) return { state: "signed-out", message: null };
  const checked = await checkKey(key, deps);
  if (checked.ok) return { state: "open" };
  return checked.status === 401
    ? { state: "signed-out", message: checked.message }
    : { state: "unreachable", message: checked.message };
}

/** Resolve's base URL, or null when `RESOLVE_AGENT_URL` isn't an http(s) URL. */
export function resolveAgentUrl(env: ResolveEnv): URL | null {
  const raw = env.RESOLVE_AGENT_URL?.trim() || DEFAULT_RESOLVE_AGENT_URL;
  try {
    const url = new URL(raw);
    return url.protocol === "http:" || url.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

export async function callResolve(
  deps: ResolveDeps,
  path: string,
  post?: { json: string },
): Promise<Response | null> {
  const base = resolveAgentUrl(deps.env);
  if (base === null) return null;
  const url = new URL(path, base);
  try {
    return await (deps.fetch ?? fetch)(url, {
      method: post === undefined ? "GET" : "POST",
      headers:
        post === undefined
          ? { accept: "application/json" }
          : { accept: "application/json", "content-type": "application/json" },
      ...(post === undefined ? {} : { body: post.json }),
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(deps.timeoutMs ?? REQUEST_TIMEOUT_MS),
    });
  } catch {
    return null;
  }
}

export async function readJson<T>(response: Response, schema: z.ZodType<T>): Promise<T | null> {
  try {
    const parsed = schema.safeParse(await response.json());
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export async function loadThreads(deps: ResolveDeps): Promise<Answer<ThreadList>> {
  const response = await callResolve(deps, "/threads");
  if (response?.status !== 200) return unreachable;
  const list = await readJson(response, ThreadListSchema);
  return list === null ? unreachable : { ok: true, value: list };
}

export async function loadThread(id: unknown, deps: ResolveDeps): Promise<Answer<ThreadDetail>> {
  const threadId = ThreadIdSchema.safeParse(id);
  if (!threadId.success) return { ok: false, status: 404, message: NO_THREAD };
  const response = await callResolve(deps, `/threads/${threadId.data}`);
  if (response?.status === 404 && (await readJson(response, ResolveMessageSchema)) !== null) {
    return { ok: false, status: 404, message: NO_THREAD };
  }
  if (response?.status !== 200) return unreachable;
  const thread = await readJson(response, ThreadDetailSchema);
  if (thread === null || thread.thread_id !== threadId.data) return unreachable;
  return { ok: true, value: thread };
}

const json = (status: number, body: unknown): Response =>
  Response.json(body, { status, headers: { "Cache-Control": "no-store" } });

/** `GET /api/resolve/threads`. */
export function threadsRoute(request: Request, deps: RouteDeps): Promise<Response> | Response {
  return withSignIn(request, deps, () => loadThreads(deps));
}

/** `GET /api/resolve/threads/[id]`. */
export function threadRoute(
  request: Request,
  id: unknown,
  deps: RouteDeps,
): Promise<Response> | Response {
  return withSignIn(request, deps, () => loadThread(id, deps));
}

async function loadAttachment(id: unknown, deps: ResolveDeps): Promise<Answer<Response>> {
  const attachmentId = AttachmentIdSchema.safeParse(id);
  if (!attachmentId.success) return refuse(404, NO_PHOTO);
  const response = await callResolve(deps, `/attachments/${attachmentId.data}`);
  if (response?.status === 404 && (await readJson(response, ResolveMessageSchema)) !== null) {
    return refuse(404, NO_PHOTO);
  }
  if (response?.status !== 200) return unreachable;
  const type = (response.headers.get("content-type") ?? "").split(";")[0]?.trim() ?? "";
  if (!(PHOTO_TYPES as readonly string[]).includes(type)) return unreachable;
  let bytes: ArrayBuffer;
  try {
    bytes = await response.arrayBuffer();
  } catch {
    return unreachable;
  }
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_PHOTO_BYTES) return unreachable;
  return {
    ok: true,
    value: new Response(bytes, {
      status: 200,
      headers: {
        "Content-Type": type,
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "private, max-age=31536000, immutable",
      },
    }),
  };
}

/** `GET /api/resolve/attachments/[id]`: the photo's bytes, only when they're a photo we accept. */
export function attachmentRoute(
  request: Request,
  id: unknown,
  deps: RouteDeps,
): Promise<Response> | Response {
  return withSignIn(
    request,
    deps,
    () => loadAttachment(id, deps),
    (req, answer) => (answer.ok ? answer.value : refusalResponse(req, answer)),
  );
}

/** Reads at most `limit` bytes of a request body as text; null when it's longer. */
export async function readLimited(request: Request, limit: number): Promise<string | null> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limit) return null;
  if (request.body === null) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

/**
 * Sends one checked message to Resolve's `POST /messages`. `origin: "visitor"` marks an "Attack
 * it yourself" message so the visitor counter can find it; only the attack route sets it, never
 * the request body.
 */
export async function sendToResolve(
  input: unknown,
  deps: ResolveDeps,
  origin?: "visitor",
): Promise<Answer<MessageAccepted>> {
  const message = MessageRequestSchema.safeParse(input);
  if (!message.success) return { ok: false, status: 400, message: BAD_MESSAGE };
  const body = origin === undefined ? message.data : { ...message.data, origin };
  const response = await callResolve(deps, "/messages", { json: JSON.stringify(body) });
  if (response?.status === 400) {
    const refusal = await readJson(response, ResolveMessageSchema);
    return refusal === null ? unreachable : { ok: false, status: 400, message: refusal.message };
  }
  if (response?.status !== 202) return unreachable;
  const accepted = await readJson(response, MessageAcceptedSchema);
  return accepted === null ? unreachable : { ok: true, value: accepted };
}

/** `POST /api/resolve/messages`: one simulated customer message, checked, then sent to Resolve. */
export function messagesRoute(request: Request, deps: RouteDeps): Promise<Response> | Response {
  return withSignIn(
    request,
    deps,
    async () => {
      // A run is counted against the session after the key is checked, before the body is read.
      const limited = limitSession(request, "run");
      if (limited !== null) return limited;
      let text: string | null;
      try {
        text = await readLimited(request, MAX_MESSAGE_BYTES);
      } catch {
        return refuse(400, BAD_MESSAGE);
      }
      if (text === null) return refuse(400, MESSAGE_TOO_LARGE);
      let input: unknown;
      try {
        input = JSON.parse(text);
      } catch {
        return refuse(400, BAD_MESSAGE);
      }
      return sendToResolve(input, deps);
    },
    (req, answer) => (answer.ok ? json(202, answer.value) : refusalResponse(req, answer)),
  );
}
