import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  agentRuns,
  auditLog,
  carrierShipments,
  clearDemoTables,
  clearedRunCounts,
  countClearedRunsOnDate,
  countUnfinishedWork,
  createTestDatabase,
  type DatabaseHandle,
  disputeDrafts,
  evidenceDocuments,
  lockDemoTables,
  runsQueuedSince,
  seedOrders,
  sql,
  ticketAttachments,
  tickets,
} from "../src/index";

const SLOW = 60_000;

const migrations = fileURLToPath(new URL("../drizzle/", import.meta.url));

const run = (id: string, status: string, queuedAt: string) => ({
  id,
  ticketId: "tkt_1",
  threadId: "tkt_1",
  mode: "protected",
  model: "gemini-3.5-flash-lite",
  modelVersions: [],
  status,
  queuedAt,
});

const draft = (id: string, disputeId: string, status: string, queuedAt: string) => ({
  id,
  disputeId,
  status,
  model: "gemini-3.5-flash-lite",
  modelVersions: [],
  queuedAt,
});

const entry = (seq: number) => ({
  seq,
  entryType: "intent.decided",
  refId: null,
  at: "2026-10-30T10:00:00.000Z",
  payload: "{}",
  prevHash: `prev_${seq}`,
  hash: `hash_${seq}`,
});

describe("clearing the demo tables on a fresh in-memory PGlite", () => {
  let handle: DatabaseHandle;

  beforeAll(async () => {
    handle = await createTestDatabase();
  }, SLOW);

  beforeEach(async () => {
    await handle.db.execute(
      sql`TRUNCATE audit_log, tickets, ticket_attachments, agent_runs, dispute_drafts, evidence_documents, seed_orders, carrier_shipments, cleared_run_counts`,
    );
  });

  afterAll(async () => {
    await handle.close();
  });

  const fill = async () => {
    const { db } = handle;
    await db.insert(auditLog).values([entry(1), entry(2), entry(3)]);
    await db.insert(tickets).values([
      {
        id: "tkt_1",
        channel: "email",
        senderEmail: "a@example.com",
        body: "Where is my order?",
        attachments: [],
        receivedAt: "2026-10-30T09:59:00.000Z",
        simulated: true,
        threadId: "tkt_1",
      },
    ]);
    await db.insert(ticketAttachments).values([
      {
        id: "att_1",
        ticketId: "tkt_1",
        contentType: "image/png",
        size: 1,
        bytes: Buffer.from([1]),
      },
      {
        id: "att_2",
        ticketId: "tkt_1",
        contentType: "image/png",
        size: 1,
        bytes: Buffer.from([2]),
      },
    ]);
    await db
      .insert(agentRuns)
      .values([
        run("run_1", "replied", "2026-10-30T23:59:59.000Z"),
        run("run_2", "failed", "2026-10-31T00:00:00.000Z"),
        run("run_3", "not_run", "2026-10-31T08:00:00.000+03:00"),
      ]);
    await db
      .insert(disputeDrafts)
      .values([
        draft("drf_1", "PP-D-1", "proposed", "2026-10-31T12:00:00.000Z"),
        draft("drf_2", "PP-D-2", "failed", "2026-10-30T12:00:00.000Z"),
      ]);
    await db.insert(evidenceDocuments).values([
      {
        id: "doc_1",
        disputeId: "PP-D-1",
        kind: "pdf",
        name: "evidence.pdf",
        contentType: "application/pdf",
        size: 1,
        sha256: "00",
        bytes: Buffer.from([0]),
        createdAt: "2026-10-31T12:00:00.000Z",
      },
    ]);
    await db.insert(seedOrders).values({
      orderNumber: "KIK-1035",
      runId: "seed-1",
      paypalOrderId: "ORDER-1",
      paypalCaptureId: "CAPTURE-1",
      amountMinor: 1800,
      currency: "USD",
      payerEmail: "a@example.com",
      buyer: "A",
      trackingNumber: "TRK-1",
      role: "stalled",
      seededAt: "2026-10-29T10:00:00.000Z",
    });
    await db.insert(carrierShipments).values({
      trackingNumber: "TRK-1",
      status: "stalled_10d",
      carrierName: "Illustrative Post",
      scanEvents: [],
      updatedAt: "2026-10-29T10:00:00.000Z",
    });
  };

  const rowCount = async (table: string): Promise<number> => {
    const [row] = await handle.db
      .select({ n: sql<number>`count(*)::int` })
      .from(sql`${sql.identifier(table)}`);
    return Number(row?.n);
  };

  it("adds migration 0007, named for the table it creates", async () => {
    const journal = JSON.parse(await readFile(`${migrations}meta/_journal.json`, "utf8")) as {
      entries: { idx: number; tag: string }[];
    };
    expect(journal.entries.find((e) => e.idx === 7)?.tag).toBe("0007_cleared_run_counts");
    const migration = await readFile(`${migrations}0007_cleared_run_counts.sql`, "utf8");
    expect(migration).toContain('CREATE TABLE "cleared_run_counts"');
    expect(await rowCount("cleared_run_counts")).toBe(0);
  });

  it("empties the six tables, keeps the seed tables, and returns the old head and counts", async () => {
    await fill();
    const cleared = await handle.db.transaction(async (tx) => {
      await lockDemoTables(tx);
      return clearDemoTables(tx);
    });
    expect(cleared).toEqual({
      entries: 3,
      head: { seq: 3, hash: "hash_3" },
      tickets: 1,
      attachments: 2,
      runs: 3,
      drafts: 2,
      documents: 1,
    });
    for (const table of [
      "audit_log",
      "tickets",
      "ticket_attachments",
      "agent_runs",
      "dispute_drafts",
      "evidence_documents",
    ])
      expect(await rowCount(table)).toBe(0);
    expect(await rowCount("seed_orders")).toBe(1);
    expect(await rowCount("carrier_shipments")).toBe(1);
  });

  it("adds each UTC date's runs and drafts, every status, and clearing twice adds up", async () => {
    await fill();
    await handle.db.transaction((tx) => clearDemoTables(tx));
    // run_1 and drf_2 on the 30th; run_2, run_3 (05:00 UTC) and drf_1 on the 31st.
    expect(await countClearedRunsOnDate(handle.db, "2026-10-30")).toBe(2);
    expect(await countClearedRunsOnDate(handle.db, "2026-10-31")).toBe(3);

    await handle.db
      .insert(agentRuns)
      .values([
        run("run_4", "replied", "2026-10-31T10:00:00.000Z"),
        run("run_5", "failed", "2026-11-01T00:00:01.000Z"),
      ]);
    await handle.db
      .insert(disputeDrafts)
      .values([draft("drf_3", "PP-D-3", "not_run", "2026-10-31T11:00:00.000Z")]);
    await handle.db.transaction((tx) => clearDemoTables(tx));

    expect(await countClearedRunsOnDate(handle.db, "2026-10-30")).toBe(2);
    expect(await countClearedRunsOnDate(handle.db, "2026-10-31")).toBe(5);
    expect(await countClearedRunsOnDate(handle.db, "2026-11-01")).toBe(1);
    expect(await rowCount("cleared_run_counts")).toBe(3);
  });

  it("returns a null head and zero counts when the tables are already empty", async () => {
    const cleared = await handle.db.transaction((tx) => clearDemoTables(tx));
    expect(cleared).toEqual({
      entries: 0,
      head: null,
      tickets: 0,
      attachments: 0,
      runs: 0,
      drafts: 0,
      documents: 0,
    });
    expect(await rowCount("cleared_run_counts")).toBe(0);
  });

  it("counts no cleared runs on a date with no row, and rejects a date that isn't YYYY-MM-DD", async () => {
    await handle.db.insert(clearedRunCounts).values({ utcDate: "2026-10-31", runs: 4 });
    expect(await countClearedRunsOnDate(handle.db, "2026-10-31")).toBe(4);
    expect(await countClearedRunsOnDate(handle.db, "2026-11-01")).toBe(0);
    await expect(countClearedRunsOnDate(handle.db, "31/10/2026")).rejects.toThrow();
  });

  it("counts only queued and running runs and drafts, on a database or a transaction", async () => {
    const at = "2026-10-31T10:00:00.000Z";
    await handle.db
      .insert(agentRuns)
      .values([
        run("r_q", "queued", at),
        run("r_r", "running", at),
        run("r_s", "stopped", at),
        run("r_f", "failed", at),
        run("r_n", "not_run", at),
        run("r_d", "replied", at),
      ]);
    await handle.db
      .insert(disputeDrafts)
      .values([
        draft("d_r", "PP-D-1", "running", at),
        draft("d_p", "PP-D-2", "proposed", at),
        draft("d_f", "PP-D-3", "failed", at),
        draft("d_n", "PP-D-4", "not_run", at),
      ]);
    expect(await countUnfinishedWork(handle.db)).toEqual({ runs: 2, drafts: 1 });
    expect(await handle.db.transaction((tx) => countUnfinishedWork(tx))).toEqual({
      runs: 2,
      drafts: 1,
    });
  });

  it("counts runs queued since a time as instants, less a 5-second margin", async () => {
    await handle.db.insert(agentRuns).values([
      run("r_6s", "replied", "2026-10-31T09:59:54.000Z"),
      run("r_4s", "replied", "2026-10-31T09:59:56.000Z"),
      // 13:00 at +03:00 is 10:00:30 UTC: after, though it sorts before as text.
      run("r_tz", "replied", "2026-10-31T13:00:30.000+03:00"),
    ]);
    expect(await runsQueuedSince(handle.db, "2026-10-31T10:00:00.000Z")).toBe(2);
    expect(
      await handle.db.transaction((tx) => runsQueuedSince(tx, "2026-10-31T10:00:00.000Z")),
    ).toBe(2);
    expect(await runsQueuedSince(handle.db, "2026-10-31T10:00:40.000Z")).toBe(0);
  });

  it("locks the six tables with a 5-second lock timeout inside the transaction", async () => {
    const timeout = await handle.db.transaction(async (tx) => {
      await lockDemoTables(tx);
      const [row] = await tx
        .select({ timeout: sql<string>`current_setting('lock_timeout')` })
        .from(sql`(VALUES (1)) AS probe (n)`);
      return row?.timeout;
    });
    expect(timeout).toBe("5s");
  });
});
