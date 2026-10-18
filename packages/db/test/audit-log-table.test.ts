import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  expectTypeOf,
  it,
} from "vitest";
import {
  auditLog,
  createTestDatabase,
  type Database,
  type DatabaseHandle,
  type NewAuditLogRow,
  openDatabase,
  openPgliteDirectory,
  openPostgres,
} from "../src/index";

const GENESIS = "0".repeat(64);
const hex = (char: string) => char.repeat(64);

const row = (seq: number, prevHash: string, hash: string): NewAuditLogRow => ({
  seq,
  entryType: "decision",
  refId: `int_${seq}`,
  at: "2026-10-17T09:00:00.000Z",
  payload: '{"seq":1}',
  prevHash,
  hash,
});

// Drizzle wraps driver errors; the database's own message is on the cause.
const failureText = async (run: () => Promise<unknown>): Promise<string> => {
  try {
    await run();
  } catch (error) {
    const cause = error instanceof Error && error.cause instanceof Error ? error.cause.message : "";
    return `${error instanceof Error ? error.message : String(error)} ${cause}`;
  }
  throw new Error("expected the statement to fail");
};

const count = async (db: Database) => (await db.select().from(auditLog)).length;

// One fresh database for this block; each test starts from a one-row table.
describe("the audit_log table on a fresh in-memory PGlite", () => {
  let handle: DatabaseHandle;

  beforeAll(async () => {
    handle = await createTestDatabase();
  });

  beforeEach(async () => {
    await handle.db.execute(sql`TRUNCATE audit_log`);
    await handle.db.insert(auditLog).values(row(1, GENESIS, hex("a")));
  });

  afterAll(async () => {
    await handle.close();
  });

  it("comes from the committed migration, and a second migrate applies nothing", async () => {
    expect(handle.kind).toBe("pglite");
    expect(await count(handle.db)).toBe(1);
    expect(await handle.migrate()).toBe(0);
  });

  it("stores seq as a number and payload and at as the text given", async () => {
    const [stored] = await handle.db.select().from(auditLog);
    expect(stored).toEqual(row(1, GENESIS, hex("a")));
    expect(typeof stored?.seq).toBe("number");
  });

  it("accepts the next row in the chain", async () => {
    await handle.db.insert(auditLog).values(row(2, hex("a"), hex("b")));
    expect(await count(handle.db)).toBe(2);
  });

  it("refuses a repeated seq", async () => {
    const text = await failureText(() =>
      handle.db.insert(auditLog).values(row(1, hex("a"), hex("b"))),
    );
    expect(text).toMatch(/audit_log_pkey/);
    expect(await count(handle.db)).toBe(1);
  });

  it("refuses a forked row: a prev_hash another row already has", async () => {
    const text = await failureText(() =>
      handle.db.insert(auditLog).values(row(2, GENESIS, hex("b"))),
    );
    expect(text).toMatch(/audit_log_prev_hash_unique/);
    expect(await count(handle.db)).toBe(1);
  });

  it("refuses a repeated hash", async () => {
    const text = await failureText(() =>
      handle.db.insert(auditLog).values(row(2, hex("a"), hex("a"))),
    );
    expect(text).toMatch(/audit_log_hash_unique/);
  });

  it("rejects every UPDATE with the trigger's message", async () => {
    const text = await failureText(() =>
      handle.db.update(auditLog).set({ payload: '{"seq":2}' }).where(sql`${auditLog.seq} = 1`),
    );
    expect(text).toMatch(/audit_log is append-only/);
    const [stored] = await handle.db.select().from(auditLog);
    expect(stored?.payload).toBe('{"seq":1}');
  });

  it("rejects every DELETE with the trigger's message", async () => {
    const text = await failureText(() => handle.db.delete(auditLog));
    expect(text).toMatch(/audit_log is append-only/);
    expect(await count(handle.db)).toBe(1);
  });

  it("allows TRUNCATE, after which the chain can start again from genesis", async () => {
    await handle.db.execute(sql`TRUNCATE audit_log`);
    expect(await count(handle.db)).toBe(0);
    await handle.db.insert(auditLog).values(row(1, GENESIS, hex("c")));
    expect(await count(handle.db)).toBe(1);
  });
});

// Two PGlite opens on disk can pass 5 s when the whole suite runs in parallel.
describe("a PGlite directory", { timeout: 60_000 }, () => {
  let parent: string;

  beforeEach(async () => {
    parent = await mkdtemp(join(tmpdir(), "countersign-db-"));
  });

  afterEach(async () => {
    await rm(parent, { recursive: true, force: true });
  });

  it("is created and migrated on open, and keeps its rows across opens", async () => {
    const dir = join(parent, "nested", "pglite");
    const first = await openPgliteDirectory(dir);
    await first.db.insert(auditLog).values(row(1, GENESIS, hex("a")));
    await first.close();

    const second = await openDatabase({ kind: "pglite", dir });
    expect(second.kind).toBe("pglite");
    expect(await count(second.db)).toBe(1);
    expect(await second.migrate()).toBe(0);
    await second.close();
  });
});

describe("the database clients", () => {
  it("give one Drizzle database type, whichever client opened it", async () => {
    const postgresHandle = openPostgres("postgres://user:secret@127.0.0.1:1/countersign");
    expect(postgresHandle.kind).toBe("postgres");
    expectTypeOf(postgresHandle.db).toEqualTypeOf<Database>();
    expectTypeOf<Awaited<ReturnType<typeof createTestDatabase>>["db"]>().toEqualTypeOf<Database>();
    expectTypeOf<Awaited<ReturnType<typeof openPgliteDirectory>>["db"]>().toEqualTypeOf<Database>();
    await postgresHandle.close();
  });
});
