import type { z } from "zod";
import {
  AnswerRequestSchema,
  type AnswerResult,
  AnswerResultSchema,
  type ApprovalsView,
  ApprovalsViewSchema,
  ApproverKeySchema,
  type Card,
  CardSchema,
  GateMessageSchema,
  SignInRequestSchema,
  StepUpIdSchema,
} from "./approval-schemas";

// The console's way to the gate's approval API (ADR 0032): server code only, at `GATE_URL`. The
// approver types the key once; it lives in an HttpOnly, SameSite=Strict cookie and is sent to the
// gate as the bearer, never to the browser's JavaScript, never in an answer and never in a log.
// Every request is checked before it leaves and every answer is parsed before it's passed on.
// Plain Web APIs only, so a client component can import the sentences.

export const DEFAULT_GATE_URL = "http://127.0.0.1:8787";
export const APPROVER_COOKIE = "countersign_approver";
export const APPROVER_COOKIE_MAX_AGE = 12 * 60 * 60;
export const REQUEST_TIMEOUT_MS = 10_000;
export const MAX_BODY_BYTES = 16 * 1024;

export const APPROVAL_ROUTE_MESSAGES = {
  wrongKey: "That key isn't right.",
  signInAgain: "Sign in again.",
  signedOut: "Sign in with the approver key.",
  unreachable: "The gate isn't reachable. Start it, then try again.",
  badSignIn: "Send JSON with the approver key.",
  badAnswer: "Send JSON with answer (approve or deny) and intent_hash.",
  noStepUp: "There's no step-up with that ID.",
} as const;

export type ApprovalEnv = Readonly<Record<string, string | undefined>>;

export type ApprovalDeps = {
  env: ApprovalEnv;
  fetch?: typeof fetch;
  timeoutMs?: number;
};

type Refusal = { ok: false; status: 400 | 401 | 404 | 502 | 503; message: string };
export type Answer<T> = { ok: true; value: T } | Refusal;

const refuse = (status: Refusal["status"], message: string): Refusal => ({
  ok: false,
  status,
  message,
});
const unreachable = refuse(502, APPROVAL_ROUTE_MESSAGES.unreachable);
const signInAgain = refuse(401, APPROVAL_ROUTE_MESSAGES.signInAgain);

/** The gate's base URL, or null when `GATE_URL` isn't an http(s) URL. */
export function gateUrl(env: ApprovalEnv): URL | null {
  const raw = env.GATE_URL?.trim() || DEFAULT_GATE_URL;
  try {
    const url = new URL(raw);
    return url.protocol === "http:" || url.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

// --- The cookie ----------------------------------------------------------------------------

/** The approver key from a request's cookies, or null when it's missing or malformed. */
export function approverKeyFrom(request: Request): string | null {
  return approverKeyFromHeader(request.headers.get("cookie"));
}

/** The approver key from a `Cookie` header, for server components that read headers directly. */
export function approverKeyFromHeader(header: string | null): string | null {
  if (header === null) return null;
  for (const part of header.split(";")) {
    const at = part.indexOf("=");
    if (at === -1 || part.slice(0, at).trim() !== APPROVER_COOKIE) continue;
    let value: string;
    try {
      value = decodeURIComponent(part.slice(at + 1).trim());
    } catch {
      return null;
    }
    const key = ApproverKeySchema.safeParse(value);
    return key.success ? key.data : null;
  }
  return null;
}

/** Whether the request came over HTTPS, directly or through the host's proxy. */
export function isHttps(request: Request): boolean {
  const forwarded = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim().toLowerCase();
  if (forwarded === "https") return true;
  try {
    return new URL(request.url).protocol === "https:";
  } catch {
    return false;
  }
}

function cookie(request: Request, value: string, maxAge: number): string {
  const parts = [
    `${APPROVER_COOKIE}=${value}`,
    "HttpOnly",
    "SameSite=Strict",
    "Path=/",
    `Max-Age=${maxAge}`,
  ];
  if (isHttps(request)) parts.push("Secure");
  return parts.join("; ");
}

const setCookie = (request: Request, key: string) =>
  cookie(request, encodeURIComponent(key), APPROVER_COOKIE_MAX_AGE);
const clearCookie = (request: Request) => cookie(request, "", 0);

// --- Calling the gate ----------------------------------------------------------------------

async function call(
  deps: ApprovalDeps,
  key: string,
  path: string,
  post?: { json: string },
): Promise<Response | null> {
  const base = gateUrl(deps.env);
  if (base === null) return null;
  const headers: Record<string, string> = {
    accept: "application/json",
    authorization: `Bearer ${key}`,
  };
  if (post !== undefined) headers["content-type"] = "application/json";
  try {
    return await (deps.fetch ?? fetch)(new URL(path, base), {
      method: post === undefined ? "GET" : "POST",
      headers,
      ...(post === undefined ? {} : { body: post.json }),
      cache: "no-store",
      // Never follow a redirect: the bearer would go with it.
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

// A gate answer other than success: 401 means sign in again; a 400, 404 or 503 that carries the
// gate's one sentence is passed on; anything else is junk.
async function refusalOf(response: Response | null, notFound?: string): Promise<Refusal> {
  if (response === null) return unreachable;
  if (response.status === 401) return signInAgain;
  if (response.status === 400 || response.status === 404 || response.status === 503) {
    const message = await readJson(response, GateMessageSchema);
    if (message === null) return unreachable;
    if (response.status === 404) return refuse(404, notFound ?? message.message);
    return refuse(response.status, message.message);
  }
  return unreachable;
}

export async function loadApprovals(
  key: string,
  deps: ApprovalDeps,
): Promise<Answer<ApprovalsView>> {
  const response = await call(deps, key, "/approvals");
  if (response?.status !== 200) return refusalOf(response);
  const view = await readJson(response, ApprovalsViewSchema);
  return view === null ? unreachable : { ok: true, value: view };
}

export async function loadApproval(
  key: string,
  id: unknown,
  deps: ApprovalDeps,
): Promise<Answer<Card>> {
  const stepUpId = StepUpIdSchema.safeParse(id);
  if (!stepUpId.success) return refuse(404, APPROVAL_ROUTE_MESSAGES.noStepUp);
  const response = await call(deps, key, `/approvals/${stepUpId.data}`);
  if (response?.status !== 200) return refusalOf(response, APPROVAL_ROUTE_MESSAGES.noStepUp);
  const card = await readJson(response, CardSchema);
  if (card === null || String(card.step_up_id) !== stepUpId.data) return unreachable;
  return { ok: true, value: card };
}

export async function sendAnswer(
  key: string,
  id: unknown,
  input: unknown,
  deps: ApprovalDeps,
): Promise<Answer<AnswerResult>> {
  const stepUpId = StepUpIdSchema.safeParse(id);
  if (!stepUpId.success) return refuse(404, APPROVAL_ROUTE_MESSAGES.noStepUp);
  const body = AnswerRequestSchema.safeParse(input);
  if (!body.success) return refuse(400, APPROVAL_ROUTE_MESSAGES.badAnswer);
  const response = await call(deps, key, `/approvals/${stepUpId.data}`, {
    json: JSON.stringify(body.data),
  });
  if (response?.status !== 200) return refusalOf(response, APPROVAL_ROUTE_MESSAGES.noStepUp);
  const result = await readJson(response, AnswerResultSchema);
  if (result === null || String(result.step_up_id) !== stepUpId.data) return unreachable;
  return { ok: true, value: result };
}

// --- Route handlers ------------------------------------------------------------------------

function json(status: number, body: unknown, setCookieHeader?: string): Response {
  const headers = new Headers({ "Cache-Control": "no-store" });
  if (setCookieHeader !== undefined) headers.set("Set-Cookie", setCookieHeader);
  return Response.json(body, { status, headers });
}

// A refusal as an answer; a 401 also clears the cookie.
function respond<T>(request: Request, answer: Answer<T>): Response {
  if (answer.ok) return json(200, answer.value);
  return json(
    answer.status,
    { message: answer.message },
    answer.status === 401 ? clearCookie(request) : undefined,
  );
}

function withKey(
  request: Request,
  run: (key: string) => Promise<Answer<unknown>>,
): Promise<Response> | Response {
  const key = approverKeyFrom(request);
  if (key !== null) return run(key).then((answer) => respond(request, answer));
  const hasCookie = (request.headers.get("cookie") ?? "").includes(`${APPROVER_COOKIE}=`);
  return json(
    401,
    {
      message: hasCookie ? APPROVAL_ROUTE_MESSAGES.signInAgain : APPROVAL_ROUTE_MESSAGES.signedOut,
    },
    hasCookie ? clearCookie(request) : undefined,
  );
}

/** Reads at most `limit` bytes of a request body as text; null when it's longer. */
async function readLimited(request: Request, limit: number): Promise<string | null> {
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

// The request body as JSON, or undefined when it's too large or not JSON.
async function readBody(request: Request): Promise<unknown> {
  try {
    const text = await readLimited(request, MAX_BODY_BYTES);
    return text === null ? undefined : JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** `POST /api/approvals/session`: checks the key with the gate, then keeps it in the cookie. */
export async function signInRoute(request: Request, deps: ApprovalDeps): Promise<Response> {
  const body = SignInRequestSchema.safeParse(await readBody(request));
  if (!body.success) return json(400, { message: APPROVAL_ROUTE_MESSAGES.badSignIn });
  const key = ApproverKeySchema.safeParse(body.data.key);
  if (!key.success) return json(401, { message: APPROVAL_ROUTE_MESSAGES.wrongKey });
  const response = await call(deps, key.data, "/approvals");
  if (response?.status === 401) return json(401, { message: APPROVAL_ROUTE_MESSAGES.wrongKey });
  // The gate checks the key before it reads the log, so a 503 sentence still means it was right.
  const accepted =
    (response?.status === 200 && (await readJson(response, ApprovalsViewSchema)) !== null) ||
    (response?.status === 503 && (await readJson(response, GateMessageSchema)) !== null);
  if (!accepted) return json(502, { message: APPROVAL_ROUTE_MESSAGES.unreachable });
  return json(200, { signed_in: true }, setCookie(request, key.data));
}

/** `DELETE /api/approvals/session`: signs out. */
export function signOutRoute(request: Request): Response {
  return json(200, { signed_in: false }, clearCookie(request));
}

/** `GET /api/approvals`: the open cards and recent answers. */
export function approvalsRoute(request: Request, deps: ApprovalDeps): Promise<Response> | Response {
  return withKey(request, (key) => loadApprovals(key, deps));
}

/** `GET /api/approvals/[id]`: one card. */
export function approvalRoute(
  request: Request,
  id: unknown,
  deps: ApprovalDeps,
): Promise<Response> | Response {
  return withKey(request, (key) => loadApproval(key, id, deps));
}

/** `POST /api/approvals/[id]`: approves or denies one card, by the hash it showed. */
export function answerRoute(
  request: Request,
  id: unknown,
  deps: ApprovalDeps,
): Promise<Response> | Response {
  return withKey(request, async (key) => sendAnswer(key, id, await readBody(request), deps));
}
