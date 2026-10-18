import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  AttachmentConflictError,
  createTestDatabase,
  type DatabaseHandle,
  InvalidAttachmentError,
  InvalidTicketError,
  listThreads,
  migrationsFolder,
  openPgliteDirectory,
  readAttachment,
  readThread,
  readTicket,
  sql,
  type Ticket,
  TicketConflictError,
  writeAttachment,
  writeTicket,
} from "../src/index";

const SLOW = 60_000;

// The first bytes of a PNG, then a few more, so the bytes aren't text.
const PHOTO = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff, 0x10]);

const ticket = (overrides: Partial<Ticket> = {}): Ticket => ({
  id: "tkt_first",
  channel: "chat",
  senderEmail: "buyer-a@example.com",
  senderPhone: null,
  subject: null,
  body: "My basket arrived torn.",
  attachments: [],
  receivedAt: "2026-10-17T09:00:00.000Z",
  simulated: true,
  ...overrides,
});

describe("threads and attachments on a fresh in-memory PGlite", () => {
  let handle: DatabaseHandle;

  beforeAll(async () => {
    handle = await createTestDatabase();
  });

  beforeEach(async () => {
    await handle.db.execute(sql`TRUNCATE tickets, ticket_attachments`);
  });

  afterAll(async () => {
    await handle.close();
  });

  it("writes a two-message thread with a photo and reads it back in order, bytes and all", async () => {
    expect(
      await writeAttachment(handle.db, {
        id: "att_photo",
        ticketId: "tkt_second",
        contentType: "image/png",
        bytes: PHOTO,
      }),
    ).toBe("written");
    await writeTicket(handle.db, ticket());
    await writeTicket(
      handle.db,
      ticket({
        id: "tkt_second",
        threadId: "tkt_first",
        body: "Here is a photo.",
        attachments: [{ id: "att_photo", contentType: "image/png" }],
        receivedAt: "2026-10-17T12:05:00+03:00",
      }),
    );

    const thread = await readThread(handle.db, "tkt_first");
    expect(thread.map((item) => item.id)).toEqual(["tkt_first", "tkt_second"]);
    expect(thread[0]).toEqual({ ...ticket(), threadId: "tkt_first" });
    expect(thread[1]?.attachments).toEqual([{ id: "att_photo", contentType: "image/png" }]);

    const photo = await readAttachment(handle.db, "att_photo");
    expect(photo).toMatchObject({
      id: "att_photo",
      ticketId: "tkt_second",
      contentType: "image/png",
      size: PHOTO.byteLength,
    });
    expect(photo?.bytes).toBeInstanceOf(Uint8Array);
    expect(Array.from(photo?.bytes ?? [])).toEqual(Array.from(PHOTO));
  });

  it("orders a thread by instant, not by the text of the received time", async () => {
    // 09:30 at +03:00 is 06:30 UTC, before 07:00 UTC, though its text sorts after.
    await writeTicket(handle.db, ticket({ id: "tkt_a", receivedAt: "2026-10-17T07:00:00Z" }));
    await writeTicket(
      handle.db,
      ticket({ id: "tkt_b", threadId: "tkt_a", receivedAt: "2026-10-17T09:30:00+03:00" }),
    );
    expect((await readThread(handle.db, "tkt_a")).map((item) => item.id)).toEqual([
      "tkt_b",
      "tkt_a",
    ]);
  });

  it("starts a thread of its own for a ticket written without a thread ID", async () => {
    await writeTicket(handle.db, ticket());
    expect(await readThread(handle.db, "tkt_first")).toEqual([
      { ...ticket(), threadId: "tkt_first" },
    ]);
  });

  it("reads an unknown thread as none", async () => {
    await writeTicket(handle.db, ticket());
    expect(await readThread(handle.db, "tkt_unknown")).toEqual([]);
  });

  it("treats the default thread ID and the same one written out as the same contents", async () => {
    await writeTicket(handle.db, ticket());
    expect(await writeTicket(handle.db, ticket({ threadId: "tkt_first" }))).toBe("unchanged");
  });

  it("refuses a rewrite with a different thread ID and keeps the stored ticket", async () => {
    await writeTicket(handle.db, ticket());
    const rewrite = writeTicket(handle.db, ticket({ threadId: "tkt_other" }));
    await expect(rewrite).rejects.toBeInstanceOf(TicketConflictError);
    expect(await readThread(handle.db, "tkt_first")).toHaveLength(1);
    expect(await readThread(handle.db, "tkt_other")).toEqual([]);
  });

  it("refuses an empty thread ID", async () => {
    await expect(writeTicket(handle.db, ticket({ threadId: "" }))).rejects.toBeInstanceOf(
      InvalidTicketError,
    );
  });

  it("keeps readTicket's shape: the thread comes from the thread readers", async () => {
    await writeTicket(handle.db, ticket({ id: "tkt_second", threadId: "tkt_first" }));
    expect(await readTicket(handle.db, "tkt_second")).toEqual(ticket({ id: "tkt_second" }));
  });

  it("lists each thread's first ticket and latest activity, newest activity first", async () => {
    await writeTicket(handle.db, ticket({ id: "tkt_old", receivedAt: "2026-10-17T08:00:00Z" }));
    await writeTicket(handle.db, ticket({ id: "tkt_mid", receivedAt: "2026-10-17T09:00:00Z" }));
    await writeTicket(
      handle.db,
      ticket({ id: "tkt_old_2", threadId: "tkt_old", receivedAt: "2026-10-17T13:00:00+03:00" }),
    );
    await writeTicket(
      handle.db,
      ticket({ id: "tkt_old_3", threadId: "tkt_old", receivedAt: "2026-10-17T08:30:00Z" }),
    );

    const threads = await listThreads(handle.db);
    expect(
      threads.map(({ threadId, first, latestActivityAt }) => [
        threadId,
        first.id,
        latestActivityAt,
      ]),
    ).toEqual([
      ["tkt_old", "tkt_old", "2026-10-17T13:00:00+03:00"],
      ["tkt_mid", "tkt_mid", "2026-10-17T09:00:00Z"],
    ]);
    expect(threads[0]?.first).toEqual({
      ...ticket({ id: "tkt_old", receivedAt: "2026-10-17T08:00:00Z" }),
      threadId: "tkt_old",
    });
  });

  it("lists no threads on an empty store", async () => {
    expect(await listThreads(handle.db)).toEqual([]);
  });

  it("treats rewriting an attachment with the same contents as a no-op", async () => {
    const photo = { id: "att_1", ticketId: "tkt_first", contentType: "image/png", bytes: PHOTO };
    await writeAttachment(handle.db, photo);
    expect(await writeAttachment(handle.db, { ...photo, bytes: PHOTO.slice() })).toBe("unchanged");
  });

  it.each([
    ["other bytes", { bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]) }],
    ["one byte changed", { bytes: PHOTO.map((byte, i) => (i === 10 ? 0x11 : byte)) }],
    ["another content type", { contentType: "image/jpeg" }],
    ["another ticket", { ticketId: "tkt_other" }],
  ])("refuses an attachment rewrite with %s and keeps the stored one", async (_name, change) => {
    const photo = { id: "att_1", ticketId: "tkt_first", contentType: "image/png", bytes: PHOTO };
    await writeAttachment(handle.db, photo);
    const rewrite = writeAttachment(handle.db, { ...photo, ...change });
    await expect(rewrite).rejects.toBeInstanceOf(AttachmentConflictError);
    await expect(rewrite).rejects.toThrow(
      "Attachment att_1 is already stored with other contents.",
    );
    const stored = await readAttachment(handle.db, "att_1");
    expect(stored?.contentType).toBe("image/png");
    expect(Array.from(stored?.bytes ?? [])).toEqual(Array.from(PHOTO));
  });

  it("reads an unknown attachment as none", async () => {
    expect(await readAttachment(handle.db, "att_unknown")).toBeNull();
  });

  it.each([
    ["an empty ID", { id: "" }, /id/],
    ["no ticket ID", { ticketId: "" }, /ticketId/],
    ["bytes that aren't bytes", { bytes: "iVBORw0KGgo=" }, /bytes/],
    ["an unknown field", { size: 11 }, /size|Unrecognized/],
  ])("refuses an attachment with %s and stores nothing", async (_name, change, pattern) => {
    const write = writeAttachment(handle.db, {
      id: "att_1",
      ticketId: "tkt_first",
      contentType: "image/png",
      bytes: PHOTO,
      ...change,
    } as never);
    await expect(write).rejects.toBeInstanceOf(InvalidAttachmentError);
    await expect(write).rejects.toThrow(pattern);
    expect(await readAttachment(handle.db, "att_1")).toBeNull();
  });
});

describe("the threads and attachments migration", { timeout: SLOW }, () => {
  let parent: string;

  beforeAll(async () => {
    parent = await mkdtemp(join(tmpdir(), "countersign-threads-"));
  });

  afterAll(async () => {
    await rm(parent, { recursive: true, force: true });
  });

  it("applies to a phase 7 database, and its tickets become threads of their own", async () => {
    // A copy of the migrations folder that stops where phase 7 did: the first three migrations.
    const phase7 = join(parent, "drizzle-phase7");
    await cp(migrationsFolder, phase7, { recursive: true });
    const journalPath = join(phase7, "meta", "_journal.json");
    const journal = JSON.parse(await readFile(journalPath, "utf8")) as { entries: unknown[] };
    await writeFile(
      journalPath,
      JSON.stringify({ ...journal, entries: journal.entries.slice(0, 3) }),
    );

    const dir = join(parent, "pglite-phase7");
    const old = new PGlite(dir);
    await migrate(drizzle({ client: old }), { migrationsFolder: phase7 });
    await old.query(
      `INSERT INTO tickets (id, channel, sender_email, sender_phone, subject, body, attachments,
         received_at, simulated)
       VALUES ('TKT-1035', 'email', 'buyer-a@example.com', NULL, NULL, 'Simulated.', '[]',
         '2026-10-17T09:00:00.000Z', true)`,
    );
    await old.close();

    const handle = await openPgliteDirectory(dir, { migrate: false });
    try {
      expect(await handle.migrate()).toBe(journal.entries.length - 3);
      const [stored] = await readThread(handle.db, "TKT-1035");
      expect(stored).toMatchObject({ id: "TKT-1035", threadId: "TKT-1035" });
      await writeAttachment(handle.db, {
        id: "att_1",
        ticketId: "TKT-1036",
        contentType: "image/png",
        bytes: PHOTO,
      });
      expect((await readAttachment(handle.db, "att_1"))?.size).toBe(PHOTO.byteLength);
    } finally {
      await handle.close();
    }
  });

  it("applies to a fresh database", async () => {
    const handle = await openPgliteDirectory(join(parent, "pglite-fresh"));
    try {
      expect(await handle.migrate()).toBe(0);
      expect(await listThreads(handle.db)).toEqual([]);
    } finally {
      await handle.close();
    }
  });
});
