// Live check for ADR 0003's advisory lock, which PGlite's single connection can't exercise.
// Runs only under LIVE=1 with DATABASE_URL set. It works in a throwaway schema with a random
// name, migrates into it and drops it afterwards, so it never touches existing tables.

import { randomBytes } from "node:crypto";
import {
  asc,
  auditLog,
  type DatabaseHandle,
  failureReason,
  openPostgres,
  resolveDatabaseTarget,
  sql,
} from "@countersign/db";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { appendEntry, type EntryInput, verifyLog } from "../src/index";

const LiveEnvSchema = z.object({ LIVE: z.literal("1") });
const target = resolveDatabaseTarget(process.env, undefined);
const live =
  LiveEnvSchema.safeParse({ LIVE: process.env.LIVE }).success && target.kind === "postgres";

const POOL_SIZE = 8;
const APPENDS = 20;
const AT = "2026-10-17T09:00:00.000Z";

const decision = (n: number): EntryInput => ({
  entryType: "decision",
  refId: `int_live_${n}`,
  at: AT,
  payload: { n, note: "illustrative", amount: { minor: 1250 * n, currency: "USD" } },
});

// Errors from the driver are reduced to a reason with no connection string or password in it.
// Assertion failures carry only test values, so they pass through for their diff.
const redacted = (error: unknown): unknown => {
  if (error instanceof Error && error.name === "AssertionError") return error;
  return new Error(failureReason(error, target));
};

const present = async (handle: DatabaseHandle, name: string): Promise<boolean> => {
  const [row] = await handle.db
    .select({ present: sql<boolean>`to_regclass(${name}) IS NOT NULL` })
    .from(sql`(VALUES (1)) AS probe (n)`);
  return row?.present === true;
};

describe.skipIf(!live)("live Postgres (needs LIVE=1 and DATABASE_URL)", () => {
  it(`chains ${APPENDS} concurrent appends over a pool of ${POOL_SIZE} without a gap`, async () => {
    if (target.kind !== "postgres") throw new Error("DATABASE_URL is not set");
    const schemaName = `countersign_live_${randomBytes(6).toString("hex")}`;
    const quoted = sql.raw(`"${schemaName}"`);
    const admin = openPostgres(target.url, { max: 1 });
    let pool: DatabaseHandle | undefined;
    let created = false;
    const failures: unknown[] = [];
    try {
      await admin.db.execute(sql`CREATE SCHEMA ${quoted}`);
      created = true;
      pool = openPostgres(target.url, { schema: schemaName, max: POOL_SIZE });
      expect(await pool.migrate()).toBeGreaterThan(0);
      expect(await present(pool, `"${schemaName}".audit_log`)).toBe(true);
      expect(await present(pool, `"${schemaName}".__drizzle_migrations`)).toBe(true);

      const db = pool.db;
      const results = await Promise.all(
        Array.from({ length: APPENDS }, (_, index) => appendEntry(db, decision(index + 1))),
      );
      expect(results.map((result) => (result.ok ? "ok" : result.rejection.problem))).toEqual(
        Array.from({ length: APPENDS }, () => "ok"),
      );

      const rows = await db.select().from(auditLog).orderBy(asc(auditLog.seq));
      expect(rows.map((row) => row.seq)).toEqual(Array.from({ length: APPENDS }, (_, i) => i + 1));
      expect(await verifyLog(db, { pageSize: 7 })).toEqual({
        intact: true,
        entries: APPENDS,
        head: { seq: APPENDS, hash: rows[APPENDS - 1]?.hash },
      });
    } catch (error) {
      failures.push(error);
    }
    // The schema is dropped whatever happened above. A failed drop fails the test too, so a
    // leftover schema is never silent.
    await pool?.close().catch(() => {});
    if (created) {
      await admin.db.execute(sql`DROP SCHEMA ${quoted} CASCADE`).catch((error: unknown) => {
        failures.push(error);
      });
    }
    await admin.close().catch(() => {});
    if (failures.length > 0) throw redacted(failures[0]);
  }, 60_000);
});
