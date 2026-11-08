// The gate's mandate API (PLAN E2): replay a draft version N+1 against the decisions in the audit
// log, and sign it into the log. Only the approver key opens it, checked before the body is read,
// and every body is read with zod (strict). Signing appends a `mandate.version` entry holding the
// draft and its hash, under the ledger's lock; it doesn't change the mandate the gate decides
// with, which stays the signed file it loaded at startup (DECISIONS.md). No AI.

import type { Database } from "@countersign/db";
import { type AuditLogWriter, withAuditLog } from "@countersign/ledger";
import { hashMandate, type Mandate } from "@countersign/mandate";
import express, { type Express, type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import { approverOnly } from "./approvals-api";
import type { Approver } from "./approver";
import { checkDraft, readLoggedDecisions, replayDecisions } from "./mandate-replay";
import { findMandateEntry, loggedHash, mandateRef } from "./record";

export const MANDATES_PATH = "/mandates";
/** A mandate with every rule and a full payee list fits well inside this. */
export const MANDATE_BODY_LIMIT = "64kb";

export const MANDATE_MESSAGES = {
  badBody: "Send the draft mandate as JSON.",
  tooLarge: "That draft is too large.",
  stale: "The mandate in force has changed since this draft was made. Compile it again.",
  conflict: "That version is already signed with different rules.",
  unavailable: "The audit log can't be read right now.",
  unrecorded: "The signature couldn't be written to the audit log. Nothing was signed.",
} as const;

export type MandateDeps = {
  approver: Approver;
  db?: Database;
  /** The mandates the gate decides with; a draft must be the next version of one of them. */
  mandates: readonly Mandate[];
  clock: () => Date;
};

const Hash = z.string().regex(/^[0-9a-f]{64}$/);
const ReplayBody = z.strictObject({ mandate: z.unknown() });
const SignBody = z.strictObject({ mandate: z.unknown(), base_hash: Hash });

const message = (res: Response, status: number, text: string) => {
  res.status(status).json({ message: text });
};

export type Signed =
  | { kind: "signed"; seq: number; entryHash: string }
  | { kind: "already"; seq: number; entryHash: string }
  | { kind: "conflict" };

/**
 * Appends the draft's `mandate.version` entry, unless its version is already in the log: with
 * the same hash that's the same signature again (nothing written), with another it's a conflict.
 */
export async function appendSignedMandate(
  log: AuditLogWriter,
  input: { base: Mandate; draft: Mandate; at: string },
): Promise<Signed> {
  const { base, draft, at } = input;
  const hash = hashMandate(draft).hash;
  const ref = mandateRef(draft);
  const logged = await findMandateEntry(log, ref);
  if (logged !== undefined) {
    return loggedHash(logged) === hash
      ? { kind: "already", seq: logged.seq, entryHash: logged.hash }
      : { kind: "conflict" };
  }
  const row = await log.append({
    entryType: "mandate.version",
    refId: ref,
    at,
    payload: {
      mandate: draft,
      hash,
      signed: { base: { version: base.version, hash: hashMandate(base).hash } },
    },
  });
  return { kind: "signed", seq: row.seq, entryHash: row.hash };
}

export function mountMandates(app: Express, deps: MandateDeps): void {
  const { db, mandates, clock } = deps;
  const authenticate = approverOnly(deps.approver);
  const json = express.json({ limit: MANDATE_BODY_LIMIT, strict: true });
  // A body the JSON reader refused: too large or not JSON. Never echoed.
  const bodyError = (error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const status = (error as { status?: unknown } | null)?.status;
    message(res, 400, status === 413 ? MANDATE_MESSAGES.tooLarge : MANDATE_MESSAGES.badBody);
  };

  app.post(
    `${MANDATES_PATH}/replay`,
    authenticate,
    json,
    async (req: Request, res: Response) => {
      const body = ReplayBody.safeParse(req.body);
      if (!body.success) return message(res, 400, MANDATE_MESSAGES.badBody);
      const checked = checkDraft(body.data.mandate, mandates);
      if (!checked.ok) return message(res, 400, checked.problem);
      if (db === undefined) return message(res, 503, MANDATE_MESSAGES.unavailable);
      try {
        const { decisions, partial } = await readLoggedDecisions(db);
        res.json(replayDecisions(checked.base, checked.draft, decisions, partial));
      } catch {
        message(res, 503, MANDATE_MESSAGES.unavailable);
      }
    },
    bodyError,
  );

  app.post(
    `${MANDATES_PATH}/sign`,
    authenticate,
    json,
    async (req: Request, res: Response) => {
      const body = SignBody.safeParse(req.body);
      if (!body.success) return message(res, 400, MANDATE_MESSAGES.badBody);
      const checked = checkDraft(body.data.mandate, mandates);
      if (!checked.ok) return message(res, 400, checked.problem);
      const { base, draft } = checked;
      if (body.data.base_hash !== hashMandate(base).hash) {
        return message(res, 409, MANDATE_MESSAGES.stale);
      }
      if (db === undefined) return message(res, 503, MANDATE_MESSAGES.unavailable);
      let signed: Signed;
      try {
        const at = clock().toISOString();
        signed = await withAuditLog(db, (log) => appendSignedMandate(log, { base, draft, at }));
      } catch {
        return message(res, 503, MANDATE_MESSAGES.unrecorded);
      }
      if (signed.kind === "conflict") return message(res, 409, MANDATE_MESSAGES.conflict);
      res.status(signed.kind === "signed" ? 201 : 200).json({
        id: draft.id,
        version: draft.version,
        hash: hashMandate(draft).hash,
        seq: signed.seq,
        entry_hash: signed.entryHash,
        already_signed: signed.kind === "already",
        in_force: { version: base.version, hash: hashMandate(base).hash },
      });
    },
    bodyError,
  );
}
