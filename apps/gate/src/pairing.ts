// Phone pairing (ADR 0044). An approver-key holder mints a single-use code; the phone's console
// trades it once, with no key, for the approver key, to set its own sign-in cookie. A code is 16
// random bytes, valid for 5 minutes, and held only as its SHA-256 in this process's memory, at
// most 50 at a time. Nothing logs a code or the key. No AI.

import { createHash, randomBytes } from "node:crypto";
import express, { type Express, type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import { APPROVALS_PATH, approverOnly } from "./approvals-api";
import type { Approver } from "./approver";

export const PAIRING_CODES_PATH = `${APPROVALS_PATH}/pairing-codes`;
export const PAIR_PATH = `${APPROVALS_PATH}/pair`;
export const PAIRING_TTL_MS = 300_000;
export const MAX_PAIRING_CODES = 50;
export const PAIR_BODY_LIMIT = "1kb";
const CODE_BYTES = 16;

export const PAIRING_MESSAGES = {
  refused: "That code has expired or was used. Sign in with the approver key.",
} as const;

const PairBody = z.strictObject({ code: z.string().regex(/^[A-Za-z0-9_-]{22}$/) });

export type PairingDeps = {
  approver: Approver;
  // The mint and trade time.
  clock: () => Date;
};

const hashCode = (code: string) => createHash("sha256").update(code, "utf8").digest("hex");

export function mountPairing(app: Express, deps: PairingDeps): void {
  const { approver, clock } = deps;
  // A code's SHA-256 hex to its expiry (ms). Insertion order is expiry order, as the TTL is fixed.
  const live = new Map<string, number>();

  const prune = (now: number) => {
    for (const [hash, expiry] of live) {
      if (expiry <= now) live.delete(hash);
    }
  };

  const refuse = (res: Response) => {
    res.status(401).set("Cache-Control", "no-store").json({ message: PAIRING_MESSAGES.refused });
  };

  // No body is read: the key check is the whole request.
  app.post(PAIRING_CODES_PATH, approverOnly(approver), (_req: Request, res: Response) => {
    const now = clock().getTime();
    prune(now);
    while (live.size >= MAX_PAIRING_CODES) {
      let soonest: [string, number] | null = null;
      for (const entry of live) {
        if (soonest === null || entry[1] < soonest[1]) soonest = entry;
      }
      if (soonest === null) break;
      live.delete(soonest[0]);
    }
    const code = randomBytes(CODE_BYTES).toString("base64url");
    const expiresAt = now + PAIRING_TTL_MS;
    live.set(hashCode(code), expiresAt);
    res
      .status(201)
      .set("Cache-Control", "no-store")
      .json({ code, expires_at: new Date(expiresAt).toISOString() });
  });

  // No key: the code is the credential. Every refusal looks the same.
  app.post(
    PAIR_PATH,
    express.json({ limit: PAIR_BODY_LIMIT, strict: true }),
    (req: Request, res: Response) => {
      const now = clock().getTime();
      prune(now);
      const body = PairBody.safeParse(req.body);
      const key = approver.value();
      if (!body.success || key === null) return refuse(res);
      const hash = hashCode(body.data.code);
      const expiry = live.get(hash);
      if (expiry === undefined || expiry <= now) return refuse(res);
      live.delete(hash);
      res.status(200).set("Cache-Control", "no-store").json({ approver_key: key });
    },
    // A body the JSON reader refused (not JSON, or over 1 KB). Never echoed.
    (_error: unknown, _req: Request, res: Response, _next: NextFunction) => {
      refuse(res);
    },
  );
}
