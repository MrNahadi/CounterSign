// The evidence document store's writers and readers (ADR 0035). A document is written once and
// never changed: a trigger rejects UPDATE and DELETE. The same ID with the same contents is a
// no-op, and with other contents it's refused. The SHA-256 is worked out here from the bytes.

import { createHash } from "node:crypto";
import { TimestampSchema } from "@countersign/mandate";
import { asc, eq } from "drizzle-orm";
import { z } from "zod";
import type { Database } from "./client";
import { EVIDENCE_DOCUMENT_KINDS, type EvidenceDocumentKind, evidenceDocuments } from "./schema";

export const EvidenceDocumentSchema = z.strictObject({
  id: z.string().min(1).max(256),
  disputeId: z.string().min(1).max(256),
  kind: z.enum(EVIDENCE_DOCUMENT_KINDS),
  name: z.string().min(1).max(256),
  contentType: z.string().min(1).max(256),
  bytes: z.instanceof(Uint8Array),
  createdAt: TimestampSchema,
});

/** A document to write. `size` and `sha256` are worked out from the bytes. */
export type EvidenceDocumentInput = {
  id: string;
  disputeId: string;
  kind: EvidenceDocumentKind;
  name: string;
  contentType: string;
  bytes: Uint8Array;
  createdAt: string;
};

/** A stored evidence document, with its bytes. */
export type StoredEvidenceDocument = EvidenceDocumentInput & { size: number; sha256: string };

/** Thrown when a document to write fails `EvidenceDocumentSchema`. The message holds no input. */
export class InvalidEvidenceDocumentError extends Error {
  override readonly name = "InvalidEvidenceDocumentError";
}

/** Thrown when a document's ID is already stored with other contents. Nothing is changed. */
export class EvidenceDocumentConflictError extends Error {
  override readonly name = "EvidenceDocumentConflictError";
  readonly documentId: string;
  constructor(documentId: string) {
    super(`Evidence document ${documentId} is already stored with other contents.`);
    this.documentId = documentId;
  }
}

/** SHA-256 of the bytes, as lower-case hex. */
export const sha256Hex = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");

const sameBytes = (a: Uint8Array, b: Uint8Array): boolean =>
  a.byteLength === b.byteLength && a.every((byte, i) => byte === b[i]);

const toStored = (row: {
  id: string;
  disputeId: string;
  kind: string;
  name: string;
  contentType: string;
  size: number;
  sha256: string;
  bytes: Uint8Array;
  createdAt: string;
}): StoredEvidenceDocument => ({
  id: row.id,
  disputeId: row.disputeId,
  kind: z.enum(EVIDENCE_DOCUMENT_KINDS).parse(row.kind),
  name: row.name,
  contentType: row.contentType,
  size: row.size,
  sha256: row.sha256,
  bytes: row.bytes,
  createdAt: row.createdAt,
});

/** The document with this ID and its bytes, or null when none is stored. */
export const readEvidenceDocument = async (
  db: Database,
  id: string,
): Promise<StoredEvidenceDocument | null> => {
  const [row] = await db
    .select()
    .from(evidenceDocuments)
    .where(eq(evidenceDocuments.id, id))
    .limit(1);
  return row ? toStored(row) : null;
};

/** A dispute's documents, oldest first. An unknown dispute reads as none: an empty list. */
export const listEvidenceDocuments = async (
  db: Database,
  disputeId: string,
): Promise<StoredEvidenceDocument[]> => {
  const rows = await db
    .select()
    .from(evidenceDocuments)
    .where(eq(evidenceDocuments.disputeId, disputeId))
    .orderBy(asc(evidenceDocuments.createdAt), asc(evidenceDocuments.id));
  return rows.map(toStored);
};

/**
 * Writes a document once. Returns `written` for a new ID and `unchanged` when the same contents
 * are already stored. Throws `InvalidEvidenceDocumentError` for input that fails
 * `EvidenceDocumentSchema`, and `EvidenceDocumentConflictError` when the ID is stored with other
 * contents.
 */
export const writeEvidenceDocument = async (
  db: Database,
  input: EvidenceDocumentInput,
): Promise<"written" | "unchanged"> => {
  const parsed = EvidenceDocumentSchema.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const path = issue?.path.map(String).join(".") || "document";
    throw new InvalidEvidenceDocumentError(
      `Invalid evidence document: ${path}: ${issue?.message ?? "invalid"}`.replace(/\s+/g, " "),
    );
  }
  const document = parsed.data;
  const size = document.bytes.byteLength;
  const sha256 = sha256Hex(document.bytes);
  const inserted = await db
    .insert(evidenceDocuments)
    .values({ ...document, size, sha256 })
    .onConflictDoNothing({ target: evidenceDocuments.id })
    .returning({ id: evidenceDocuments.id });
  if (inserted.length > 0) return "written";
  const stored = await readEvidenceDocument(db, document.id);
  if (
    stored &&
    stored.disputeId === document.disputeId &&
    stored.kind === document.kind &&
    stored.name === document.name &&
    stored.contentType === document.contentType &&
    stored.createdAt === document.createdAt &&
    sameBytes(stored.bytes, document.bytes)
  )
    return "unchanged";
  throw new EvidenceDocumentConflictError(document.id);
};
