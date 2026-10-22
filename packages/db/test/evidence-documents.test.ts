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
  disputeDrafts,
  EvidenceDocumentConflictError,
  type EvidenceDocumentInput,
  InvalidEvidenceDocumentError,
  listEvidenceDocuments,
  migrationsFolder,
  openPgliteDirectory,
  readEvidenceDocument,
  readTicket,
  sha256Hex,
  sql,
  writeEvidenceDocument,
} from "../src/index";

const PDF = new TextEncoder().encode("%PDF-1.7 evidence");
const JSON_BYTES = new TextEncoder().encode('{"entries":[]}');

const document = (overrides: Partial<EvidenceDocumentInput> = {}): EvidenceDocumentInput => ({
  id: "doc_pdf",
  disputeId: "PP-D-1",
  kind: "pdf",
  name: "countersign-evidence-PP-D-1.pdf",
  contentType: "application/pdf",
  bytes: PDF,
  createdAt: "2026-10-22T09:00:00.000Z",
  ...overrides,
});

const failureText = async (run: () => Promise<unknown>): Promise<string> => {
  try {
    await run();
  } catch (error) {
    const cause = error instanceof Error && error.cause instanceof Error ? error.cause.message : "";
    return `${error instanceof Error ? error.message : String(error)} ${cause}`;
  }
  throw new Error("expected the statement to fail");
};

describe("the evidence_documents and dispute_drafts tables on a fresh in-memory PGlite", () => {
  let handle: DatabaseHandle;

  beforeAll(async () => {
    handle = await createTestDatabase();
  }, 60_000);

  beforeEach(async () => {
    await handle.db.execute(sql`TRUNCATE evidence_documents, dispute_drafts`);
  });

  afterAll(async () => {
    await handle.close();
  });

  it("reads a document back by ID and by dispute, bytes, size and SHA-256 included", async () => {
    expect(await writeEvidenceDocument(handle.db, document())).toBe("written");
    await writeEvidenceDocument(
      handle.db,
      document({
        id: "doc_export",
        kind: "export",
        name: "countersign-evidence-capture-9AB.json",
        contentType: "application/json",
        bytes: JSON_BYTES,
        createdAt: "2026-10-22T09:00:01.000Z",
      }),
    );
    await writeEvidenceDocument(handle.db, document({ id: "doc_other", disputeId: "PP-D-2" }));

    const stored = await readEvidenceDocument(handle.db, "doc_pdf");
    expect(stored).toMatchObject({
      id: "doc_pdf",
      disputeId: "PP-D-1",
      kind: "pdf",
      name: "countersign-evidence-PP-D-1.pdf",
      contentType: "application/pdf",
      size: PDF.byteLength,
      sha256: sha256Hex(PDF),
      createdAt: "2026-10-22T09:00:00.000Z",
    });
    expect(Array.from(stored?.bytes ?? [])).toEqual(Array.from(PDF));
    expect(stored?.sha256).toMatch(/^[0-9a-f]{64}$/);

    const forDispute = await listEvidenceDocuments(handle.db, "PP-D-1");
    expect(forDispute.map((item) => item.id)).toEqual(["doc_pdf", "doc_export"]);
    expect(await listEvidenceDocuments(handle.db, "PP-D-404")).toEqual([]);
    expect(await readEvidenceDocument(handle.db, "doc_missing")).toBeNull();
  });

  it("treats the same contents again as unchanged and refuses other contents", async () => {
    await writeEvidenceDocument(handle.db, document());
    expect(await writeEvidenceDocument(handle.db, document())).toBe("unchanged");
    await expect(
      writeEvidenceDocument(handle.db, document({ bytes: JSON_BYTES })),
    ).rejects.toBeInstanceOf(EvidenceDocumentConflictError);
    expect(Array.from((await readEvidenceDocument(handle.db, "doc_pdf"))?.bytes ?? [])).toEqual(
      Array.from(PDF),
    );
  });

  it("refuses a document that fails the schema", async () => {
    await expect(writeEvidenceDocument(handle.db, document({ name: "" }))).rejects.toBeInstanceOf(
      InvalidEvidenceDocumentError,
    );
    await expect(
      writeEvidenceDocument(handle.db, document({ createdAt: "yesterday" })),
    ).rejects.toBeInstanceOf(InvalidEvidenceDocumentError);
  });

  it("rejects UPDATE and DELETE with a trigger, and allows TRUNCATE", async () => {
    await writeEvidenceDocument(handle.db, document());
    expect(
      await failureText(() =>
        handle.db.execute(sql`UPDATE evidence_documents SET name = 'changed.pdf'`),
      ),
    ).toContain("evidence_documents is write-once");
    expect(
      await failureText(() => handle.db.execute(sql`DELETE FROM evidence_documents`)),
    ).toContain("evidence_documents is write-once");
    expect((await readEvidenceDocument(handle.db, "doc_pdf"))?.name).toBe(
      "countersign-evidence-PP-D-1.pdf",
    );
    await handle.db.execute(sql`TRUNCATE evidence_documents`);
    expect(await listEvidenceDocuments(handle.db, "PP-D-1")).toEqual([]);
  });

  it("refuses a document kind outside the listed values", async () => {
    expect(
      await failureText(() =>
        handle.db.execute(
          sql`INSERT INTO evidence_documents (id, dispute_id, kind, name, content_type, size, sha256, bytes, created_at)
              VALUES ('d', 'PP-D-1', 'zip', 'a.zip', 'application/zip', 1, 'x', '\\x00', '2026-10-22T09:00:00.000Z')`,
        ),
      ),
    ).toContain("evidence_documents_kind_check");
  });

  it("stores a draft per dispute with every field, and checks the status", async () => {
    await handle.db.insert(disputeDrafts).values({
      id: "drf_1",
      disputeId: "PP-D-1",
      status: "proposed",
      outcome: "proposed",
      draftedBy: "gemini-3-flash-preview",
      model: "gemini-3-flash-preview",
      modelVersions: ["gemini-3-flash-preview-001"],
      notes: ["Shipped with Kikapu Post."],
      factsSummary: { summary: "Delivered." },
      agentResponse: { status: "pending_approval" },
      intentId: "int_1",
      queuedAt: "2026-10-22T09:00:00.000Z",
      startedAt: "2026-10-22T09:00:01.000Z",
      finishedAt: "2026-10-22T09:00:05.000Z",
    });
    const [draft] = await handle.db.select().from(disputeDrafts);
    expect(draft).toMatchObject({
      id: "drf_1",
      disputeId: "PP-D-1",
      status: "proposed",
      draftedBy: "gemini-3-flash-preview",
      modelVersions: ["gemini-3-flash-preview-001"],
      notes: ["Shipped with Kikapu Post."],
      factsSummary: { summary: "Delivered." },
      agentResponse: { status: "pending_approval" },
      intentId: "int_1",
    });

    const base = {
      model: "m",
      modelVersions: [],
      queuedAt: "2026-10-22T09:00:00.000Z",
    };
    expect(
      await failureText(() =>
        handle.db
          .insert(disputeDrafts)
          .values({ ...base, id: "drf_2", disputeId: "PP-D-2", status: "done" }),
      ),
    ).toContain("dispute_drafts_status_check");
    expect(
      await failureText(() =>
        handle.db
          .insert(disputeDrafts)
          .values({ ...base, id: "drf_3", disputeId: "PP-D-1", status: "queued" }),
      ),
    ).toContain("dispute_drafts_dispute_id_unique");
  });
});

describe("the evidence documents migration", { timeout: 60_000 }, () => {
  it("applies to a database at phase 10's schema, keeping its rows", async () => {
    const parent = await mkdtemp(join(tmpdir(), "countersign-evidence-"));
    try {
      // A copy of the migrations folder that stops before this one.
      const phase10 = join(parent, "drizzle-phase10");
      await cp(migrationsFolder, phase10, { recursive: true });
      const journalPath = join(phase10, "meta", "_journal.json");
      const journal = JSON.parse(await readFile(journalPath, "utf8")) as { entries: unknown[] };
      const before = journal.entries.length - 1;
      await writeFile(
        journalPath,
        JSON.stringify({ ...journal, entries: journal.entries.slice(0, before) }),
      );

      const dir = join(parent, "pglite-phase10");
      const old = new PGlite(dir);
      await migrate(drizzle({ client: old }), { migrationsFolder: phase10 });
      await old.query(
        `INSERT INTO tickets (id, channel, body, attachments, received_at, simulated, thread_id)
         VALUES ('TKT-1', 'chat', 'Simulated.', '[]', '2026-10-17T09:00:00.000Z', true, 'TKT-1')`,
      );
      await old.close();

      const handle = await openPgliteDirectory(dir, { migrate: false });
      try {
        expect(await handle.migrate()).toBe(1);
        await writeEvidenceDocument(handle.db, document());
        expect((await readEvidenceDocument(handle.db, "doc_pdf"))?.size).toBe(PDF.byteLength);
        expect(await handle.db.select().from(disputeDrafts)).toEqual([]);
        expect(await readTicket(handle.db, "TKT-1")).toMatchObject({ id: "TKT-1" });
      } finally {
        await handle.close();
      }
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });
});
