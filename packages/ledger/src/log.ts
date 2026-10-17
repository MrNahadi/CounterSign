// Appending to and verifying the audit_log table (ADRs 0003 and 0022). The chain logic is in
// chain.ts; this file adds the lock, the tail read, the insert and the paged walk.

import { asc, auditLog, type Database, desc, gt, sql } from "@countersign/db";
import { type JsonValue, TimestampSchema } from "@countersign/mandate";
import { z } from "zod";
import {
  type ChainRow,
  type ChainVerdict,
  createChainVerifier,
  ENTRY_TYPES,
  type EntryType,
  entryHash,
  GENESIS_HASH,
  isEntryType,
  preparePayload,
} from "./chain";

// The one advisory lock key every audit-log append takes. Later phases' appends share it.
export const AUDIT_LOG_LOCK_KEY = 4_004_040_404n;

// What a caller asks to append. The ledger assigns `seq`, `prevHash` and `hash`.
export type EntryInput = {
  entryType: string;
  refId: string | null;
  at: string;
  payload: unknown;
};

export const APPEND_REJECTIONS = [
  "BAD_INPUT",
  "UNKNOWN_ENTRY_TYPE",
  "BAD_TIMESTAMP",
  "BAD_REF",
  "BAD_PAYLOAD",
] as const;
export type AppendRejectionCode = (typeof APPEND_REJECTIONS)[number];
export type AppendRejection = { problem: AppendRejectionCode; detail: string };

// Thrown by an append inside `withAuditLog`, so the whole transaction rolls back.
export class AppendRejectedError extends Error {
  readonly rejection: AppendRejection;
  constructor(rejection: AppendRejection) {
    super(`${rejection.problem}: ${rejection.detail}`);
    this.name = "AppendRejectedError";
    this.rejection = rejection;
  }
}

const EntryInputSchema = z.object({
  entryType: z.string(),
  refId: z.string().nullable(),
  at: z.string(),
  payload: z.unknown(),
});

type PreparedEntry = {
  entryType: EntryType;
  refId: string | null;
  at: string;
  value: JsonValue;
  canonical: string;
};

type Prepared = { ok: true; entry: PreparedEntry } | { ok: false; rejection: AppendRejection };

const reject = (problem: AppendRejectionCode, detail: string): Prepared => ({
  ok: false,
  rejection: { problem, detail },
});

// Checks everything about an entry that doesn't need the table, before anything is written.
function prepareEntry(input: unknown): Prepared {
  const parsed = EntryInputSchema.safeParse(input);
  if (!parsed.success) {
    return reject("BAD_INPUT", "an entry needs an entry type, a ref, a time and a payload");
  }
  const { entryType, refId, at, payload } = parsed.data;
  if (!isEntryType(entryType)) {
    return reject(
      "UNKNOWN_ENTRY_TYPE",
      `entry type ${JSON.stringify(entryType.slice(0, 64))} isn't one of ${ENTRY_TYPES.join(", ")}`,
    );
  }
  if (!TimestampSchema.safeParse(at).success) {
    return reject("BAD_TIMESTAMP", "at isn't an ISO 8601 time with seconds and an offset");
  }
  // The ref goes into the hashed envelope as it is, so it must be well-formed already.
  if (refId !== null && !refId.isWellFormed()) {
    return reject("BAD_REF", "the ref holds a lone surrogate");
  }
  const prepared = preparePayload(payload);
  if (!prepared.ok) return reject("BAD_PAYLOAD", prepared.detail);
  return {
    ok: true,
    entry: { entryType, refId, at, value: prepared.value, canonical: prepared.canonical },
  };
}

// --- Appending -----------------------------------------------------------------------------

export type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

export type AuditLogWriter = {
  // The open transaction, for reads that must see this transaction's appends.
  readonly tx: Transaction;
  // Appends one entry at the tail. A rejected entry throws AppendRejectedError, which rolls
  // back every append in the transaction unless the caller catches it.
  append(input: EntryInput): Promise<ChainRow>;
};

const LOCK_SQL = sql`SELECT pg_advisory_xact_lock(${sql.raw(AUDIT_LOG_LOCK_KEY.toString())}::bigint)`;

async function appendPrepared(tx: Transaction, entry: PreparedEntry): Promise<ChainRow> {
  const [tail] = await tx
    .select({ seq: auditLog.seq, hash: auditLog.hash })
    .from(auditLog)
    .orderBy(desc(auditLog.seq))
    .limit(1);
  const seq = (tail?.seq ?? 0) + 1;
  const prevHash = tail?.hash ?? GENESIS_HASH;
  const { entryType, refId, at, value, canonical } = entry;
  const hash = entryHash({ seq, entryType, refId, at, prevHash, payload: value });
  const row: ChainRow = { seq, entryType, refId, at, payload: canonical, prevHash, hash };
  await tx.insert(auditLog).values(row);
  return row;
}

// Runs `work` in one READ COMMITTED transaction that holds the ledger's advisory lock from
// its first statement, so its appends and reads see a tail no other appender can move.
export async function withAuditLog<T>(
  db: Database,
  work: (log: AuditLogWriter) => Promise<T>,
): Promise<T> {
  return db.transaction(
    async (tx) => {
      await tx.execute(LOCK_SQL);
      const writer: AuditLogWriter = {
        tx,
        async append(input) {
          const prepared = prepareEntry(input);
          if (!prepared.ok) throw new AppendRejectedError(prepared.rejection);
          return appendPrepared(tx, prepared.entry);
        },
      };
      return work(writer);
    },
    { isolationLevel: "read committed" },
  );
}

export type AppendEntriesResult =
  | { ok: true; entries: ChainRow[] }
  | { ok: false; index: number; rejection: AppendRejection };

// Appends several entries in one transaction, in order. If any is rejected, nothing is written.
export async function appendEntries(
  db: Database,
  inputs: readonly EntryInput[],
): Promise<AppendEntriesResult> {
  const prepared: PreparedEntry[] = [];
  for (const [index, input] of inputs.entries()) {
    const result = prepareEntry(input);
    if (!result.ok) return { ok: false, index, rejection: result.rejection };
    prepared.push(result.entry);
  }
  const entries = await withAuditLog(db, async (log) => {
    const written: ChainRow[] = [];
    for (const entry of prepared) written.push(await appendPrepared(log.tx, entry));
    return written;
  });
  return { ok: true, entries };
}

export type AppendEntryResult =
  | { ok: true; entry: ChainRow }
  | { ok: false; rejection: AppendRejection };

// Appends one entry in its own transaction.
export async function appendEntry(db: Database, input: EntryInput): Promise<AppendEntryResult> {
  const result = await appendEntries(db, [input]);
  if (!result.ok) return { ok: false, rejection: result.rejection };
  const [entry] = result.entries;
  if (entry === undefined) throw new Error("an append wrote no entry");
  return { ok: true, entry };
}

// --- Verifying -----------------------------------------------------------------------------

const StoredRowSchema = z.object({
  seq: z.int(),
  entryType: z.string(),
  refId: z.string().nullable(),
  at: z.string(),
  payload: z.string(),
  prevHash: z.string(),
  hash: z.string(),
});

// A row whose shape is wrong is still checked, never thrown on: a field of the wrong type
// becomes a value the chain checks report (an empty string, or NaN for seq).
function asChainRow(raw: Record<string, unknown>): ChainRow {
  const parsed = StoredRowSchema.safeParse(raw);
  if (parsed.success) return parsed.data;
  const text = (value: unknown) => (typeof value === "string" ? value : "");
  return {
    seq: Number.isSafeInteger(raw.seq) ? (raw.seq as number) : Number.NaN,
    entryType: text(raw.entryType),
    refId: typeof raw.refId === "string" || raw.refId === null ? raw.refId : "",
    at: text(raw.at),
    payload: text(raw.payload),
    prevHash: text(raw.prevHash),
    hash: text(raw.hash),
  };
}

const VerifyOptionsSchema = z.object({ pageSize: z.int().positive().default(500) });
export type VerifyLogOptions = { pageSize?: number };

// Re-walks the whole table in seq order, a page at a time, with the checks of verifyChain.
// Never throws on what the rows hold; a database that can't be read throws.
export async function verifyLog(
  db: Database,
  options: VerifyLogOptions = {},
): Promise<ChainVerdict> {
  const { pageSize } = VerifyOptionsSchema.parse(options);
  const verifier = createChainVerifier();
  let after = 0;
  for (;;) {
    const page: Record<string, unknown>[] = await db
      .select()
      .from(auditLog)
      .where(gt(auditLog.seq, after))
      .orderBy(asc(auditLog.seq))
      .limit(pageSize);
    for (const raw of page) verifier.add(asChainRow(raw));
    const last = page.at(-1)?.seq;
    // A seq that can't be read exactly can't anchor the next page, so the walk stops there.
    if (page.length < pageSize || typeof last !== "number" || !Number.isSafeInteger(last)) break;
    after = last;
  }
  return verifier.verdict();
}
