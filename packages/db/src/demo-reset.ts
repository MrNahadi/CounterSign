// The demo reset's database work (ADR 0042): lock, count and clear the six tables the demo writes,
// carrying each UTC date's run and draft count into `cleared_run_counts` so a reset never raises
// the day's run cap. `seed_orders` and `carrier_shipments` are never touched here.

import { TimestampSchema } from "@countersign/mandate";
import { count, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import type { Database } from "./client";
import {
  agentRuns,
  auditLog,
  clearedRunCounts,
  disputeDrafts,
  evidenceDocuments,
  ticketAttachments,
  tickets,
} from "./schema";

/** The transaction `Database["transaction"]`'s callback receives. */
export type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

/** What the reset clears with, and what it reads before. */
export type DemoReader = Database | Transaction;

/** What `clearDemoTables` cleared: the old log's last row and each table's row count. */
export type ClearedTables = {
  entries: number;
  head: { seq: number; hash: string } | null;
  tickets: number;
  attachments: number;
  runs: number;
  drafts: number;
  documents: number;
};

const UNFINISHED = ["queued", "running"];

// The margin `runsQueuedSince` allows for clock skew between the gate and Resolve.
const QUEUED_SINCE_MARGIN = sql`interval '5 seconds'`;

const DateSchema = z.iso.date();

const countRows = async (
  reader: DemoReader,
  table:
    | typeof auditLog
    | typeof tickets
    | typeof ticketAttachments
    | typeof agentRuns
    | typeof disputeDrafts
    | typeof evidenceDocuments,
): Promise<number> => {
  const [row] = await reader.select({ n: count() }).from(table);
  return row?.n ?? 0;
};

/**
 * Takes the six demo tables in ACCESS EXCLUSIVE mode, waiting at most 5 seconds. A lock not
 * granted in time fails the transaction with Postgres code `55P03`.
 */
export const lockDemoTables = async (tx: Transaction): Promise<void> => {
  await tx.execute(sql`SET LOCAL lock_timeout = '5s'`);
  await tx.execute(
    sql`LOCK TABLE audit_log, tickets, ticket_attachments, agent_runs, dispute_drafts, evidence_documents IN ACCESS EXCLUSIVE MODE`,
  );
};

/** How many runs and dispute drafts are `queued` or `running`. */
export const countUnfinishedWork = async (
  reader: DemoReader,
): Promise<{ runs: number; drafts: number }> => {
  const [runs] = await reader
    .select({ n: count() })
    .from(agentRuns)
    .where(inArray(agentRuns.status, UNFINISHED));
  const [drafts] = await reader
    .select({ n: count() })
    .from(disputeDrafts)
    .where(inArray(disputeDrafts.status, UNFINISHED));
  return { runs: runs?.n ?? 0, drafts: drafts?.n ?? 0 };
};

/**
 * How many runs were queued at or after `at` less 5 seconds, any status. Compared as instants,
 * not text. The margin covers clock skew between the gate and Resolve.
 */
export const runsQueuedSince = async (reader: DemoReader, at: string): Promise<number> => {
  const since = TimestampSchema.parse(at);
  const [row] = await reader
    .select({ n: count() })
    .from(agentRuns)
    .where(
      sql`${agentRuns.queuedAt}::timestamptz >= (${since}::timestamptz - ${QUEUED_SINCE_MARGIN})`,
    );
  return row?.n ?? 0;
};

/**
 * Reads the audit log's last row and the six tables' counts, adds each UTC date's run and draft
 * count (every status, by `queued_at`) to `cleared_run_counts`, then truncates the six tables in
 * one statement. Run it inside the transaction that holds `lockDemoTables`.
 */
export const clearDemoTables = async (tx: Transaction): Promise<ClearedTables> => {
  const [last] = await tx
    .select({ seq: auditLog.seq, hash: auditLog.hash })
    .from(auditLog)
    .orderBy(desc(auditLog.seq))
    .limit(1);
  const cleared: ClearedTables = {
    entries: await countRows(tx, auditLog),
    head: last ? { seq: last.seq, hash: last.hash } : null,
    tickets: await countRows(tx, tickets),
    attachments: await countRows(tx, ticketAttachments),
    runs: await countRows(tx, agentRuns),
    drafts: await countRows(tx, disputeDrafts),
    documents: await countRows(tx, evidenceDocuments),
  };
  await tx.execute(sql`
    INSERT INTO cleared_run_counts (utc_date, runs)
    SELECT d, count(*)::int FROM (
      SELECT ((queued_at::timestamptz) AT TIME ZONE 'UTC')::date::text AS d FROM agent_runs
      UNION ALL
      SELECT ((queued_at::timestamptz) AT TIME ZONE 'UTC')::date::text FROM dispute_drafts
    ) AS q
    GROUP BY d
    ON CONFLICT (utc_date) DO UPDATE SET runs = cleared_run_counts.runs + excluded.runs`);
  await tx.execute(
    sql`TRUNCATE TABLE audit_log, tickets, ticket_attachments, agent_runs, dispute_drafts, evidence_documents`,
  );
  return cleared;
};

/** How many runs and drafts earlier resets cleared from this UTC date (`YYYY-MM-DD`), or 0. */
export const countClearedRunsOnDate = async (db: Database, date: string): Promise<number> => {
  const day = DateSchema.parse(date);
  const [row] = await db
    .select({ runs: clearedRunCounts.runs })
    .from(clearedRunCounts)
    .where(eq(clearedRunCounts.utcDate, day))
    .limit(1);
  return row?.runs ?? 0;
};
