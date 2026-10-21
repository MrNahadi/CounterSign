import type { z } from "zod";
import {
  AttachmentIdSchema,
  PHOTO_TYPES,
  ResolveMessageSchema,
  type ThreadDetail,
  ThreadDetailSchema,
  ThreadIdSchema,
  type ThreadList,
  ThreadListSchema,
} from "./resolve-schemas";

// The console's way to Resolve (ADR 0030): server code only, at `RESOLVE_AGENT_URL`. Every
// request is checked before it leaves and every answer is parsed before it's passed on. When
// Resolve can't be reached or answers something unreadable, the answer is one sentence and 502.

export const DEFAULT_RESOLVE_AGENT_URL = "http://127.0.0.1:8788";
export const RESOLVE_UNREACHABLE = "Resolve isn't reachable. Start it, then try again.";
export const NO_THREAD = "There's no thread with that ID.";
export const NO_PHOTO = "There's no photo with that ID.";
export const REQUEST_TIMEOUT_MS = 10_000;
export const MAX_PHOTO_BYTES = 2 * 1024 * 1024;

export type ResolveEnv = Readonly<Record<string, string | undefined>>;

export type ResolveDeps = {
  env: ResolveEnv;
  fetch?: typeof fetch;
  timeoutMs?: number;
};

export type Answer<T> =
  | { ok: true; value: T }
  | { ok: false; status: 400 | 404 | 502; message: string };

const unreachable = { ok: false, status: 502, message: RESOLVE_UNREACHABLE } as const;

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

async function call(deps: ResolveDeps, path: string): Promise<Response | null> {
  const base = resolveAgentUrl(deps.env);
  if (base === null) return null;
  const url = new URL(path, base);
  try {
    return await (deps.fetch ?? fetch)(url, {
      method: "GET",
      headers: { accept: "application/json" },
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(deps.timeoutMs ?? REQUEST_TIMEOUT_MS),
    });
  } catch {
    return null;
  }
}

async function readJson<T>(response: Response, schema: z.ZodType<T>): Promise<T | null> {
  try {
    const parsed = schema.safeParse(await response.json());
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export async function loadThreads(deps: ResolveDeps): Promise<Answer<ThreadList>> {
  const response = await call(deps, "/threads");
  if (response?.status !== 200) return unreachable;
  const list = await readJson(response, ThreadListSchema);
  return list === null ? unreachable : { ok: true, value: list };
}

export async function loadThread(id: unknown, deps: ResolveDeps): Promise<Answer<ThreadDetail>> {
  const threadId = ThreadIdSchema.safeParse(id);
  if (!threadId.success) return { ok: false, status: 404, message: NO_THREAD };
  const response = await call(deps, `/threads/${threadId.data}`);
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

function respond<T>(answer: Answer<T>): Response {
  return answer.ok ? json(200, answer.value) : json(answer.status, { message: answer.message });
}

/** `GET /api/resolve/threads`. */
export async function threadsRoute(deps: ResolveDeps): Promise<Response> {
  return respond(await loadThreads(deps));
}

/** `GET /api/resolve/threads/[id]`. */
export async function threadRoute(id: unknown, deps: ResolveDeps): Promise<Response> {
  return respond(await loadThread(id, deps));
}

/** `GET /api/resolve/attachments/[id]`: the photo's bytes, only when they're a photo we accept. */
export async function attachmentRoute(id: unknown, deps: ResolveDeps): Promise<Response> {
  const attachmentId = AttachmentIdSchema.safeParse(id);
  if (!attachmentId.success) return json(404, { message: NO_PHOTO });
  const response = await call(deps, `/attachments/${attachmentId.data}`);
  if (response?.status === 404 && (await readJson(response, ResolveMessageSchema)) !== null) {
    return json(404, { message: NO_PHOTO });
  }
  if (response?.status !== 200) return json(502, { message: RESOLVE_UNREACHABLE });
  const type = (response.headers.get("content-type") ?? "").split(";")[0]?.trim() ?? "";
  if (!(PHOTO_TYPES as readonly string[]).includes(type)) {
    return json(502, { message: RESOLVE_UNREACHABLE });
  }
  let bytes: ArrayBuffer;
  try {
    bytes = await response.arrayBuffer();
  } catch {
    return json(502, { message: RESOLVE_UNREACHABLE });
  }
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_PHOTO_BYTES) {
    return json(502, { message: RESOLVE_UNREACHABLE });
  }
  return new Response(bytes, {
    status: 200,
    headers: {
      "Content-Type": type,
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "private, max-age=31536000, immutable",
    },
  });
}
