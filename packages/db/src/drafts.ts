// The dispute draft store's writers and readers (ADR 0035, 0037). A draft is created `queued`,
// started, and finished once; a finished draft is never changed. At most one draft per dispute
// isn't `failed`: drafting again after a failure adds a new draft, and the failed one stays so it
// still counts against the day's cap. Drafts aren't hashed and aren't the audit log.

import { TimestampSchema } from "@countersign/mandate";
import { and, desc, eq, inArray, ne, sql } from "drizzle-orm";
import { z } from "zod";
import type { Database } from "./client";
import {
  DISPUTE_DRAFT_STATUSES,
  type DisputeDraftRow,
  type DisputeDraftStatus,
  disputeDrafts,
} from "./schema";

const FINAL_STATUSES = ["proposed", "failed", "not_run"] as const;

const IdSchema = z.string().min(1).max(256);

const NewDraftSchema = z.strictObject({
  id: IdSchema,
  disputeId: IdSchema,
  model: z.string().min(1).max(256),
  queuedAt: TimestampSchema,
});

const FinishSchema = z.strictObject({
  status: z.enum(FINAL_STATUSES),
  outcome: z.string().min(1).max(256),
  draftedBy: z.string().min(1).max(256).optional(),
  modelVersions: z.array(z.string().min(1).max(256)).optional(),
  notes: z.unknown().optional(),
  factsSummary: z.unknown().optional(),
  agentResponse: z.unknown().optional(),
  intentId: IdSchema.optional(),
  finishedAt: TimestampSchema,
});

const DateSchema = z.iso.date();

/** What a draft is created with. It starts `queued`. */
export type NewDraft = {
  id: string;
  disputeId: string;
  /** The model asked for. */
  model: string;
  queuedAt: string;
};

/** What a draft ends with. The JSON values must hold no secret, payer email or ticket text. */
export type DraftResult = {
  status: "proposed" | "failed" | "not_run";
  outcome: string;
  /** The model ID, or `template`. */
  draftedBy?: string;
  /** Every `modelVersion` the API reported, in order. */
  modelVersions?: string[];
  notes?: unknown;
  factsSummary?: unknown;
  agentResponse?: unknown;
  intentId?: string;
  finishedAt: string;
};

/** A stored draft. */
export type DisputeDraft = NewDraft & {
  status: DisputeDraftStatus;
  outcome: string | null;
  draftedBy: string | null;
  modelVersions: string[];
  notes: unknown;
  factsSummary: unknown;
  agentResponse: unknown;
  intentId: string | null;
  startedAt: string | null;
  finishedAt: string | null;
};

/** Thrown when input to a draft writer or reader fails its schema. The message holds no input. */
export class InvalidDisputeDraftError extends Error {
  override readonly name = "InvalidDisputeDraftError";
}

/** Thrown when a draft can't move as asked: wrong state, or an ID stored with other contents. */
export class DisputeDraftConflictError extends Error {
  override readonly name = "DisputeDraftConflictError";
  readonly draftId: string;
  constructor(draftId: string, message: string) {
    super(message);
    this.draftId = draftId;
  }
}

/** Thrown when a draft to start or finish isn't stored. */
export class DisputeDraftNotFoundError extends Error {
  override readonly name = "DisputeDraftNotFoundError";
  readonly draftId: string;
  constructor(draftId: string) {
    super(`Draft ${draftId} isn't stored.`);
    this.draftId = draftId;
  }
}

const describeIssue = (error: z.ZodError): string => {
  const issue = error.issues[0];
  if (!issue) return "draft: invalid";
  const path = issue.path.length > 0 ? issue.path.map(String).join(".") : "draft";
  return `${path}: ${issue.message}`.replace(/\s+/g, " ").trim();
};

const parse = <T extends z.ZodType>(schema: T, input: unknown): z.output<T> => {
  const parsed = schema.safeParse(input);
  if (!parsed.success)
    throw new InvalidDisputeDraftError(`Invalid draft: ${describeIssue(parsed.error)}`);
  return parsed.data;
};

const fromRow = (row: DisputeDraftRow): DisputeDraft => ({
  id: row.id,
  disputeId: row.disputeId,
  model: row.model,
  queuedAt: row.queuedAt,
  status: z.enum(DISPUTE_DRAFT_STATUSES).parse(row.status),
  outcome: row.outcome,
  draftedBy: row.draftedBy,
  modelVersions: z.array(z.string()).parse(row.modelVersions),
  notes: row.notes ?? null,
  factsSummary: row.factsSummary ?? null,
  agentResponse: row.agentResponse ?? null,
  intentId: row.intentId,
  startedAt: row.startedAt,
  finishedAt: row.finishedAt,
});

/** The draft with this ID, or null when none is stored. */
export const readDraft = async (db: Database, id: string): Promise<DisputeDraft | null> => {
  const [row] = await db.select().from(disputeDrafts).where(eq(disputeDrafts.id, id)).limit(1);
  return row ? fromRow(row) : null;
};

/** The dispute's latest draft, failed or not, or null when it has none. */
export const readLatestDraft = async (
  db: Database,
  disputeId: string,
): Promise<DisputeDraft | null> => {
  const [row] = await db
    .select()
    .from(disputeDrafts)
    .where(eq(disputeDrafts.disputeId, disputeId))
    .orderBy(desc(disputeDrafts.seq))
    .limit(1);
  return row ? fromRow(row) : null;
};

/** Each dispute's latest draft, newest first. */
export const listLatestDrafts = async (db: Database): Promise<DisputeDraft[]> => {
  const rows = await db
    .selectDistinctOn([disputeDrafts.disputeId])
    .from(disputeDrafts)
    .orderBy(disputeDrafts.disputeId, desc(disputeDrafts.seq));
  return rows.sort((a, b) => b.seq - a.seq).map(fromRow);
};

const readLive = async (db: Database, disputeId: string): Promise<DisputeDraft | null> => {
  const [row] = await db
    .select()
    .from(disputeDrafts)
    .where(and(eq(disputeDrafts.disputeId, disputeId), ne(disputeDrafts.status, "failed")))
    .limit(1);
  return row ? fromRow(row) : null;
};

/**
 * Queues a draft for the dispute unless it has one that isn't `failed`. Answers the new draft
 * (`created: true`), or the dispute's live draft and creates nothing (`created: false`), also when
 * another writer queued it first. Throws `InvalidDisputeDraftError` for input that fails its
 * schema, and `DisputeDraftConflictError` when the ID is already stored.
 */
export const queueDraft = async (
  db: Database,
  input: NewDraft,
): Promise<{ created: boolean; draft: DisputeDraft }> => {
  const draft = parse(NewDraftSchema, input);
  const live = await readLive(db, draft.disputeId);
  if (live) return { created: false, draft: live };
  if (await readDraft(db, draft.id))
    throw new DisputeDraftConflictError(draft.id, `Draft ${draft.id} is already stored.`);
  // The partial unique index refuses a second live draft for the dispute.
  const inserted = await db
    .insert(disputeDrafts)
    .values({ ...draft, modelVersions: [], status: "queued" })
    .onConflictDoNothing()
    .returning();
  const [row] = inserted;
  if (row) return { created: true, draft: fromRow(row) };
  const winner = await readLive(db, draft.disputeId);
  if (winner) return { created: false, draft: winner };
  throw new DisputeDraftConflictError(draft.id, `Draft ${draft.id} couldn't be queued.`);
};

const explainMiss = async (db: Database, id: string, action: string): Promise<never> => {
  const stored = await readDraft(db, id);
  if (!stored) throw new DisputeDraftNotFoundError(id);
  throw new DisputeDraftConflictError(
    id,
    `Draft ${id} is ${stored.status} and can't be ${action}.`,
  );
};

/** Moves a `queued` draft to `running`. Throws when it isn't stored or isn't `queued`. */
export const startDraft = async (db: Database, id: string, startedAt: string): Promise<void> => {
  const time = parse(TimestampSchema, startedAt);
  const updated = await db
    .update(disputeDrafts)
    .set({ status: "running", startedAt: time })
    .where(and(eq(disputeDrafts.id, id), eq(disputeDrafts.status, "queued")))
    .returning({ id: disputeDrafts.id });
  if (updated.length === 0) await explainMiss(db, id, "started");
};

/**
 * Finishes a `queued` or `running` draft with a final status. A draft that is already final can't
 * be finished again: it throws `DisputeDraftConflictError` and changes nothing.
 */
export const finishDraft = async (db: Database, id: string, result: DraftResult): Promise<void> => {
  const done = parse(FinishSchema, result);
  const updated = await db
    .update(disputeDrafts)
    .set({
      status: done.status,
      outcome: done.outcome,
      draftedBy: done.draftedBy ?? null,
      modelVersions: done.modelVersions ?? [],
      notes: done.notes ?? null,
      factsSummary: done.factsSummary ?? null,
      agentResponse: done.agentResponse ?? null,
      intentId: done.intentId ?? null,
      finishedAt: done.finishedAt,
    })
    .where(and(eq(disputeDrafts.id, id), inArray(disputeDrafts.status, ["queued", "running"])))
    .returning({ id: disputeDrafts.id });
  if (updated.length === 0) await explainMiss(db, id, "finished");
};

/** How many drafts were queued on this UTC date (`YYYY-MM-DD`), every status included. */
export const countDraftsOnDate = async (db: Database, date: string): Promise<number> => {
  const day = parse(DateSchema, date);
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(disputeDrafts)
    .where(sql`((${disputeDrafts.queuedAt}::timestamptz) AT TIME ZONE 'UTC')::date = ${day}::date`);
  return row?.count ?? 0;
};

/**
 * Marks every `queued` or `running` draft `failed` with outcome `interrupted`, in one statement,
 * and returns how many it changed. Final drafts are left alone.
 */
export const markUnfinishedDraftsInterrupted = async (
  db: Database,
  finishedAt: string,
): Promise<number> => {
  const time = parse(TimestampSchema, finishedAt);
  const updated = await db
    .update(disputeDrafts)
    .set({ status: "failed", outcome: "interrupted", finishedAt: time })
    .where(inArray(disputeDrafts.status, ["queued", "running"]))
    .returning({ id: disputeDrafts.id });
  return updated.length;
};
