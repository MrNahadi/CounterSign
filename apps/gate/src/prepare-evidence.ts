// `prepare_dispute_evidence` (ADR 0035): a Countersign extension, offered to principal keys only.
// It builds and stores one dispute's evidence pack and answers its masked facts, its documents
// (without their bytes) and the suggested evidence items, in snake_case. It isn't a guarded tool:
// it moves no money, so it isn't decided or logged. It never answers a payer email, a ticket's
// sender or text, or a credential, because the facts hold none. Each failure is one fixed
// sentence. No AI.

import type { CarrierAdapter } from "@countersign/carrier-mock";
import type { Database } from "@countersign/db";
import type { PayPalClient } from "@countersign/rail-paypal";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import {
  buildEvidencePack,
  type EvidenceFacts,
  PACK_MESSAGES,
  type PackDocument,
  type SuggestedItem,
} from "./dispute-evidence";

export const PREPARE_TOOL = "prepare_dispute_evidence";

export const PrepareArgumentsSchema = z.strictObject({
  dispute_id: z.string().regex(/^[A-Za-z0-9-]{1,64}$/),
});

export const PREPARE_DESCRIPTION =
  "Build a dispute's evidence pack from Countersign's records: the dispute, payment, shipping (simulated carrier data), refunds, Countersign's decisions and the audit log, stored as a PDF and an export, with suggested evidence items for provide_dispute_evidence. Moves no money: nothing is decided.";

export const PREPARE_MESSAGES = {
  invalidArguments: `The arguments for ${PREPARE_TOOL} are invalid. Check them against the tool's input schema.`,
  ...PACK_MESSAGES,
} as const;

export type PrepareDeps = {
  db?: Database;
  rail?: () => PayPalClient;
  carrier?: CarrierAdapter;
  clock: () => Date;
};

const snakeKey = (key: string): string => key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);

/** Every object key from camelCase to snake_case, values unchanged. */
export function snakeCase(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(snakeCase);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [snakeKey(key), snakeCase(item)]),
  );
}

/** What the tool answers: the facts, the documents without bytes, and the suggested items. */
export function prepareAnswer(
  facts: EvidenceFacts,
  documents: PackDocument[],
  suggested: SuggestedItem[],
): Record<string, unknown> {
  return {
    dispute: snakeCase(facts.dispute),
    capture: snakeCase(facts.capture),
    order_number: facts.orderNumber,
    shipping: snakeCase(facts.shipping),
    refunds: snakeCase(facts.refunds),
    decisions: snakeCase(facts.decisions),
    audit: snakeCase(facts.audit),
    not_available: facts.notAvailable,
    prepared_at: facts.preparedAt,
    documents: documents.map(({ id, kind, name, size, sha256 }) => ({
      id,
      kind,
      name,
      size,
      sha256,
    })),
    suggested: suggested.map((item) => ({
      evidence_type: item.evidenceType,
      tracking_numbers: item.trackingNumbers,
      refund_ids: item.refundIds,
    })),
  };
}

const failure = (message: string): CallToolResult => ({
  content: [{ type: "text", text: message }],
  isError: true,
});

/** Answers one `prepare_dispute_evidence` call. Never throws. */
export async function callPrepare(
  args: Record<string, unknown> | undefined,
  deps: PrepareDeps,
): Promise<CallToolResult> {
  const parsed = PrepareArgumentsSchema.safeParse(args ?? {});
  if (!parsed.success) return failure(PREPARE_MESSAGES.invalidArguments);
  const { db, carrier } = deps;
  if (db === undefined) return failure(PREPARE_MESSAGES.STORE_FAILED);
  if (carrier === undefined || deps.rail === undefined) {
    return failure(PREPARE_MESSAGES.DISPUTE_UNREADABLE);
  }
  let rail: PayPalClient;
  try {
    rail = deps.rail();
  } catch {
    return failure(PREPARE_MESSAGES.DISPUTE_UNREADABLE);
  }
  try {
    const pack = await buildEvidencePack(parsed.data.dispute_id, {
      db,
      rail,
      carrier,
      now: deps.clock(),
    });
    if (!pack.ok) return failure(pack.message);
    const answer = prepareAnswer(pack.facts, pack.documents, pack.suggested);
    return {
      content: [{ type: "text", text: JSON.stringify(answer) }],
      structuredContent: answer,
      isError: false,
    };
  } catch {
    return failure(PREPARE_MESSAGES.STORE_FAILED);
  }
}
