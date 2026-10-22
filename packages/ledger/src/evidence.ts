// Evidence export (ADR 0034): chosen audit-log rows, exactly as stored, with the chain verdict
// and head at export time, as one `countersign-evidence-v1` file. `checkEvidence` re-hashes
// every row in it with no database. A format change is a new version, never an edit of v1.

import { asc, auditLog, type Database, desc, sql } from "@countersign/db";
import { canonicalJson, type JsonValue, TimestampSchema } from "@countersign/mandate";
import { z } from "zod";
import { entryHash } from "./chain";
import { verifyLog } from "./log";

export const EVIDENCE_FORMAT = "countersign-evidence-v1";

export const EVIDENCE_CHECK =
  "Each entry's hash can be recomputed from its fields. Entries here aren't contiguous, so compare the head with ledger verify on the live log.";

export const EvidenceScopeSchema = z.strictObject({
  kind: z.enum(["intent", "capture"]),
  id: z.string().min(1),
});
export type EvidenceScope = z.infer<typeof EvidenceScopeSchema>;

const HeadSchema = z.strictObject({ seq: z.int(), hash: z.string() });

// The chain as a fresh verify saw it. `head` is null only for an empty log.
export const EvidenceChainSchema = z.strictObject({
  intact: z.boolean(),
  entry_count: z.int().nonnegative(),
  head: HeadSchema.nullable(),
  problem_count: z.int().nonnegative(),
});
export type EvidenceChain = z.infer<typeof EvidenceChainSchema>;

// One audit-log row as stored. The fields are plain strings, so a tampered value is reported
// by `checkEvidence` at its seq rather than rejected as an invalid file.
export const EvidenceEntrySchema = z.strictObject({
  seq: z.int(),
  entry_type: z.string(),
  ref_id: z.string().nullable(),
  at: z.string(),
  payload: z.string(),
  prev_hash: z.string(),
  hash: z.string(),
});
export type EvidenceEntry = z.infer<typeof EvidenceEntrySchema>;

export const EvidenceFileSchema = z.strictObject({
  format: z.literal(EVIDENCE_FORMAT),
  exported_at: TimestampSchema,
  scope: EvidenceScopeSchema,
  chain: EvidenceChainSchema,
  entries: z.array(EvidenceEntrySchema).min(1),
  check: z.literal(EVIDENCE_CHECK),
});
export type EvidenceFile = z.infer<typeof EvidenceFileSchema>;

// --- Building ------------------------------------------------------------------------------

const BuildInputSchema = z.strictObject({
  scope: EvidenceScopeSchema,
  seqs: z.array(z.int().positive()).min(1),
  exportedAt: TimestampSchema,
});
export type BuildEvidenceInput = z.input<typeof BuildInputSchema>;

const StoredRowSchema = z.object({
  seq: z.int(),
  entryType: z.string(),
  refId: z.string().nullable(),
  at: z.string(),
  payload: z.string(),
  prevHash: z.string(),
  hash: z.string(),
});

// Thrown when a chosen seq isn't in the log, so an export never silently drops a row.
export class EvidenceRowsMissingError extends Error {
  readonly missing: number[];
  constructor(missing: number[]) {
    super(`the audit log has no entry at seq ${missing.join(", ")}`);
    this.name = "EvidenceRowsMissingError";
    this.missing = missing;
  }
}

// The chosen rows exactly as stored, ascending by seq. Duplicate seqs are read once.
export async function readRowsBySeq(
  db: Database,
  seqs: readonly number[],
): Promise<EvidenceEntry[]> {
  const wanted = [...new Set(seqs)];
  if (wanted.length === 0) return [];
  const rows = await db
    .select()
    .from(auditLog)
    .where(
      sql`${auditLog.seq} in (${sql.join(
        wanted.map((seq) => sql`${seq}`),
        sql`, `,
      )})`,
    )
    .orderBy(asc(auditLog.seq));
  const parsed = z.array(StoredRowSchema).parse(rows);
  const found = new Set(parsed.map((row) => row.seq));
  const missing = wanted.filter((seq) => !found.has(seq)).sort((a, b) => a - b);
  if (missing.length > 0) throw new EvidenceRowsMissingError(missing);
  return parsed.map((row) => ({
    seq: row.seq,
    entry_type: row.entryType,
    ref_id: row.refId,
    at: row.at,
    payload: row.payload,
    prev_hash: row.prevHash,
    hash: row.hash,
  }));
}

// The last stored row, which is the head a broken verdict doesn't carry.
async function readLastRow(db: Database): Promise<{ seq: number; hash: string } | null> {
  const [last] = await db
    .select({ seq: auditLog.seq, hash: auditLog.hash })
    .from(auditLog)
    .orderBy(desc(auditLog.seq))
    .limit(1);
  return last === undefined ? null : HeadSchema.parse(last);
}

// Verifies the whole log afresh, then reads the chosen rows. Read-only.
export async function buildEvidence(
  db: Database,
  input: BuildEvidenceInput,
): Promise<EvidenceFile> {
  const { scope, seqs, exportedAt } = BuildInputSchema.parse(input);
  const verdict = await verifyLog(db);
  const chain: EvidenceChain = verdict.intact
    ? {
        intact: true,
        entry_count: verdict.entries,
        head: verdict.entries === 0 ? null : verdict.head,
        problem_count: 0,
      }
    : {
        intact: false,
        entry_count: verdict.entries,
        head: await readLastRow(db),
        problem_count: verdict.problems.length,
      };
  const entries = await readRowsBySeq(db, seqs);
  return EvidenceFileSchema.parse({
    format: EVIDENCE_FORMAT,
    exported_at: exportedAt,
    scope,
    chain,
    entries,
    check: EVIDENCE_CHECK,
  });
}

// --- Checking ------------------------------------------------------------------------------

export const EVIDENCE_PROBLEMS = ["SEQ_ORDER", "NOT_CANONICAL", "HASH_MISMATCH"] as const;
export type EvidenceProblemCode = (typeof EVIDENCE_PROBLEMS)[number];
export type EvidenceProblem = { seq: number; problem: EvidenceProblemCode; detail: string };

export type EvidenceCheck =
  | { ok: true; file: EvidenceFile; problems: EvidenceProblem[] }
  | { ok: false; error: string };

const short = (hash: string) => JSON.stringify(hash.slice(0, 12));

function checkEntry(
  entry: EvidenceEntry,
  report: (code: EvidenceProblemCode, detail: string) => void,
) {
  let payload: JsonValue;
  try {
    payload = JSON.parse(entry.payload);
  } catch {
    report("NOT_CANONICAL", "payload isn't valid JSON");
    return;
  }
  let canonical: string;
  try {
    canonical = canonicalJson(payload);
  } catch {
    report("NOT_CANONICAL", "payload holds a value canonical JSON can't hold");
    return;
  }
  if (canonical !== entry.payload) {
    report("NOT_CANONICAL", "payload isn't byte-for-byte its own canonical JSON");
  }
  let recomputed: string;
  try {
    recomputed = entryHash({
      seq: entry.seq,
      entryType: entry.entry_type,
      refId: entry.ref_id,
      at: entry.at,
      prevHash: entry.prev_hash,
      payload,
    });
  } catch {
    report("HASH_MISMATCH", "the entry's fields can't be hashed");
    return;
  }
  if (recomputed !== entry.hash) {
    report(
      "HASH_MISMATCH",
      `stored hash ${short(entry.hash)} isn't the recomputed ${short(recomputed)}`,
    );
  }
}

// Reads an evidence file with zod and re-hashes every entry. Returns every problem by seq, or
// an error sentence when the value isn't a v1 evidence file. Never throws.
export function checkEvidence(value: unknown): EvidenceCheck {
  const parsed = EvidenceFileSchema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue && issue.path.length > 0 ? ` at ${issue.path.join(".")}` : "";
    return { ok: false, error: `The file isn't a ${EVIDENCE_FORMAT} file${where}.` };
  }
  const file = parsed.data;
  const problems: EvidenceProblem[] = [];
  let previous: number | undefined;
  for (const entry of file.entries) {
    const report = (problem: EvidenceProblemCode, detail: string) =>
      problems.push({ seq: entry.seq, problem, detail });
    if (previous !== undefined && entry.seq <= previous) {
      report(
        "SEQ_ORDER",
        entry.seq === previous
          ? `seq ${entry.seq} appears twice`
          : `seq ${entry.seq} comes after seq ${previous}`,
      );
    }
    previous = previous === undefined ? entry.seq : Math.max(previous, entry.seq);
    try {
      checkEntry(entry, report);
    } catch {
      report("HASH_MISMATCH", "the entry can't be checked");
    }
  }
  return { ok: true, file, problems };
}
