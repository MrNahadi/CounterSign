import { createHash, timingSafeEqual } from "node:crypto";
import type { Environment } from "@countersign/db";
import type { RequestHandler } from "express";

// Resolve is a public web service on Render's free plan (PLAN.md F2), so every route but
// `/health` needs the shared secret in one header. The gate and the console send it from their
// own `RESOLVE_SHARED_SECRET`. Fail closed: without a usable secret of its own, Resolve takes no
// one's. The comparison hashes both sides first, so it takes the same time whatever their
// lengths. The secret is never logged or echoed.

export const SHARED_SECRET_HEADER = "x-countersign-resolve-secret";
export const MIN_SHARED_SECRET_LENGTH = 32;
export const SHARED_SECRET_REFUSAL = "Resolve takes calls from the gate and the console only.";

/** `RESOLVE_SHARED_SECRET`, trimmed, or null when unset or shorter than 32 characters. */
export function parseSharedSecret(env: Environment): string | null {
  const raw = env.RESOLVE_SHARED_SECRET?.trim() ?? "";
  return raw.length >= MIN_SHARED_SECRET_LENGTH ? raw : null;
}

const digest = (value: string) => createHash("sha256").update(value, "utf8").digest();

/** Whether the presented header value is the secret. Always false when Resolve has none. */
export function secretMatches(secret: string | null, presented: unknown): boolean {
  if (secret === null || typeof presented !== "string" || presented === "") return false;
  return timingSafeEqual(digest(secret), digest(presented));
}

/** Answers 401 before any body is read unless the request carries the secret. */
export function requireSharedSecret(secret: string | null): RequestHandler {
  return (req, res, next) => {
    if (secretMatches(secret, req.get(SHARED_SECRET_HEADER))) next();
    else res.status(401).json({ message: SHARED_SECRET_REFUSAL });
  };
}
