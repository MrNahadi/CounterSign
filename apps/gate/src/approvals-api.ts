// The gate's approval API (ADR 0032): the merchant lists step-ups as cards and answers one. Only
// the approver key opens it, checked before any body is read; principal keys never do. Bodies
// and IDs are read with zod, and no answer echoes the request or holds a key. No AI.

import { type Database, readEvidenceDocument } from "@countersign/db";
import type { Mandate } from "@countersign/mandate";
import type { PayPalClient } from "@countersign/rail-paypal";
import express, { type Express, type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import { answerStepUp } from "./answer-step-up";
import { buildCard, readApprovals } from "./approval-cards";
import { APPROVAL_ANSWERS, readStepUp } from "./approval-log";
import type { Approver } from "./approver";
import { DOCUMENT_ID_PATTERN } from "./dispute-evidence";
import type { Execution } from "./executors";

export const APPROVALS_PATH = "/approvals";
export const DOCUMENTS_PATH = `${APPROVALS_PATH}/documents`;
export const APPROVAL_BODY_LIMIT = "16kb";

export const APPROVAL_MESSAGES = {
  unauthorized: "A valid approver key is required.",
  notFound: "There's no step-up with that ID.",
  badDocumentId: "That isn't an evidence document ID.",
  documentNotFound: "There's no evidence document with that ID.",
  badBody: "Send JSON with answer (approve or deny) and intent_hash.",
  tooLarge: "The request body is too large.",
  unreadable: "An audit-log entry can't be read, so nothing can be approved.",
  unavailable: "The approvals can't be read right now.",
  noRail: "PayPal isn't set up on the gate, so nothing can be approved.",
  unrecorded: "Countersign couldn't record the answer, so nothing was done.",
} as const;

export type ApprovalsDeps = {
  approver: Approver;
  db?: Database;
  // Built from the environment. Throws when PayPal's variables are missing.
  rail?: () => PayPalClient;
  mandates: readonly Mandate[];
  // The read and answer time.
  clock: () => Date;
};

const StepUpId = z
  .string()
  .regex(/^[1-9][0-9]{0,15}$/)
  .transform(Number)
  .pipe(z.number().int().max(Number.MAX_SAFE_INTEGER));

const DocumentId = z.string().regex(DOCUMENT_ID_PATTERN);

const AnswerBody = z.strictObject({
  answer: z.enum(APPROVAL_ANSWERS),
  intent_hash: z.string().regex(/^[0-9a-f]{64}$/),
});

// A deny never reaches PayPal, so it can be answered without the rail; this one refuses any use.
const NO_RAIL = new Proxy({} as PayPalClient, {
  get() {
    throw new Error("PayPal isn't set up on the gate.");
  },
});

const message = (res: Response, status: number, text: string) => {
  res.status(status).json({ message: text });
};

function executionView(execution: Execution | null) {
  if (execution === null) return null;
  return {
    outcome: execution.outcome,
    refund: execution.refund,
    invoice: execution.invoice ?? null,
    dispute: execution.dispute ?? null,
    error:
      execution.error === null
        ? null
        : { name: execution.error.name, issues: execution.error.issues },
  };
}

// The approver check, shared by the approval and audit APIs. It runs before any body or query is
// read, so a refused key never reaches the log. Every refusal looks the same.
export function approverOnly(approver: Approver) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!approver.authenticate(req.headers.authorization)) {
      res.status(401).set("WWW-Authenticate", "Bearer");
      message(res, 401, APPROVAL_MESSAGES.unauthorized);
      return;
    }
    next();
  };
}

export function mountApprovals(app: Express, deps: ApprovalsDeps): void {
  const { approver, db, mandates, clock } = deps;
  const authenticate = approverOnly(approver);

  const stepUpId = (req: Request): number | null => {
    const parsed = StepUpId.safeParse(req.params.id);
    return parsed.success ? parsed.data : null;
  };

  app.get(APPROVALS_PATH, authenticate, async (_req: Request, res: Response) => {
    if (db === undefined) return message(res, 503, APPROVAL_MESSAGES.unavailable);
    try {
      const read = await readApprovals(db, clock(), mandates);
      if (!read.known) return message(res, 503, APPROVAL_MESSAGES.unreadable);
      res.json(read.view);
    } catch {
      message(res, 503, APPROVAL_MESSAGES.unavailable);
    }
  });

  // A stored evidence document's bytes, as a download. Documents are write-once, so these are the
  // bytes a card's SHA-256 names unless the card says the document isn't available.
  app.get(`${DOCUMENTS_PATH}/:id`, authenticate, async (req: Request, res: Response) => {
    const id = DocumentId.safeParse(req.params.id);
    if (!id.success) return message(res, 400, APPROVAL_MESSAGES.badDocumentId);
    if (db === undefined) return message(res, 503, APPROVAL_MESSAGES.unavailable);
    try {
      const document = await readEvidenceDocument(db, id.data);
      if (document === null) return message(res, 404, APPROVAL_MESSAGES.documentNotFound);
      res
        .status(200)
        .type(document.contentType)
        .attachment(document.name)
        .set("X-Content-Type-Options", "nosniff")
        .send(Buffer.from(document.bytes));
    } catch {
      message(res, 503, APPROVAL_MESSAGES.unavailable);
    }
  });

  app.get(`${APPROVALS_PATH}/:id`, authenticate, async (req: Request, res: Response) => {
    const id = stepUpId(req);
    if (id === null) return message(res, 404, APPROVAL_MESSAGES.notFound);
    if (db === undefined) return message(res, 503, APPROVAL_MESSAGES.unavailable);
    try {
      const read = await readStepUp(db, id, clock());
      if (!read.known) return message(res, 503, APPROVAL_MESSAGES.unreadable);
      if (read.stepUp === null) return message(res, 404, APPROVAL_MESSAGES.notFound);
      res.json(await buildCard(db, read.stepUp, mandates));
    } catch {
      message(res, 503, APPROVAL_MESSAGES.unavailable);
    }
  });

  app.post(
    `${APPROVALS_PATH}/:id`,
    authenticate,
    express.json({ limit: APPROVAL_BODY_LIMIT, strict: true }),
    async (req: Request, res: Response) => {
      const id = stepUpId(req);
      if (id === null) return message(res, 404, APPROVAL_MESSAGES.notFound);
      const body = AnswerBody.safeParse(req.body);
      if (!body.success) return message(res, 400, APPROVAL_MESSAGES.badBody);
      if (db === undefined) return message(res, 503, APPROVAL_MESSAGES.unavailable);

      let rail: PayPalClient | null = null;
      try {
        rail = deps.rail?.() ?? null;
      } catch {
        rail = null;
      }
      if (rail === null && body.data.answer === "approve") {
        return message(res, 503, APPROVAL_MESSAGES.noRail);
      }

      try {
        const result = await answerStepUp({
          db,
          rail: rail ?? NO_RAIL,
          stepUpSeq: id,
          answer: body.data.answer,
          intentHash: body.data.intent_hash,
          channel: "approvals_page",
          now: clock(),
          clock,
        });
        switch (result.kind) {
          case "answered":
            return res.json({
              outcome: result.outcome,
              code: result.code,
              step_up_id: result.stepUpSeq,
              intent_id: result.intentId,
              approval_seq: result.approvalSeq,
              execution: executionView(result.execution),
            });
          case "not_found":
            return message(res, 404, APPROVAL_MESSAGES.notFound);
          case "input_error":
            return message(res, 400, APPROVAL_MESSAGES.badBody);
          case "unknown":
            return message(res, 503, APPROVAL_MESSAGES.unreadable);
          case "recording_failed":
            return message(res, 503, APPROVAL_MESSAGES.unrecorded);
        }
      } catch {
        message(res, 503, APPROVAL_MESSAGES.unrecorded);
      }
    },
    // A body the JSON reader refused: too large or not JSON. Never echoed.
    (error: unknown, _req: Request, res: Response, _next: NextFunction) => {
      const status = (error as { status?: unknown } | null)?.status;
      message(res, 400, status === 413 ? APPROVAL_MESSAGES.tooLarge : APPROVAL_MESSAGES.badBody);
    },
  );
}
