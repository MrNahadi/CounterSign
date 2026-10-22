import { and, asc, auditLog, type Database, eq } from "@countersign/db";
import { z } from "zod";

// What happened after the gate allowed a call: the gate's `execution.result` entries in the audit
// log (ADR 0026), read so the inbox can show an allowed refund's PayPal refund ID. The agent
// response itself carries only the intent ID. Read-only; Resolve never writes the audit log.

const IntentIdSchema = z.string().regex(/^int_[0-9a-f]{24}$/);

const AllowedSchema = z.object({
  structuredContent: z.object({ decision: z.literal("allowed"), intent_id: IntentIdSchema }),
});

const PendingSchema = z.object({
  structuredContent: z.object({
    decision: z.literal("pending_approval"),
    intent_id: IntentIdSchema,
    expires_at: z.string().min(1).optional(),
  }),
});

const ToolStepSchema = z.object({ kind: z.literal("tool"), result: z.unknown() });
const TraceSchema = z.object({ steps: z.array(z.unknown()) });

// Only the fields the inbox shows; the gate's own schema stays the gate's.
const ResultPayloadSchema = z.object({
  outcome: z.enum(["executed", "failed", "unknown"]),
  refund: z.object({ id: z.string().min(1), status: z.string().min(1) }).optional(),
  invoice: z.object({ id: z.string().min(1), status: z.string().min(1) }).optional(),
});

const AnswerPayloadSchema = z.object({ outcome: z.enum(["approved", "denied", "rejected"]) });

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

export type HeldState = "approved" | "denied" | "expired" | "waiting";

/** What happened to a call the gate held for the merchant (ADR 0032). */
export type HeldView = {
  intent_id: string;
  state: HeldState;
  /** The execution outcome of an approved intent; null until there is a readable result. */
  outcome: "executed" | "failed" | "unknown" | null;
  refund_id: string | null;
  refund_status: string | null;
  invoice_id: string | null;
  invoice_status: string | null;
};

export type HeldCall = { intentId: string; expiresAt: string | null };

/** Every call the gate held (`pending_approval`) in a run's trace, each intent once, in order. */
export function heldCalls(trace: unknown): HeldCall[] {
  const parsed = TraceSchema.safeParse(trace);
  if (!parsed.success) return [];
  const held: HeldCall[] = [];
  for (const step of parsed.data.steps) {
    const tool = ToolStepSchema.safeParse(step);
    if (!tool.success) continue;
    const pending = PendingSchema.safeParse(tool.data.result);
    if (!pending.success) continue;
    const { intent_id, expires_at } = pending.data.structuredContent;
    const existing = held.find((call) => call.intentId === intent_id);
    if (existing === undefined) held.push({ intentId: intent_id, expiresAt: expires_at ?? null });
    else if (existing.expiresAt === null && expires_at !== undefined) {
      existing.expiresAt = expires_at;
    }
  }
  return held;
}

async function readPayloads(db: Database, entryType: string, intentId: string) {
  const rows = await db
    .select({ payload: auditLog.payload })
    .from(auditLog)
    .where(and(eq(auditLog.entryType, entryType), eq(auditLog.refId, intentId)))
    .orderBy(asc(auditLog.seq));
  return rows.map((row) => {
    try {
      return JSON.parse(row.payload) as unknown;
    } catch {
      return null;
    }
  });
}

/**
 * The latest answer for each held intent: approved (with the execution's outcome and refund or
 * invoice ID), denied, expired once `now` is past its `expires_at`, or still waiting. An answer
 * the gate rejected is no answer. An unreadable answer is skipped, never read as approved, so
 * the call shows as waiting (or expired), never as approved.
 */
export async function readHeld(
  db: Database,
  calls: readonly HeldCall[],
  now: Date,
): Promise<HeldView[]> {
  const views: HeldView[] = [];
  for (const call of calls) {
    const view: HeldView = {
      intent_id: call.intentId,
      state: "waiting",
      outcome: null,
      refund_id: null,
      refund_status: null,
      invoice_id: null,
      invoice_status: null,
    };
    let answer: "approved" | "denied" | null = null;
    for (const payload of await readPayloads(db, "approval", call.intentId)) {
      const parsed = AnswerPayloadSchema.safeParse(payload);
      if (parsed.success && parsed.data.outcome !== "rejected") answer = parsed.data.outcome;
    }
    if (answer === "denied") view.state = "denied";
    else if (answer === "approved") {
      view.state = "approved";
      const results = await readPayloads(db, "execution.result", call.intentId);
      const last = ResultPayloadSchema.safeParse(results.at(-1));
      if (last.success) {
        view.outcome = last.data.outcome;
        view.refund_id = last.data.refund?.id ?? null;
        view.refund_status = last.data.refund?.status ?? null;
        view.invoice_id = last.data.invoice?.id ?? null;
        view.invoice_status = last.data.invoice?.status ?? null;
      }
    } else if (call.expiresAt !== null) {
      const expires = new Date(call.expiresAt);
      if (!Number.isNaN(expires.getTime()) && now.getTime() > expires.getTime()) {
        view.state = "expired";
      }
    }
    views.push(view);
  }
  return views;
}
