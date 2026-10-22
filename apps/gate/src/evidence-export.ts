// Evidence selection (ADR 0034): which audit-log rows belong to an intent or a capture, then the
// `countersign-evidence-v1` file built from them by @countersign/ledger. Read-only: it appends
// nothing. Payload text is parsed only to find the intent, capture and mandate a row points at,
// and never re-hashed (ADR 0022); the file carries the stored text. An entry that can't be read
// that far is left out of the selection, never guessed at. No AI, and no network.

import { auditLog, type Database, eq, sql } from "@countersign/db";
import {
  buildEvidence,
  type EvidenceFile,
  type EvidenceScope,
  EvidenceScopeSchema,
} from "@countersign/ledger";
import { z } from "zod";

const Seq = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);

// The parts of a decision entry the selection needs, read loosely so a decision that is odd in
// some other part still counts for its intent.
const DecisionPointersSchema = z.object({
  mandateSeq: Seq.optional(),
  record: z.object({
    intentId: z.string().min(1).nullable(),
    intent: z
      .object({
        target: z.object({ kind: z.string(), captureId: z.string().optional() }),
      })
      .nullable(),
  }),
});

const ReconciliationPointersSchema = z.object({
  refund: z.object({ captureId: z.string().nullable() }),
});

function parseLoose<T>(payload: string, schema: z.ZodType<T>): T | null {
  try {
    const parsed = schema.safeParse(JSON.parse(payload));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export type EvidenceExport = { kind: "file"; file: EvidenceFile } | { kind: "not_found" };

// The file for an intent's or a capture's evidence at `now`, or not found when nothing is
// selected. A database that can't be read throws.
export async function exportEvidence(
  db: Database,
  scopeInput: EvidenceScope,
  now: Date,
): Promise<EvidenceExport> {
  const scope = EvidenceScopeSchema.parse(scopeInput);
  const seqs = new Set<number>();
  const intentIds = new Set<string>();
  const mandateSeqs = new Set<number>();

  if (scope.kind === "intent") {
    intentIds.add(scope.id);
  } else {
    const decisions = await db
      .select({ payload: auditLog.payload })
      .from(auditLog)
      .where(eq(auditLog.entryType, "decision"));
    for (const { payload } of decisions) {
      const pointers = parseLoose(payload, DecisionPointersSchema);
      const { intent, intentId } = pointers?.record ?? { intent: null, intentId: null };
      if (
        intentId !== null &&
        intent?.target.kind === "capture" &&
        intent.target.captureId === scope.id
      ) {
        intentIds.add(intentId);
      }
    }
    const reconciliations = await db
      .select({ seq: auditLog.seq, payload: auditLog.payload })
      .from(auditLog)
      .where(eq(auditLog.entryType, "reconciliation"));
    for (const { seq, payload } of reconciliations) {
      if (parseLoose(payload, ReconciliationPointersSchema)?.refund.captureId === scope.id) {
        seqs.add(seq);
      }
    }
  }

  if (intentIds.size > 0) {
    const rows = await db
      .select({
        seq: auditLog.seq,
        entryType: auditLog.entryType,
        payload: auditLog.payload,
      })
      .from(auditLog)
      .where(
        sql`${auditLog.refId} in (${sql.join(
          [...intentIds].map((id) => sql`${id}`),
          sql`, `,
        )})`,
      );
    for (const { seq, entryType, payload } of rows) {
      seqs.add(seq);
      if (entryType !== "decision") continue;
      const mandateSeq = parseLoose(payload, DecisionPointersSchema)?.mandateSeq;
      if (mandateSeq !== undefined) mandateSeqs.add(mandateSeq);
    }
  }
  for (const seq of mandateSeqs) seqs.add(seq);

  if (seqs.size === 0) return { kind: "not_found" };
  const file = await buildEvidence(db, {
    scope,
    seqs: [...seqs],
    exportedAt: now.toISOString(),
  });
  return { kind: "file", file };
}
