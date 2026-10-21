import { and, asc, auditLog, type Database, eq } from "@countersign/db";
import { z } from "zod";

// What happened after the gate allowed a call: the gate's `execution.result` entries in the audit
// log (ADR 0026), read so the inbox can show an allowed refund's PayPal refund ID. The agent
// response itself carries only the intent ID. Read-only; Resolve never writes the audit log.

const IntentIdSchema = z.string().regex(/^int_[0-9a-f]{24}$/);

const AllowedSchema = z.object({
  structuredContent: z.object({ decision: z.literal("allowed"), intent_id: IntentIdSchema }),
});

const ToolStepSchema = z.object({ kind: z.literal("tool"), result: z.unknown() });
const TraceSchema = z.object({ steps: z.array(z.unknown()) });

// Only the fields the inbox shows; the gate's own schema stays the gate's.
const ResultPayloadSchema = z.object({
  outcome: z.enum(["executed", "failed", "unknown"]),
  refund: z.object({ id: z.string().min(1), status: z.string().min(1) }).optional(),
});

export type ExecutionView = {
  intent_id: string;
  outcome: "executed" | "failed" | "unknown";
  refund_id: string | null;
  refund_status: string | null;
};

/** The intent IDs of every call the gate allowed in a run's trace, in order, each once. */
export function allowedIntentIds(trace: unknown): string[] {
  const parsed = TraceSchema.safeParse(trace);
  if (!parsed.success) return [];
  const ids: string[] = [];
  for (const step of parsed.data.steps) {
    const tool = ToolStepSchema.safeParse(step);
    if (!tool.success) continue;
    const allowed = AllowedSchema.safeParse(tool.data.result);
    if (allowed.success && !ids.includes(allowed.data.structuredContent.intent_id)) {
      ids.push(allowed.data.structuredContent.intent_id);
    }
  }
  return ids;
}

/**
 * Each intent's latest `execution.result`. An intent with no readable result is left out, so the
 * inbox shows no refund ID for it rather than a guess.
 */
export async function readExecutions(
  db: Database,
  intentIds: readonly string[],
): Promise<ExecutionView[]> {
  const views: ExecutionView[] = [];
  for (const intentId of intentIds) {
    const rows = await db
      .select({ payload: auditLog.payload })
      .from(auditLog)
      .where(and(eq(auditLog.entryType, "execution.result"), eq(auditLog.refId, intentId)))
      .orderBy(asc(auditLog.seq));
    const last = rows.at(-1);
    if (last === undefined) continue;
    let payload: unknown;
    try {
      payload = JSON.parse(last.payload);
    } catch {
      continue;
    }
    const result = ResultPayloadSchema.safeParse(payload);
    if (!result.success) continue;
    views.push({
      intent_id: intentId,
      outcome: result.data.outcome,
      refund_id: result.data.refund?.id ?? null,
      refund_status: result.data.refund?.status ?? null,
    });
  }
  return views;
}
