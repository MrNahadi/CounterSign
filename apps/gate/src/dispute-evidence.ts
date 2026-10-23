// Evidence packs for disputes (ADR 0035): the facts for one dispute, built without AI from
// records, the two write-once documents (the capture's evidence export and the evidence PDF) and
// the suggested evidence items from a fixed table over the facts. A record that can't be read is
// listed as not available and the pack is still built; a dispute that can't be read, or names no
// capture the merchant holds, isn't built. The facts never hold a payer email, a ticket's sender
// or its text. Time is injected. No AI.

import { createHash } from "node:crypto";
import type { CarrierAdapter } from "@countersign/carrier-mock";
import { type Database, eq, seedOrders, sha256Hex, writeEvidenceDocument } from "@countersign/db";
import type { Decision } from "@countersign/mandate";
import {
  type PayPalCapture,
  type PayPalClient,
  type PayPalDisputeDetail,
  PayPalError,
  type PayPalOrder,
} from "@countersign/rail-paypal";
import { CALLS } from "@countersign/verifiers";
import { amountOf, type CardAmount } from "./approval-cards";
import { MAX_PAGE_SIZE, type ReadableDecisionRow, readDecisionRows } from "./audit-reader";
import { CLAIM_WORDS } from "./claims";
import { exportEvidence } from "./evidence-export";
import { buildEvidencePdf } from "./evidence-pdf";
import { DECISION_WORDS, disputeReasonWords, sourceWords } from "./words";

/** The label on every carrier fact: the carrier is simulated in this demo. */
export const CARRIER_SOURCE = sourceWords(CALLS.carrier);

/** The calls a pack reads, named for the "Not available" lines. */
export const PACK_CALLS = {
  dispute: "get-dispute",
  capture: "get-capture",
  order: "get-order",
  carrier: "carrier-shipment",
  orderBook: "seed-orders",
  decisions: "audit-log decisions",
  export: "audit-log export",
} as const;

export type ScanFact = { at: string; description: string; place: string };

export type CarrierFact = {
  source: typeof CARRIER_SOURCE;
  carrierName: string;
  status: string;
  scanEvents: ScanFact[];
};

export type ShippingFact = {
  trackingNumber: string;
  // PayPal's tracker status: SHIPPED or CANCELLED.
  trackerStatus: string;
  // Null when the carrier's record can't be read; the facts' `notAvailable` says which.
  carrier: CarrierFact | null;
};

export type RefundFact = { id: string; amount: CardAmount; status: string };

export type DecisionFact = {
  at: string;
  actionWords: string;
  amount: CardAmount | null;
  decision: Decision;
  decisionWords: string;
  reasons: { code: string; words: string }[];
  claimWords: string | null;
};

export type AuditFact = {
  entryCount: number;
  intact: boolean;
  head: { seq: number; hash: string } | null;
  exportName: string;
  exportSha256: string;
};

export type EvidenceFacts = {
  dispute: {
    id: string;
    status: string;
    reason: string;
    reasonWords: string;
    lifeCycleStage: string;
    amount: CardAmount;
    sellerResponseDueDate: string | null;
  };
  capture: {
    id: string;
    // Null when the capture can't be read.
    amount: CardAmount | null;
    status: string | null;
    time: string | null;
  };
  orderNumber: string | null;
  // Null when the order can't be read, so its trackers are unknown.
  shipping: ShippingFact[] | null;
  // Null when the order can't be read, so its refunds are unknown.
  refunds: RefundFact[] | null;
  // Null when the audit log can't be read.
  decisions: DecisionFact[] | null;
  // Null when no export was made: the log names nothing on the capture, or can't be read.
  audit: AuditFact | null;
  // One line per record that couldn't be read: "Not available: <call>".
  notAvailable: string[];
  preparedAt: string;
};

export const EVIDENCE_TYPES = ["PROOF_OF_FULFILLMENT", "PROOF_OF_REFUND", "OTHER"] as const;
export type EvidenceType = (typeof EVIDENCE_TYPES)[number];

export type SuggestedItem = {
  evidenceType: EvidenceType;
  trackingNumbers: string[];
  refundIds: string[];
  // The document every item carries: the evidence PDF.
  documentId: string;
};

export type PackDocument = {
  id: string;
  kind: "export" | "pdf";
  name: string;
  contentType: string;
  size: number;
  sha256: string;
};

export const PACK_FAILURES = ["DISPUTE_UNREADABLE", "NO_CAPTURE", "STORE_FAILED"] as const;
export type PackFailure = (typeof PACK_FAILURES)[number];

export const PACK_MESSAGES: Record<PackFailure, string> = {
  DISPUTE_UNREADABLE: "The dispute can't be read from PayPal.",
  NO_CAPTURE: "The dispute names no payment this shop holds.",
  STORE_FAILED: "The evidence documents couldn't be stored.",
};

export type EvidencePack =
  | { ok: true; facts: EvidenceFacts; documents: PackDocument[]; suggested: SuggestedItem[] }
  | { ok: false; code: PackFailure; message: string };

export type EvidencePackDeps = {
  db: Database;
  rail: Pick<PayPalClient, "getDispute" | "getCapture" | "getOrder">;
  carrier: CarrierAdapter;
  now: Date;
};

const notAvailable = (call: string, id?: string): string =>
  id === undefined ? `Not available: ${call}` : `Not available: ${call} ${id}`;

const failure = (code: PackFailure): EvidencePack => ({
  ok: false,
  code,
  message: PACK_MESSAGES[code],
});

// A document's ID: `doc_` and 24 hex characters, fixed by what it is and when it was made.
export const DOCUMENT_ID_PATTERN = /^doc_[0-9a-f]{24}$/;

function documentId(disputeId: string, kind: string, sha256: string, at: string): string {
  const digest = createHash("sha256")
    .update(JSON.stringify([disputeId, kind, sha256, at]))
    .digest("hex");
  return `doc_${digest.slice(0, 24)}`;
}

const isNotFound = (error: unknown): boolean =>
  error instanceof PayPalError && error.status === 404;

type HeldCapture = { id: string; capture: PayPalCapture | null };

// The first capture the dispute names that the merchant holds. A capture PayPal says isn't
// there (404) is skipped; one that can't be read for another reason is kept, unread, when no
// later one reads.
async function heldCapture(
  rail: EvidencePackDeps["rail"],
  captureIds: readonly string[],
): Promise<HeldCapture | null> {
  let unread: string | null = null;
  for (const id of captureIds) {
    try {
      const capture = await rail.getCapture(id);
      if (capture.id === id) return { id, capture };
    } catch (error) {
      if (!isNotFound(error) && unread === null) unread = id;
    }
  }
  return unread === null ? null : { id: unread, capture: null };
}

async function shippingOf(
  order: PayPalOrder,
  captureId: string,
  carrier: CarrierAdapter,
  missing: string[],
): Promise<ShippingFact[]> {
  const facts: ShippingFact[] = [];
  const seen = new Set<string>();
  for (const unit of order.purchaseUnits) {
    for (const tracker of unit.trackers) {
      if (tracker.captureId !== captureId || seen.has(tracker.trackingNumber)) continue;
      seen.add(tracker.trackingNumber);
      let fact: CarrierFact | null = null;
      try {
        const lookup = await carrier.getShipment(tracker.trackingNumber);
        if (lookup.kind === "found") {
          fact = {
            source: CARRIER_SOURCE,
            carrierName: lookup.shipment.carrierName,
            status: lookup.shipment.status,
            scanEvents: lookup.shipment.scanEvents.map(({ at, description, place }) => ({
              at,
              description,
              place,
            })),
          };
        }
      } catch {
        fact = null;
      }
      if (fact === null) missing.push(notAvailable(PACK_CALLS.carrier, tracker.trackingNumber));
      facts.push({
        trackingNumber: tracker.trackingNumber,
        trackerStatus: tracker.status,
        carrier: fact,
      });
    }
  }
  return facts;
}

function refundsOf(order: PayPalOrder, captureId: string): RefundFact[] {
  const seen = new Set<string>();
  const facts: RefundFact[] = [];
  for (const unit of order.purchaseUnits) {
    if (!unit.captures.some((capture) => capture.id === captureId)) continue;
    for (const refund of unit.refunds) {
      if (refund.captureId !== null && refund.captureId !== captureId) continue;
      if (seen.has(refund.id)) continue;
      seen.add(refund.id);
      facts.push({ id: refund.id, amount: amountOf(refund.amount), status: refund.status });
    }
  }
  return facts;
}

function decisionFact(row: ReadableDecisionRow): DecisionFact {
  return {
    at: row.at,
    actionWords: row.action_words ?? "Unreadable proposal",
    amount: row.amount,
    decision: row.decision,
    decisionWords: DECISION_WORDS[row.decision],
    reasons: row.reasons.map(({ code, words }) => ({ code, words })),
    claimWords: row.claim ? CLAIM_WORDS[row.claim] : null,
  };
}

// Countersign's decisions on the capture, oldest first. Paged through the audit reader.
async function decisionsOn(db: Database, captureId: string, now: Date): Promise<DecisionFact[]> {
  const rows: ReadableDecisionRow[] = [];
  let before: number | undefined;
  for (;;) {
    const page = await readDecisionRows(
      db,
      { q: captureId, limit: MAX_PAGE_SIZE, ...(before === undefined ? {} : { before }) },
      now,
    );
    for (const row of page.rows) {
      if (row.readable && row.target?.kind === "capture" && row.target.id === captureId) {
        rows.push(row);
      }
    }
    if (page.next_before === null) break;
    before = page.next_before;
  }
  return rows.sort((a, b) => a.seq - b.seq).map(decisionFact);
}

async function orderNumberOf(db: Database, captureId: string): Promise<string | null> {
  const [row] = await db
    .select({ orderNumber: seedOrders.orderNumber })
    .from(seedOrders)
    .where(eq(seedOrders.paypalCaptureId, captureId))
    .limit(1);
  return row?.orderNumber ?? null;
}

/** The suggested evidence items, by the fixed table over the facts. */
export function suggestItems(facts: EvidenceFacts, pdfId: string): SuggestedItem[] {
  const items: SuggestedItem[] = [];
  // A cancelled tracker proves nothing about this payment, whatever the carrier says.
  const delivered = (facts.shipping ?? [])
    .filter((fact) => fact.trackerStatus === "SHIPPED" && fact.carrier?.status === "delivered")
    .map((fact) => fact.trackingNumber);
  if (delivered.length > 0) {
    items.push({
      evidenceType: "PROOF_OF_FULFILLMENT",
      trackingNumbers: delivered,
      refundIds: [],
      documentId: pdfId,
    });
  }
  const refunded = (facts.refunds ?? [])
    .filter((refund) => refund.status === "COMPLETED")
    .map((refund) => refund.id);
  if (refunded.length > 0) {
    items.push({
      evidenceType: "PROOF_OF_REFUND",
      trackingNumbers: [],
      refundIds: refunded,
      documentId: pdfId,
    });
  }
  if (items.length === 0) {
    items.push({ evidenceType: "OTHER", trackingNumbers: [], refundIds: [], documentId: pdfId });
  }
  return items;
}

const disputeFacts = (dispute: PayPalDisputeDetail): EvidenceFacts["dispute"] => ({
  id: dispute.id,
  status: dispute.status,
  reason: dispute.reason,
  reasonWords: disputeReasonWords(dispute.reason),
  lifeCycleStage: dispute.lifeCycleStage,
  amount: amountOf(dispute.amount),
  sellerResponseDueDate: dispute.sellerResponseDueDate,
});

/**
 * Builds and stores one dispute's evidence pack: the facts, the export and the PDF, and the
 * suggested items. Never throws: a dispute that can't be read or names no held capture, or
 * documents that can't be stored, answer a failure with one fixed sentence.
 */
export async function buildEvidencePack(
  disputeId: string,
  deps: EvidencePackDeps,
): Promise<EvidencePack> {
  const { db, rail, carrier, now } = deps;
  const preparedAt = now.toISOString();

  let dispute: PayPalDisputeDetail;
  try {
    dispute = await rail.getDispute(disputeId);
  } catch {
    return failure("DISPUTE_UNREADABLE");
  }
  if (dispute.id !== disputeId) return failure("DISPUTE_UNREADABLE");

  const held = await heldCapture(rail, dispute.captureIds);
  if (held === null) return failure("NO_CAPTURE");
  const captureId = held.id;
  const missing: string[] = [];
  if (held.capture === null) missing.push(notAvailable(PACK_CALLS.capture, captureId));

  let order: PayPalOrder | null = null;
  const orderId = held.capture?.orderId ?? null;
  if (orderId !== null) {
    try {
      const read = await rail.getOrder(orderId);
      if (read.id === orderId) order = read;
    } catch {
      order = null;
    }
  }
  if (order === null) missing.push(notAvailable(PACK_CALLS.order, orderId ?? undefined));

  let orderNumber: string | null = null;
  try {
    orderNumber = await orderNumberOf(db, captureId);
  } catch {
    missing.push(notAvailable(PACK_CALLS.orderBook));
  }

  const shipping = order === null ? null : await shippingOf(order, captureId, carrier, missing);
  const refunds = order === null ? null : refundsOf(order, captureId);

  let decisions: DecisionFact[] | null = null;
  try {
    decisions = await decisionsOn(db, captureId, now);
  } catch {
    missing.push(notAvailable(PACK_CALLS.decisions));
  }

  // The capture's evidence export, stored as the API answers it.
  let exportBytes: Uint8Array | null = null;
  let audit: AuditFact | null = null;
  try {
    const exported = await exportEvidence(db, { kind: "capture", id: captureId }, now);
    if (exported.kind === "file") {
      exportBytes = new TextEncoder().encode(`${JSON.stringify(exported.file, null, 2)}\n`);
      const { chain, entries } = exported.file;
      audit = {
        entryCount: entries.length,
        intact: chain.intact,
        head: chain.head,
        exportName: exportName(captureId),
        exportSha256: sha256Hex(exportBytes),
      };
    }
  } catch {
    missing.push(notAvailable(PACK_CALLS.export));
  }

  const facts: EvidenceFacts = {
    dispute: disputeFacts(dispute),
    capture: {
      id: captureId,
      amount: held.capture ? amountOf(held.capture.amount) : null,
      status: held.capture?.status ?? null,
      time: held.capture?.createTime ?? null,
    },
    orderNumber,
    shipping,
    refunds,
    decisions,
    audit,
    notAvailable: missing,
    preparedAt,
  };

  try {
    const documents: PackDocument[] = [];
    if (exportBytes !== null && audit !== null) {
      documents.push(
        await store(db, {
          disputeId,
          kind: "export",
          name: audit.exportName,
          contentType: "application/json",
          bytes: exportBytes,
          createdAt: preparedAt,
        }),
      );
    }
    const pdfBytes = await buildEvidencePdf(facts, now);
    const pdf = await store(db, {
      disputeId,
      kind: "pdf",
      name: pdfName(disputeId),
      contentType: "application/pdf",
      bytes: pdfBytes,
      createdAt: preparedAt,
    });
    documents.push(pdf);
    return { ok: true, facts, documents, suggested: suggestItems(facts, pdf.id) };
  } catch {
    return failure("STORE_FAILED");
  }
}

export const exportName = (captureId: string): string =>
  `countersign-evidence-capture-${captureId}.json`;

export const pdfName = (disputeId: string): string => `countersign-evidence-${disputeId}.pdf`;

async function store(
  db: Database,
  input: {
    disputeId: string;
    kind: "export" | "pdf";
    name: string;
    contentType: string;
    bytes: Uint8Array;
    createdAt: string;
  },
): Promise<PackDocument> {
  const sha256 = sha256Hex(input.bytes);
  const id = documentId(input.disputeId, input.kind, sha256, input.createdAt);
  await writeEvidenceDocument(db, { id, ...input });
  return {
    id,
    kind: input.kind,
    name: input.name,
    contentType: input.contentType,
    size: input.bytes.byteLength,
    sha256,
  };
}
