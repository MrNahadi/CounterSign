// Brief §11's tamper test: an attacker with raw SQL access disables the append-only trigger,
// edits the table, and verifyLog still names the row and the problem.
import {
  asc,
  auditLog,
  createTestDatabase,
  type Database,
  type DatabaseHandle,
  sql,
} from "@countersign/db";
import { canonicalJson } from "@countersign/mandate";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  appendEntries,
  type ChainProblemCode,
  type ChainRow,
  type ChainVerdict,
  type EntryInput,
  entryHash,
  verifyLog,
} from "../src/index";

const AT = "2026-10-17T09:00:00.000Z";

const payloadOf = (n: number) => ({
  n,
  note: "illustrative",
  amount: { minor: 1250 * n, currency: "USD" },
});

const decision = (n: number): EntryInput => ({
  entryType: "decision",
  refId: `int_${n}`,
  at: AT,
  payload: payloadOf(n),
});

const storedRows = async (db: Database): Promise<ChainRow[]> =>
  db.select().from(auditLog).orderBy(asc(auditLog.seq));

const rowAt = (rows: readonly ChainRow[], seq: number): ChainRow => {
  const row = rows.find((candidate) => candidate.seq === seq);
  if (!row) throw new Error(`no row at seq ${seq}`);
  return row;
};

const disableTrigger = (db: Database) =>
  db.execute(sql`ALTER TABLE audit_log DISABLE TRIGGER audit_log_append_only`);
const enableTrigger = (db: Database) =>
  db.execute(sql`ALTER TABLE audit_log ENABLE TRIGGER audit_log_append_only`);

const setPayload = (db: Database, seq: number, payload: string) =>
  db.execute(sql`UPDATE audit_log SET payload = ${payload} WHERE seq = ${seq}`);

// The problems as [seq, problem] pairs, in the order verifyLog reports them.
const found = (verdict: ChainVerdict): [number, ChainProblemCode][] =>
  verdict.intact ? [] : verdict.problems.map((problem) => [problem.seq, problem.problem]);

// Drizzle wraps driver errors; the database's own message is on the cause.
const failureText = async (attempt: Promise<unknown>): Promise<string> => {
  const error = await attempt.then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  if (error === undefined) return "it succeeded";
  const cause = error instanceof Error && error.cause instanceof Error ? error.cause.message : "";
  return `${error instanceof Error ? error.message : String(error)} ${cause}`;
};

type Tamper = {
  name: string;
  touches: number[];
  // Rows the tamper adds, which the restore removes.
  adds?: number[];
  tamper: (db: Database, original: readonly ChainRow[]) => Promise<unknown>;
  expected: [number, ChainProblemCode][];
};

const tampers: Tamper[] = [
  {
    name: "editing one row's payload is HASH_MISMATCH at that seq, and nothing else",
    touches: [3],
    tamper: (db) => setPayload(db, 3, canonicalJson({ ...payloadOf(3), n: 300 })),
    expected: [[3, "HASH_MISMATCH"]],
  },
  {
    name: "editing a payload and recomputing its hash is BROKEN_LINK at the next seq",
    touches: [3],
    tamper: (db, original) => {
      const row = rowAt(original, 3);
      const forged = { ...payloadOf(3), amount: { minor: 999_999, currency: "USD" } };
      const hash = entryHash({ ...row, payload: forged });
      return db.execute(
        sql`UPDATE audit_log SET payload = ${canonicalJson(forged)}, hash = ${hash} WHERE seq = 3`,
      );
    },
    expected: [[4, "BROKEN_LINK"]],
  },
  {
    name: "deleting a middle row is SEQ_GAP and BROKEN_LINK",
    touches: [3],
    tamper: (db) => db.execute(sql`DELETE FROM audit_log WHERE seq = 3`),
    expected: [
      [4, "SEQ_GAP"],
      [4, "BROKEN_LINK"],
    ],
  },
  {
    name: "swapping two rows' payloads is caught at both positions",
    touches: [2, 4],
    tamper: async (db, original) => {
      await setPayload(db, 2, rowAt(original, 4).payload);
      await setPayload(db, 4, rowAt(original, 2).payload);
    },
    expected: [
      [2, "HASH_MISMATCH"],
      [4, "HASH_MISMATCH"],
    ],
  },
  {
    name: "the same JSON value with different spacing is NOT_CANONICAL",
    touches: [3],
    tamper: (db) => setPayload(db, 3, JSON.stringify(payloadOf(3), null, 2)),
    expected: [[3, "NOT_CANONICAL"]],
  },
  {
    name: "the same JSON value with a different key order is NOT_CANONICAL",
    touches: [3],
    tamper: (db, original) => {
      const value = JSON.parse(rowAt(original, 3).payload) as Record<string, unknown>;
      const reordered = Object.fromEntries(Object.entries(value).reverse());
      return setPayload(db, 3, JSON.stringify(reordered));
    },
    expected: [[3, "NOT_CANONICAL"]],
  },
  {
    name: "a row slipped in before the first, at seq 0, is SEQ_GAP and BROKEN_LINK",
    touches: [],
    adds: [0],
    tamper: (db) => {
      const forged = {
        seq: 0,
        entryType: "decision",
        refId: "int_0",
        at: AT,
        prevHash: "f".repeat(64),
      };
      const hash = entryHash({ ...forged, payload: payloadOf(0) });
      return db.insert(auditLog).values({ ...forged, payload: canonicalJson(payloadOf(0)), hash });
    },
    expected: [
      [0, "SEQ_GAP"],
      [0, "BROKEN_LINK"],
      [1, "BROKEN_LINK"],
    ],
  },
];

describe("the tamper test: verifyLog on a table edited with raw SQL", () => {
  let handle: DatabaseHandle;
  let db: Database;
  let original: ChainRow[];
  let intact: ChainVerdict;

  beforeAll(async () => {
    handle = await createTestDatabase();
    db = handle.db;
  });

  beforeEach(async () => {
    await db.execute(sql`TRUNCATE audit_log`);
    const appended = await appendEntries(db, [1, 2, 3, 4, 5].map(decision));
    if (!appended.ok) throw new Error(appended.rejection.detail);
    original = await storedRows(db);
    intact = await verifyLog(db);
  });

  afterEach(async () => {
    await enableTrigger(db);
  });

  afterAll(async () => {
    await handle.close();
  });

  it("starts from an intact log of five entries that refuses UPDATE", async () => {
    expect(intact).toEqual({ intact: true, entries: 5, head: { seq: 5, hash: original[4]?.hash } });
    expect(await failureText(setPayload(db, 3, "{}"))).toMatch(/audit_log is append-only/);
  });

  it.each(tampers)("$name", async ({ touches, adds = [], tamper, expected }) => {
    await disableTrigger(db);
    await tamper(db, original);
    expect(await storedRows(db)).not.toEqual(original);

    for (const pageSize of [2, 500]) {
      const verdict = await verifyLog(db, { pageSize });
      expect(verdict.intact).toBe(false);
      expect(found(verdict)).toEqual(expected);
    }

    // Put the original rows back, then turn the trigger on again.
    for (const seq of touches) {
      await db.execute(sql`DELETE FROM audit_log WHERE seq = ${seq}`);
      await db.insert(auditLog).values(rowAt(original, seq));
    }
    for (const seq of adds) await db.execute(sql`DELETE FROM audit_log WHERE seq = ${seq}`);
    await enableTrigger(db);

    expect(await storedRows(db)).toEqual(original);
    expect(await verifyLog(db)).toEqual(intact);
    expect(await failureText(setPayload(db, 3, "{}"))).toMatch(/audit_log is append-only/);
    expect(await failureText(db.execute(sql`DELETE FROM audit_log WHERE seq = 3`))).toMatch(
      /audit_log is append-only/,
    );
    expect(await storedRows(db)).toEqual(original);
  });
});
