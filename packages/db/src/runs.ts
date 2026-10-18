// The agent run store's writers and readers (ADR 0030). A run is created `queued`, started, and
// finished once; a finished run is never changed. Runs aren't hashed and aren't the audit log.

import { TimestampSchema } from "@countersign/mandate";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import type { Database } from "./client";
import {
  type AgentRunRow,
  agentRuns,
  RUN_MODES,
  RUN_STATUSES,
  type RunMode,
  type RunStatus,
} from "./schema";

const FINAL_STATUSES = ["replied", "stopped", "failed", "not_run"] as const;

const IdSchema = z.string().min(1).max(256);

const NewRunSchema = z.strictObject({
  id: IdSchema,
  ticketId: IdSchema,
  threadId: IdSchema,
  mode: z.enum(RUN_MODES),
  model: z.string().min(1).max(256),
  queuedAt: TimestampSchema,
});

const FinishSchema = z.strictObject({
  status: z.enum(FINAL_STATUSES),
  outcome: z.string().min(1).max(256),
  reply: z.string().nullable(),
  modelVersions: z.array(z.string().min(1).max(256)),
  trace: z.unknown(),
  finishedAt: TimestampSchema,
});

const DateSchema = z.iso.date();

/** What a run is created with. It starts `queued`. */
export type NewRun = {
  id: string;
  ticketId: string;
  threadId: string;
  mode: RunMode;
  /** The model asked for. */
  model: string;
  queuedAt: string;
};

/** What a run ends with. `trace` is any JSON value; it must hold no secret. */
export type RunResult = {
  status: "replied" | "stopped" | "failed" | "not_run";
  outcome: string;
  reply: string | null;
  /** Every `modelVersion` the API reported, in order. */
  modelVersions: string[];
  trace: unknown;
  finishedAt: string;
};

/** A stored run. */
export type AgentRun = NewRun & {
  status: RunStatus;
  outcome: string | null;
  reply: string | null;
  modelVersions: string[];
  trace: unknown;
  startedAt: string | null;
  finishedAt: string | null;
};

/** Thrown when input to a run writer or reader fails its schema. The message holds no input. */
export class InvalidAgentRunError extends Error {
  override readonly name = "InvalidAgentRunError";
}

/** Thrown when a run can't move as asked: wrong state, or an ID stored with other contents. */
export class AgentRunConflictError extends Error {
  override readonly name = "AgentRunConflictError";
  readonly runId: string;
  constructor(runId: string, message: string) {
    super(message);
    this.runId = runId;
  }
}

/** Thrown when a run to start or finish isn't stored. */
export class AgentRunNotFoundError extends Error {
  override readonly name = "AgentRunNotFoundError";
  readonly runId: string;
  constructor(runId: string) {
    super(`Run ${runId} isn't stored.`);
    this.runId = runId;
  }
}

const describeIssue = (error: z.ZodError): string => {
  const issue = error.issues[0];
  if (!issue) return "run: invalid";
  const path = issue.path.length > 0 ? issue.path.map(String).join(".") : "run";
  return `${path}: ${issue.message}`.replace(/\s+/g, " ").trim();
};

const parse = <T extends z.ZodType>(schema: T, input: unknown): z.output<T> => {
  const parsed = schema.safeParse(input);
  if (!parsed.success)
    throw new InvalidAgentRunError(`Invalid run: ${describeIssue(parsed.error)}`);
  return parsed.data;
};

const fromRow = (row: AgentRunRow): AgentRun => ({
  id: row.id,
  ticketId: row.ticketId,
  threadId: row.threadId,
  mode: z.enum(RUN_MODES).parse(row.mode),
  model: row.model,
  queuedAt: row.queuedAt,
  status: z.enum(RUN_STATUSES).parse(row.status),
  outcome: row.outcome,
  reply: row.reply,
  modelVersions: z.array(z.string()).parse(row.modelVersions),
  trace: row.trace ?? null,
  startedAt: row.startedAt,
  finishedAt: row.finishedAt,
});

/** The run with this ID, or null when none is stored. */
export const readRun = async (db: Database, id: string): Promise<AgentRun | null> => {
  const [row] = await db.select().from(agentRuns).where(eq(agentRuns.id, id)).limit(1);
  return row ? fromRow(row) : null;
};

/** A thread's runs, in creation order. An unknown thread reads as none. */
export const readRunsByThread = async (db: Database, threadId: string): Promise<AgentRun[]> => {
  const rows = await db
    .select()
    .from(agentRuns)
    .where(eq(agentRuns.threadId, threadId))
    .orderBy(asc(agentRuns.seq));
  return rows.map(fromRow);
};

/**
 * Creates a run in status `queued`. Returns `created`, or `unchanged` when the same run is stored
 * and still as created. Throws `InvalidAgentRunError` for input that fails its schema, and
 * `AgentRunConflictError` when the ID is stored with other contents.
 */
export const createRun = async (db: Database, input: NewRun): Promise<"created" | "unchanged"> => {
  const run = parse(NewRunSchema, input);
  const inserted = await db
    .insert(agentRuns)
    .values({ ...run, modelVersions: [], status: "queued" })
    .onConflictDoNothing({ target: agentRuns.id })
    .returning({ id: agentRuns.id });
  if (inserted.length > 0) return "created";
  const stored = await readRun(db, run.id);
  if (
    stored &&
    stored.status === "queued" &&
    stored.ticketId === run.ticketId &&
    stored.threadId === run.threadId &&
    stored.mode === run.mode &&
    stored.model === run.model &&
    stored.queuedAt === run.queuedAt
  )
    return "unchanged";
  throw new AgentRunConflictError(run.id, `Run ${run.id} is already stored with other contents.`);
};

const explainMiss = async (db: Database, id: string, action: string): Promise<never> => {
  const stored = await readRun(db, id);
  if (!stored) throw new AgentRunNotFoundError(id);
  throw new AgentRunConflictError(id, `Run ${id} is ${stored.status} and can't be ${action}.`);
};

/** Moves a `queued` run to `running`. Throws when it isn't stored or isn't `queued`. */
export const startRun = async (db: Database, id: string, startedAt: string): Promise<void> => {
  const time = parse(TimestampSchema, startedAt);
  const updated = await db
    .update(agentRuns)
    .set({ status: "running", startedAt: time })
    .where(and(eq(agentRuns.id, id), eq(agentRuns.status, "queued")))
    .returning({ id: agentRuns.id });
  if (updated.length === 0) await explainMiss(db, id, "started");
};

/**
 * Finishes a `queued` or `running` run with a final status. A run that is already final can't be
 * finished again: it throws `AgentRunConflictError` and changes nothing.
 */
export const finishRun = async (db: Database, id: string, result: RunResult): Promise<void> => {
  const done = parse(FinishSchema, result);
  const updated = await db
    .update(agentRuns)
    .set({
      status: done.status,
      outcome: done.outcome,
      reply: done.reply,
      modelVersions: done.modelVersions,
      trace: done.trace ?? null,
      finishedAt: done.finishedAt,
    })
    .where(and(eq(agentRuns.id, id), inArray(agentRuns.status, ["queued", "running"])))
    .returning({ id: agentRuns.id });
  if (updated.length === 0) await explainMiss(db, id, "finished");
};

/** How many runs were queued on this UTC date (`YYYY-MM-DD`), every status included. */
export const countRunsOnDate = async (db: Database, date: string): Promise<number> => {
  const day = parse(DateSchema, date);
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(agentRuns)
    .where(sql`((${agentRuns.queuedAt}::timestamptz) AT TIME ZONE 'UTC')::date = ${day}::date`);
  return row?.count ?? 0;
};

/**
 * Marks every `queued` or `running` run `failed` with outcome `interrupted`, in one statement, and
 * returns how many it changed (ADR 0030). Final runs are left alone.
 */
export const markUnfinishedRunsInterrupted = async (
  db: Database,
  finishedAt: string,
): Promise<number> => {
  const time = parse(TimestampSchema, finishedAt);
  const updated = await db
    .update(agentRuns)
    .set({ status: "failed", outcome: "interrupted", finishedAt: time })
    .where(inArray(agentRuns.status, ["queued", "running"]))
    .returning({ id: agentRuns.id });
  return updated.length;
};
