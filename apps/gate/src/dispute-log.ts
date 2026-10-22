// The `dispute.received` entry in the audit log (ADR 0035): what it holds, a builder that makes
// only valid ones from a dispute re-read from PayPal, and a reader for the dispute IDs and
// webhook event IDs already recorded. No AI, and no network.

import { asc, auditLog, type Database, eq } from "@countersign/db";
import type { ChainRow, EntryInput, Transaction } from "@countersign/ledger";
import { CURRENCIES, IdSchema as Id, TimestampSchema } from "@countersign/mandate";
import type { PayPalDisputeDetail } from "@countersign/rail-paypal";
import { z } from "zod";

const MoneySchema = z.strictObject({
  minor: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  currency: z.enum(CURRENCIES),
});

// The dispute as re-read from PayPal, never the event body.
const DisputeSchema = z.strictObject({
  status: z.string().min(1),
  reason: z.string().min(1),
  lifeCycleStage: z.string().min(1),
  amount: MoneySchema,
  sellerResponseDueDate: z.string().min(1).nullable(),
  captureIds: z.array(Id),
});

// `dispute.received`, ref the dispute ID. `event` is the webhook event that announced it, or
// null when `npm run disputes -- sync` found it.
export const DisputeReceivedPayloadSchema = z.discriminatedUnion("source", [
  z.strictObject({
    disputeId: Id,
    source: z.literal("webhook"),
    event: z.strictObject({ id: Id, type: Id }),
    dispute: DisputeSchema,
  }),
  z.strictObject({
    disputeId: Id,
    source: z.literal("poll"),
    event: z.null(),
    dispute: DisputeSchema,
  }),
]);
export type DisputeReceivedPayload = z.infer<typeof DisputeReceivedPayloadSchema>;

export type DisputeReceivedInput = {
  at: string;
  // The dispute as re-read with get dispute.
  dispute: PayPalDisputeDetail;
} & ({ source: "webhook"; event: { id: string; type: string } } | { source: "poll"; event?: null });

// Builds a `dispute.received` entry for the ledger's append, and throws on any shape its schema
// refuses, so nothing invalid is ever written.
export function disputeReceivedEntry(input: DisputeReceivedInput): EntryInput {
  const { at, dispute } = input;
  TimestampSchema.parse(at);
  const payload = DisputeReceivedPayloadSchema.parse({
    disputeId: dispute.id,
    source: input.source,
    event: input.source === "webhook" ? input.event : null,
    dispute: {
      status: dispute.status,
      reason: dispute.reason,
      lifeCycleStage: dispute.lifeCycleStage,
      amount: dispute.amount,
      sellerResponseDueDate: dispute.sellerResponseDueDate,
      captureIds: dispute.captureIds,
    },
  });
  return { entryType: "dispute.received", refId: payload.disputeId, at, payload };
}

type Reader = Database | Transaction;

export type DisputeState = {
  // Every dispute with a `dispute.received` entry.
  disputes: Set<string>;
  // Every webhook event ID already recorded.
  events: Set<string>;
};

export type DisputeStateRead =
  | { known: true; state: DisputeState }
  // An entry couldn't be read, so nothing is known: a dispute is never taken as new.
  | { known: false; seq: number; detail: string };

function unreadable(row: ChainRow, detail: string): DisputeStateRead {
  return { known: false, seq: row.seq, detail: `dispute.received #${row.seq} ${detail}` };
}

// Reads which disputes and webhook events the log already holds. An entry that can't be read
// makes the state unknown, never skipped.
export async function readDisputeState(reader: Reader): Promise<DisputeStateRead> {
  const rows: ChainRow[] = await reader
    .select()
    .from(auditLog)
    .where(eq(auditLog.entryType, "dispute.received"))
    .orderBy(asc(auditLog.seq));
  const state: DisputeState = { disputes: new Set(), events: new Set() };
  for (const row of rows) {
    let value: unknown;
    try {
      value = JSON.parse(row.payload);
    } catch {
      return unreadable(row, "isn't valid JSON");
    }
    const parsed = DisputeReceivedPayloadSchema.safeParse(value);
    if (!parsed.success) {
      const [issue] = parsed.error.issues;
      const where = issue && issue.path.length > 0 ? ` at ${issue.path.join(".")}` : "";
      return unreadable(row, `can't be read${where}: ${issue?.message ?? "invalid"}`);
    }
    if (row.refId !== parsed.data.disputeId)
      return unreadable(row, "has a ref that isn't its dispute");
    state.disputes.add(parsed.data.disputeId);
    if (parsed.data.event !== null) state.events.add(parsed.data.event.id);
  }
  return { known: true, state };
}
