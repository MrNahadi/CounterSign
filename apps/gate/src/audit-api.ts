// The gate's read-only audit API (ADR 0034): decision rows, one decision with its claims vs
// records and trail, raw entries, the chain verdict and the evidence file. Only the approver key
// opens it, checked before anything is read. Query parameters and IDs are read with zod (strict),
// nothing is written, and no answer echoes the request or holds a key. No AI.

import { auditLog, type Database, desc } from "@countersign/db";
import { verifyLog } from "@countersign/ledger";
import type { Mandate } from "@countersign/mandate";
import type { Express, Request, Response } from "express";
import { z } from "zod";
import { approverOnly } from "./approvals-api";
import type { Approver } from "./approver";
import {
  DecisionFiltersSchema,
  EntryPageSchema,
  readDecisionDetail,
  readDecisionRows,
  readDecisionSeqByIntent,
  readEntries,
} from "./audit-reader";
import { exportEvidence } from "./evidence-export";

export const AUDIT_PATH = "/audit";

export const AUDIT_MESSAGES = {
  badQuery: "One of the query parameters isn't valid.",
  badSeq: "A decision is named by its entry number.",
  badIntent: "That isn't an intent ID.",
  badExport: "Ask for exactly one of intent or capture, with a valid ID.",
  noDecision: "There's no decision with that entry number.",
  noIntent: "There's no decision for that intent.",
  nothingToExport: "There's nothing to export for that.",
  unavailable: "The audit log can't be read right now.",
} as const;

export type AuditDeps = {
  approver: Approver;
  db?: Database;
  mandates: readonly Mandate[];
  // The read time: step-up states and the export's `exported_at`.
  clock: () => Date;
};

const SeqText = z
  .string()
  .regex(/^[1-9][0-9]{0,15}$/)
  .transform(Number)
  .pipe(z.number().int().max(Number.MAX_SAFE_INTEGER));
const IntentIdText = z.string().regex(/^int_[0-9a-f]{24}$/);
// PayPal capture IDs are upper-case letters and digits; the fake sandbox's carry hyphens.
const CaptureIdText = z.string().regex(/^[A-Za-z0-9-]{1,64}$/);

// Query strings carry numbers as text; anything else (an array, an object) stays as it is and
// fails the strict schema.
const numeric = (value: unknown) =>
  typeof value === "string" && /^[0-9]{1,16}$/.test(value) ? Number(value) : value;
const withNumbers = (query: unknown, keys: readonly string[]) => {
  if (typeof query !== "object" || query === null) return query;
  const copy: Record<string, unknown> = { ...query };
  for (const key of keys) if (key in copy) copy[key] = numeric(copy[key]);
  return copy;
};

const NoQuery = z.strictObject({});
const ExportQuery = z.union([
  z.strictObject({ intent: IntentIdText }).transform(({ intent }) => ({
    kind: "intent" as const,
    id: intent,
  })),
  z.strictObject({ capture: CaptureIdText }).transform(({ capture }) => ({
    kind: "capture" as const,
    id: capture,
  })),
]);

const message = (res: Response, status: number, text: string) => {
  res.status(status).json({ message: text });
};

// The chain verdict as the API shows it: the head is the last stored row when the chain is
// broken (a broken verdict carries none), and null for an empty log.
async function verifyView(db: Database) {
  const verdict = await verifyLog(db);
  if (verdict.intact) {
    return {
      intact: true,
      entry_count: verdict.entries,
      head: verdict.entries === 0 ? null : verdict.head,
      problems: [],
    };
  }
  const [last] = await db
    .select({ seq: auditLog.seq, hash: auditLog.hash })
    .from(auditLog)
    .orderBy(desc(auditLog.seq))
    .limit(1);
  return {
    intact: false,
    entry_count: verdict.entries,
    head: last ?? null,
    problems: verdict.problems.map(({ seq, problem, detail }) => ({ seq, code: problem, detail })),
  };
}

export function mountAudit(app: Express, deps: AuditDeps): void {
  const { db, mandates, clock } = deps;
  const authenticate = approverOnly(deps.approver);

  // Runs a read against the database, answering 503 when there's none or it can't be read.
  const read =
    (handler: (db: Database, req: Request, res: Response) => Promise<void>) =>
    async (req: Request, res: Response) => {
      if (db === undefined) return message(res, 503, AUDIT_MESSAGES.unavailable);
      try {
        await handler(db, req, res);
      } catch {
        if (!res.headersSent) message(res, 503, AUDIT_MESSAGES.unavailable);
      }
    };

  app.get(
    `${AUDIT_PATH}/decisions`,
    authenticate,
    read(async (db, req, res) => {
      const filters = DecisionFiltersSchema.safeParse(withNumbers(req.query, ["before", "limit"]));
      if (!filters.success) return message(res, 400, AUDIT_MESSAGES.badQuery);
      res.json(await readDecisionRows(db, filters.data, clock()));
    }),
  );

  app.get(
    `${AUDIT_PATH}/decisions/:seq`,
    authenticate,
    read(async (db, req, res) => {
      if (!NoQuery.safeParse(req.query).success) return message(res, 400, AUDIT_MESSAGES.badQuery);
      const seq = SeqText.safeParse(req.params.seq);
      if (!seq.success) return message(res, 400, AUDIT_MESSAGES.badSeq);
      const detail = await readDecisionDetail(db, seq.data, clock(), mandates);
      if (detail === null) return message(res, 404, AUDIT_MESSAGES.noDecision);
      res.json(detail);
    }),
  );

  app.get(
    `${AUDIT_PATH}/intents/:id`,
    authenticate,
    read(async (db, req, res) => {
      if (!NoQuery.safeParse(req.query).success) return message(res, 400, AUDIT_MESSAGES.badQuery);
      const id = IntentIdText.safeParse(req.params.id);
      if (!id.success) return message(res, 400, AUDIT_MESSAGES.badIntent);
      const seq = await readDecisionSeqByIntent(db, id.data);
      if (seq === null) return message(res, 404, AUDIT_MESSAGES.noIntent);
      res.json({ decision_seq: seq });
    }),
  );

  app.get(
    `${AUDIT_PATH}/entries`,
    authenticate,
    read(async (db, req, res) => {
      const page = EntryPageSchema.safeParse(withNumbers(req.query, ["before", "limit"]));
      if (!page.success) return message(res, 400, AUDIT_MESSAGES.badQuery);
      res.json(await readEntries(db, page.data));
    }),
  );

  app.get(
    `${AUDIT_PATH}/verify`,
    authenticate,
    read(async (db, req, res) => {
      if (!NoQuery.safeParse(req.query).success) return message(res, 400, AUDIT_MESSAGES.badQuery);
      res.json(await verifyView(db));
    }),
  );

  app.get(
    `${AUDIT_PATH}/export`,
    authenticate,
    read(async (db, req, res) => {
      const scope = ExportQuery.safeParse(req.query);
      if (!scope.success) return message(res, 400, AUDIT_MESSAGES.badExport);
      const exported = await exportEvidence(db, scope.data, clock());
      if (exported.kind === "not_found") return message(res, 404, AUDIT_MESSAGES.nothingToExport);
      // The ID is restricted to letters, digits, hyphens and underscores, so the name is safe.
      const name = `countersign-evidence-${scope.data.kind}-${scope.data.id}.json`;
      res
        .status(200)
        .type("application/json")
        .set("Content-Disposition", `attachment; filename="${name}"`)
        .send(`${JSON.stringify(exported.file, null, 2)}\n`);
    }),
  );
}
