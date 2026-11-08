import { z } from "zod";
import {
  APPROVAL_ROUTE_MESSAGES,
  APPROVER_COOKIE_MAX_AGE,
  isHttps,
  type Refusal,
  refuse,
} from "./approval-routes";

// Per-session limits (brief §8, ADR 0044). Signing in, by key or by pairing, also sets a random
// session cookie; each session may start a few runs, attacks and resets in any ten minutes, and
// Resolve's daily run cap (ADR 0030) still bounds every run behind them. The counts live
// in this process's memory, on the console's one instance. `approval-routes.ts` imports this file
// and this file imports it back, so imported values are only read inside functions. Web Crypto
// only, as `approval-routes.ts` stays plain Web APIs.

export const SESSION_COOKIE = "countersign_session";
// `attack` is "Attack it yourself"'s own count, kept apart from the launcher's and inbox's runs.
// `analyst` is the Risk desk analyst's Gemini questions.
export const SESSION_LIMITS = { run: 12, reset: 3, attack: 6, analyst: 10 } as const;
export const SESSION_WINDOW_MS = 600_000;
export const MAX_SESSIONS = 5_000;

export type SessionLimitKind = keyof typeof SESSION_LIMITS;

export const SESSION_LIMIT_MESSAGES = {
  run: "This session has started a lot of runs. Try again in a few minutes.",
  reset: "This session has reset the demo a lot. Try again in a few minutes.",
  attack: "This session has sent a lot of attacks. Try again in a few minutes.",
  analyst: "This session has asked the analyst a lot. Try again in a few minutes.",
} as const satisfies Record<SessionLimitKind, string>;

const SessionIdSchema = z.string().regex(/^[A-Za-z0-9_-]{22}$/);

type Times = Record<SessionLimitKind, number[]>;
const sessions = new Map<string, Times>();

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function sessionCookie(request: Request, value: string, maxAge: number): string {
  const parts = [
    `${SESSION_COOKIE}=${value}`,
    "HttpOnly",
    "SameSite=Strict",
    "Path=/",
    `Max-Age=${maxAge}`,
  ];
  if (isHttps(request)) parts.push("Secure");
  return parts.join("; ");
}

/** A `Set-Cookie` value for a new session: 16 random bytes, base64url. */
export function newSessionCookie(request: Request): string {
  const id = base64url(crypto.getRandomValues(new Uint8Array(16)));
  return sessionCookie(request, id, APPROVER_COOKIE_MAX_AGE);
}

/** A `Set-Cookie` value that clears the session cookie. */
export function clearSessionCookie(request: Request): string {
  return sessionCookie(request, "", 0);
}

/** The session ID from a request's cookies, or null when it's missing or malformed. */
export function sessionIdFrom(request: Request): string | null {
  for (const part of (request.headers.get("cookie") ?? "").split(";")) {
    const at = part.indexOf("=");
    if (at === -1 || part.slice(0, at).trim() !== SESSION_COOKIE) continue;
    const id = SessionIdSchema.safeParse(part.slice(at + 1).trim());
    return id.success ? id.data : null;
  }
  return null;
}

function prune(now: number): void {
  for (const [id, times] of sessions) {
    for (const kind of Object.keys(SESSION_LIMITS) as SessionLimitKind[]) {
      times[kind] = times[kind].filter((at) => now - at < SESSION_WINDOW_MS);
    }
    if (Object.values(times).every((list) => list.length === 0)) sessions.delete(id);
  }
}

/**
 * Counts one run or reset against the request's session. Null when it's allowed (and recorded);
 * a 401 "Sign in again." with no session cookie; a 429 past the limit. A refusal spends nothing.
 * Call it after the key cookie and the gate's key check, so a stranger never spends a slot.
 */
export function limitSession(
  request: Request,
  kind: SessionLimitKind,
  now: number = Date.now(),
): Refusal | null {
  const id = sessionIdFrom(request);
  if (id === null) return refuse(401, APPROVAL_ROUTE_MESSAGES.signInAgain);
  prune(now);
  const times = sessions.get(id) ?? { run: [], reset: [], attack: [], analyst: [] };
  if (times[kind].length >= SESSION_LIMITS[kind]) {
    return refuse(429, SESSION_LIMIT_MESSAGES[kind]);
  }
  if (!sessions.has(id)) {
    if (sessions.size >= MAX_SESSIONS) {
      const oldest = sessions.keys().next();
      if (oldest.done !== true) sessions.delete(oldest.value);
    }
    sessions.set(id, times);
  }
  times[kind].push(now);
  return null;
}

/** Forgets every session's counts, for tests. */
export function resetSessionLimits(): void {
  sessions.clear();
}
