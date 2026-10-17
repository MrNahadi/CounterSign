import {
  asc,
  auditLog,
  createTestDatabase,
  type Database,
  type DatabaseHandle,
  sql,
} from "@countersign/db";
import { canonicalJson } from "@countersign/mandate";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  AppendRejectedError,
  AUDIT_LOG_LOCK_KEY,
  appendEntries,
  appendEntry,
  type ChainRow,
  type EntryInput,
  entryHash,
  GENESIS_HASH,
  verifyChain,
  verifyLog,
  withAuditLog,
} from "../src/index";

const AT = "2026-10-17T09:00:00.000Z";

const decision = (n: number): EntryInput => ({
  entryType: "decision",
  refId: `int_${n}`,
  at: AT,
  payload: { n, note: "illustrative", amount: { minor: 1250 * n, currency: "USD" } },
});

const storedRows = async (db: Database): Promise<ChainRow[]> =>
  db.select().from(auditLog).orderBy(asc(auditLog.seq));

// How many advisory locks on the ledger's key this session holds right now.
const heldLocks = async (db: Database): Promise<number> => {
  const [result] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(sql`pg_locks`)
    .where(sql`locktype = 'advisory' AND objsubid = 1 AND granted
      AND ((classid::bigint << 32) | objid::bigint) = ${sql.raw(AUDIT_LOG_LOCK_KEY.toString())}::bigint`);
  return result?.n ?? -1;
};

describe("appending to and verifying the audit_log table", () => {
  let handle: DatabaseHandle;
  let db: Database;

  beforeAll(async () => {
    handle = await createTestDatabase();
    db = handle.db;
  });

  beforeEach(async () => {
    await db.execute(sql`TRUNCATE audit_log`);
  });

  afterAll(async () => {
    await handle.close();
  });

  it("exports one fixed bigint lock key", () => {
    expect(typeof AUDIT_LOG_LOCK_KEY).toBe("bigint");
  });

  it("takes the advisory lock for the transaction, and several appends share it", async () => {
    expect(await heldLocks(db)).toBe(0);
    const seen = await withAuditLog(db, async (log) => {
      const locksAtStart = await heldLocks(log.tx);
      const first = await log.append(decision(1));
      const second = await log.append(decision(2));
      return { locksAtStart, locksAfter: await heldLocks(log.tx), first, second };
    });
    expect(seen.locksAtStart).toBe(1);
    expect(seen.locksAfter).toBe(1);
    expect(seen.first.seq).toBe(1);
    expect(seen.second.seq).toBe(2);
    expect(seen.second.prevHash).toBe(seen.first.hash);
    // A transaction-level lock is released when the transaction ends.
    expect(await heldLocks(db)).toBe(0);
  });

  it("writes the appends in one transaction together or not at all", async () => {
    await appendEntry(db, decision(1));
    const failure = await withAuditLog(db, async (log) => {
      await log.append(decision(2));
      await log.append({ ...decision(3), entryType: "execution.made.up" });
    }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AppendRejectedError);
    expect((failure as AppendRejectedError).rejection.problem).toBe("UNKNOWN_ENTRY_TYPE");
    expect((await storedRows(db)).map((row) => row.seq)).toEqual([1]);

    const thrown = await withAuditLog(db, async (log) => {
      await log.append(decision(2));
      throw new Error("the caller gave up");
    }).catch((error: unknown) => error);
    expect(thrown).toBeInstanceOf(Error);
    expect((await storedRows(db)).map((row) => row.seq)).toEqual([1]);
  });

  it("gives three appends seq 1 to 3, linked from the genesis hash, and verifyLog passes", async () => {
    const results = [];
    for (const n of [1, 2, 3]) results.push(await appendEntry(db, decision(n)));
    const entries = results.map((result) => {
      if (!result.ok) throw new Error(result.rejection.detail);
      return result.entry;
    });
    expect(entries.map((entry) => entry.seq)).toEqual([1, 2, 3]);
    expect(entries[0]?.prevHash).toBe(GENESIS_HASH);
    expect(entries[1]?.prevHash).toBe(entries[0]?.hash);
    expect(entries[2]?.prevHash).toBe(entries[1]?.hash);

    const rows = await storedRows(db);
    expect(rows).toEqual(entries);
    for (const row of rows) {
      expect(row.payload).toBe(canonicalJson(JSON.parse(row.payload)));
      expect(row.hash).toBe(entryHash({ ...row, payload: JSON.parse(row.payload) }));
      expect(row.hash).toMatch(/^[0-9a-f]{64}$/);
    }

    expect(await verifyLog(db)).toEqual({
      intact: true,
      entries: 3,
      head: { seq: 3, hash: entries[2]?.hash },
    });
  });

  it("returns the stored entry from a batch of appends in order", async () => {
    const result = await appendEntries(db, [decision(1), decision(2)]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.entries).toEqual(await storedRows(db));
  });

  it("gives twenty concurrent appends seq 1 to 20 with no gap, and verifyLog passes", async () => {
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, index) => appendEntry(db, decision(index + 1))),
    );
    expect(results.every((result) => result.ok)).toBe(true);
    const rows = await storedRows(db);
    expect(rows.map((row) => row.seq)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
    const verdict = await verifyLog(db);
    expect(verdict).toEqual({
      intact: true,
      entries: 20,
      head: { seq: 20, hash: rows[19]?.hash },
    });
  });

  describe("rejects bad input and leaves the table unchanged", () => {
    const cases: [string, EntryInput, string][] = [
      ["an unknown entry type", { ...decision(2), entryType: "approval" }, "UNKNOWN_ENTRY_TYPE"],
      ["a time with no offset", { ...decision(2), at: "2026-10-17T09:00:00" }, "BAD_TIMESTAMP"],
      ["a time that isn't one", { ...decision(2), at: "yesterday" }, "BAD_TIMESTAMP"],
      ["a fractional amount", { ...decision(2), payload: { minor: 12.5 } }, "BAD_PAYLOAD"],
      ["a payload JSON can't hold", { ...decision(2), payload: { at: 10n } }, "BAD_PAYLOAD"],
      [
        "a ref with a lone surrogate",
        { ...decision(2), refId: `int_${String.fromCharCode(0xd800)}` },
        "BAD_REF",
      ],
    ];

    it.each(cases)("%s", async (_name, input, problem) => {
      await appendEntry(db, decision(1));
      const before = await storedRows(db);

      const single = await appendEntry(db, input);
      expect(single).toMatchObject({ ok: false, rejection: { problem } });

      const batch = await appendEntries(db, [decision(2), input]);
      expect(batch).toMatchObject({ ok: false, index: 1, rejection: { problem } });

      expect(await storedRows(db)).toEqual(before);
    });

    it("an entry that isn't an object at all", async () => {
      const result = await appendEntry(db, "decision" as unknown as EntryInput);
      expect(result.ok).toBe(false);
      expect(await storedRows(db)).toEqual([]);
    });
  });

  describe("verifyLog", () => {
    it("reports an empty log intact, with the genesis hash as its head", async () => {
      expect(await verifyLog(db, { pageSize: 2 })).toEqual({
        intact: true,
        entries: 0,
        head: { seq: 0, hash: GENESIS_HASH },
      });
    });

    it("reads in seq order, in pages, and agrees with verifyChain on an intact log", async () => {
      // Rows go in out of order; verifyLog must still walk them by seq.
      const built: ChainRow[] = [];
      let prevHash = GENESIS_HASH;
      for (let seq = 1; seq <= 7; seq += 1) {
        const payload = { seq };
        const hash = entryHash({
          seq,
          entryType: "decision",
          refId: null,
          at: AT,
          prevHash,
          payload,
        });
        built.push({
          seq,
          entryType: "decision",
          refId: null,
          at: AT,
          payload: canonicalJson(payload),
          prevHash,
          hash,
        });
        prevHash = hash;
      }
      await db.insert(auditLog).values([...built].reverse());

      for (const pageSize of [1, 2, 3, 7, 100]) {
        expect(await verifyLog(db, { pageSize })).toEqual(verifyChain(built));
      }
      expect(await verifyLog(db, { pageSize: 2 })).toMatchObject({
        intact: true,
        entries: 7,
        head: { seq: 7 },
      });
    });

    it("reports bad rows across page boundaries just as verifyChain does", async () => {
      await appendEntries(db, [decision(1), decision(2), decision(3), decision(4)]);
      const [tail] = (await storedRows(db)).slice(-1);
      // A forged row 5 that doesn't link, with a payload that isn't canonical, then a gap.
      await db.insert(auditLog).values([
        {
          seq: 5,
          entryType: "decision",
          refId: "int_5",
          at: AT,
          payload: '{ "n": 5 }',
          prevHash: "f".repeat(64),
          hash: "e".repeat(64),
        },
        {
          seq: 7,
          entryType: "settlement",
          refId: null,
          at: "not a time",
          payload: "{}",
          prevHash: tail?.hash ?? "",
          hash: "d".repeat(64),
        },
      ]);

      const rows = await storedRows(db);
      const expected = verifyChain(rows);
      expect(expected.intact).toBe(false);
      for (const pageSize of [1, 2, 3, 50]) {
        expect(await verifyLog(db, { pageSize })).toEqual(expected);
      }
      if (expected.intact) return;
      expect(new Set(expected.problems.map((problem) => problem.seq))).toEqual(new Set([5, 7]));
    });

    it("refuses a page size that isn't a positive integer", async () => {
      await expect(verifyLog(db, { pageSize: 0 })).rejects.toThrow();
      await expect(verifyLog(db, { pageSize: 1.5 })).rejects.toThrow();
    });
  });
});
