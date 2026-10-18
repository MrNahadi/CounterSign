import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createTestDatabase,
  type DatabaseHandle,
  InvalidTicketError,
  migrationsFolder,
  openPgliteDirectory,
  readTicket,
  seedOrders,
  sql,
  type Ticket,
  TicketConflictError,
  tickets,
  writeTicket,
} from "../src/index";

const SLOW = 60_000;

const ticket = (overrides: Partial<Ticket> = {}): Ticket => ({
  id: "tkt_1013",
  channel: "email",
  senderEmail: "buyer-a@example.com",
  senderPhone: null,
  subject: "My order never arrived",
  body: "It has been two weeks and nothing has come.",
  attachments: [
    { id: "att_1", contentType: "image/jpeg" },
    { id: "att_2", contentType: "application/pdf" },
  ],
  receivedAt: "2026-10-17T09:00:00.000Z",
  simulated: true,
  ...overrides,
});

describe("the ticket store on a fresh in-memory PGlite", () => {
  let handle: DatabaseHandle;

  beforeAll(async () => {
    handle = await createTestDatabase();
  });

  beforeEach(async () => {
    await handle.db.execute(sql`TRUNCATE tickets`);
  });

  afterAll(async () => {
    await handle.close();
  });

  it("reads a written ticket back by ID with every field the same", async () => {
    expect(await writeTicket(handle.db, ticket())).toBe("written");
    expect(await readTicket(handle.db, "tkt_1013")).toEqual(ticket());
  });

  it("keeps a chat ticket with a phone, no email, no subject and no attachments", async () => {
    const chat = ticket({
      id: "tkt_chat_1",
      channel: "chat",
      senderEmail: null,
      senderPhone: "+254700000001",
      subject: null,
      attachments: [],
      receivedAt: "2026-10-17T12:00:00+03:00",
      simulated: false,
    });
    await writeTicket(handle.db, chat);
    expect(await readTicket(handle.db, "tkt_chat_1")).toEqual(chat);
  });

  it("reads an unknown ID as none", async () => {
    await writeTicket(handle.db, ticket());
    expect(await readTicket(handle.db, "tkt_9999")).toBeNull();
  });

  it("treats writing the same ID with the same contents as a no-op", async () => {
    await writeTicket(handle.db, ticket());
    expect(await writeTicket(handle.db, ticket())).toBe("unchanged");
    expect(await handle.db.select().from(tickets)).toHaveLength(1);
    expect(await readTicket(handle.db, "tkt_1013")).toEqual(ticket());
  });

  it.each([
    ["sender email", { senderEmail: "buyer-b@example.com" }],
    ["sender phone", { senderPhone: "+254700000002" }],
    ["subject", { subject: null }],
    ["body", { body: "Please refund me." }],
    ["channel", { channel: "chat" as const }],
    ["attachments", { attachments: [{ id: "att_1", contentType: "image/jpeg" }] }],
    [
      "attachment order",
      {
        attachments: [
          { id: "att_2", contentType: "application/pdf" },
          { id: "att_1", contentType: "image/jpeg" },
        ],
      },
    ],
    ["received time", { receivedAt: "2026-10-17T09:00:01.000Z" }],
    ["simulated flag", { simulated: false }],
  ])("refuses a rewrite with a different %s and keeps the stored ticket", async (_name, change) => {
    await writeTicket(handle.db, ticket());
    const rewrite = writeTicket(handle.db, ticket(change));
    await expect(rewrite).rejects.toBeInstanceOf(TicketConflictError);
    await expect(rewrite).rejects.toThrow("Ticket tkt_1013 is already stored with other contents.");
    expect(await readTicket(handle.db, "tkt_1013")).toEqual(ticket());
  });

  it.each([
    ["an empty ID", { id: "" }, /id/],
    ["an unknown channel", { channel: "sms" }, /channel/],
    ["a sender email that isn't one", { senderEmail: "not-an-email" }, /senderEmail/],
    ["a received time without an offset", { receivedAt: "2026-10-17T09:00:00" }, /receivedAt/],
    ["a received time on no calendar", { receivedAt: "2026-02-30T09:00:00Z" }, /receivedAt/],
    ["a received time that isn't one", { receivedAt: "yesterday" }, /receivedAt/],
    ["an attachment with no content type", { attachments: [{ id: "a" }] }, /attachments/],
    ["a simulated flag that isn't a boolean", { simulated: "yes" }, /simulated/],
    ["an unknown field", { priority: "high" }, /priority|Unrecognized/],
  ])("refuses %s and stores nothing", async (_name, change, pattern) => {
    const write = writeTicket(handle.db, { ...ticket(), ...change } as unknown as Ticket);
    await expect(write).rejects.toBeInstanceOf(InvalidTicketError);
    await expect(write).rejects.toThrow(pattern);
    expect(await handle.db.select().from(tickets)).toEqual([]);
  });

  it("never puts the refused input in the error message", async () => {
    const write = writeTicket(handle.db, ticket({ senderEmail: "secret-value-123" }));
    await expect(write).rejects.not.toThrow(/secret-value-123/);
  });
});

describe("the tickets migration", { timeout: SLOW }, () => {
  let parent: string;

  beforeAll(async () => {
    parent = await mkdtemp(join(tmpdir(), "countersign-tickets-"));
  });

  afterAll(async () => {
    await rm(parent, { recursive: true, force: true });
  });

  it("applies to a phase 6 database and keeps its rows", async () => {
    // A copy of the migrations folder that stops where phase 6 did: the first two migrations.
    const phase6 = join(parent, "drizzle-phase6");
    await cp(migrationsFolder, phase6, { recursive: true });
    const journalPath = join(phase6, "meta", "_journal.json");
    const journal = JSON.parse(await readFile(journalPath, "utf8")) as { entries: unknown[] };
    await writeFile(
      journalPath,
      JSON.stringify({ ...journal, entries: journal.entries.slice(0, 2) }),
    );

    const dir = join(parent, "pglite-phase6");
    const old = new PGlite(dir);
    const oldDb = drizzle({ client: old });
    await migrate(oldDb, { migrationsFolder: phase6 });
    await oldDb.insert(seedOrders).values({
      orderNumber: "KIK-1013",
      runId: "run1",
      paypalOrderId: "ORDER00001",
      paypalCaptureId: "CAP0000001",
      amountMinor: 4800,
      currency: "USD",
      payerEmail: "buyer-a@example.com",
      buyer: "A",
      trackingNumber: "KC-run1-1013",
      role: "filler",
      seededAt: "2026-10-17T09:00:00.000Z",
    });
    await old.close();

    const handle = await openPgliteDirectory(dir, { migrate: false });
    try {
      expect(await handle.migrate()).toBe(1);
      expect(await handle.db.select().from(seedOrders)).toHaveLength(1);
      await writeTicket(handle.db, ticket());
      expect(await readTicket(handle.db, "tkt_1013")).toEqual(ticket());
    } finally {
      await handle.close();
    }
  });
});
