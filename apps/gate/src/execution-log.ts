// Execution entries in the audit log (ADR 0026): what a request, a result and a reconciliation
// hold, writers that build only valid entries, and the execution history read back from the log
// as the ExecutionSnapshots the verifiers use. No AI, and no network.

import { asc, auditLog, type Database, sql } from "@countersign/db";
import type { ChainRow, EntryInput, Transaction } from "@countersign/ledger";
import {
  ACTIONS,
  CURRENCIES,
  IdSchema as Id,
  type Money,
  RAILS,
  TimestampSchema,
} from "@countersign/mandate";
import { REFUND_STATUSES } from "@countersign/rail-paypal";
import { CALLS, type ExecutionSnapshot } from "@countersign/verifiers";
import { z } from "zod";
import { proposalText } from "./record";

const MoneySchema = z.strictObject({
  minor: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  currency: z.enum(CURRENCIES),
});
const Seq = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const Hash = z.string().regex(/^[0-9a-f]{64}$/, "Must be a SHA-256 hash in lowercase hex");

// --- Payload schemas -----------------------------------------------------------------------

const RequestCommon = {
  intentId: Id,
  intentHash: Hash,
  principal: Id,
  rail: z.enum(RAILS),
  action: z.enum(ACTIONS),
  // Null for an action with no capture, such as a payout.
  captureId: Id.nullable(),
  amount: MoneySchema,
  // The rail's idempotency key: PayPal-Request-Id, always the intent hash (ADR 0003).
  requestId: Hash,
};

// `execution.requested`, ref the intent ID. Written before the rail call. A first request
// points at the decision entry that allowed it; a replay points at the first request and keeps
// the raw proposal it came with.
export const ExecutionRequestedPayloadSchema = z
  .discriminatedUnion("replay", [
    z.strictObject({ ...RequestCommon, replay: z.literal(false), decisionSeq: Seq }),
    z.strictObject({
      ...RequestCommon,
      replay: z.literal(true),
      firstRequestSeq: Seq,
      proposal: z.string(),
      proposalTruncated: z.boolean(),
    }),
  ])
  .refine((payload) => payload.requestId === payload.intentHash, {
    message: "The request ID must be the intent hash",
    path: ["requestId"],
  });
export type ExecutionRequestedPayload = z.infer<typeof ExecutionRequestedPayloadSchema>;

// What PayPal said when it refused, never a token or header.
const RailErrorSchema = z.strictObject({
  name: z.string().nullable(),
  issues: z.array(z.string()),
  debugId: z.string().nullable(),
});

const refundOf = (statuses: readonly [string, ...string[]]) =>
  z.strictObject({ id: Id, status: z.enum(statuses) });

// `execution.result`, ref the intent ID. Its time is the entry's `at`.
export const ExecutionResultPayloadSchema = z.discriminatedUnion("outcome", [
  z.strictObject({
    requestSeq: Seq,
    outcome: z.literal("executed"),
    refund: refundOf(["COMPLETED", "PENDING"]),
  }),
  z
    .strictObject({
      requestSeq: Seq,
      outcome: z.literal("failed"),
      refund: refundOf(["FAILED", "CANCELLED"]).optional(),
      error: RailErrorSchema.optional(),
    })
    .refine((payload) => payload.refund !== undefined || payload.error !== undefined, {
      message: "A failed result needs the refused refund or PayPal's error",
    }),
  z.strictObject({
    requestSeq: Seq,
    outcome: z.literal("unknown"),
    refund: refundOf(REFUND_STATUSES).optional(),
    error: RailErrorSchema.optional(),
  }),
]);
export type ExecutionResultPayload = z.infer<typeof ExecutionResultPayloadSchema>;
export type ExecutionOutcome = ExecutionResultPayload["outcome"];

const ReconciledRefundSchema = z.strictObject({
  id: Id,
  captureId: Id.nullable(),
  status: z.enum(REFUND_STATUSES),
  amount: MoneySchema,
});

// `reconciliation`, ref the intent ID, or null for a refund Countersign didn't make. The refund
// is as re-read from PayPal; `resultSeq` is the matched result, null when none matched.
export const ReconciliationPayloadSchema = z.discriminatedUnion("source", [
  z.strictObject({
    source: z.literal("webhook"),
    event: z.strictObject({ id: Id, type: Id }),
    refund: ReconciledRefundSchema,
    resultSeq: Seq.nullable(),
  }),
  z.strictObject({
    source: z.literal("poll"),
    refund: ReconciledRefundSchema,
    resultSeq: Seq.nullable(),
  }),
]);
export type ReconciliationPayload = z.infer<typeof ReconciliationPayloadSchema>;

// --- Writers -------------------------------------------------------------------------------
// Each builds an entry for the ledger's append and throws on a payload its schema refuses, so
// nothing invalid is ever written.

export type ExecutionRequestInput = {
  at: string;
  intentId: string;
  intentHash: string;
  principal: string;
  rail: (typeof RAILS)[number];
  action: (typeof ACTIONS)[number];
  captureId: string | null;
  amount: Money;
} & (
  | { decisionSeq: number; replayOf?: undefined }
  | { replayOf: { firstRequestSeq: number; proposal: unknown }; decisionSeq?: undefined }
);

function entry(entryType: string, refId: string | null, at: string, payload: unknown) {
  TimestampSchema.parse(at);
  return { entryType, refId, at, payload } satisfies EntryInput;
}

export function executionRequestedEntry(input: ExecutionRequestInput): EntryInput {
  const { at, intentId, intentHash, principal, rail, action, captureId, amount } = input;
  const common = {
    intentId,
    intentHash,
    principal,
    rail,
    action,
    captureId,
    amount,
    requestId: intentHash,
  };
  const replay = input.replayOf;
  const payload =
    replay === undefined
      ? { ...common, replay: false, decisionSeq: input.decisionSeq }
      : (() => {
          const { text, truncated } = proposalText(replay.proposal);
          return {
            ...common,
            replay: true,
            firstRequestSeq: replay.firstRequestSeq,
            proposal: text,
            proposalTruncated: truncated,
          };
        })();
  return entry("execution.requested", intentId, at, ExecutionRequestedPayloadSchema.parse(payload));
}

export type ExecutionResultInput = { at: string; intentId: string } & ExecutionResultPayload;

export function executionResultEntry(input: ExecutionResultInput): EntryInput {
  const { at, intentId, ...payload } = input;
  Id.parse(intentId);
  return entry("execution.result", intentId, at, ExecutionResultPayloadSchema.parse(payload));
}

export type ReconciliationInput = { at: string; intentId: string | null } & ReconciliationPayload;

export function reconciliationEntry(input: ReconciliationInput): EntryInput {
  const { at, intentId, ...payload } = input;
  Id.nullable().parse(intentId);
  return entry("reconciliation", intentId, at, ReconciliationPayloadSchema.parse(payload));
}

// --- The execution history -----------------------------------------------------------------

export type ExecutionHistory =
  | { known: true; executions: ExecutionSnapshot[] }
  // An entry of these types couldn't be read, so nothing about the history is known.
  | { known: false; seq: number; detail: string };

type Reader = Database | Transaction;

class Unreadable extends Error {
  readonly seq: number;
  constructor(seq: number, detail: string) {
    super(detail);
    this.seq = seq;
  }
}

function parsePayload<T>(row: ChainRow, schema: z.ZodType<T>): T {
  let value: unknown;
  try {
    value = JSON.parse(row.payload);
  } catch {
    throw new Unreadable(row.seq, `${row.entryType} #${row.seq} isn't valid JSON`);
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    const [issue] = parsed.error.issues;
    const where = issue && issue.path.length > 0 ? ` at ${issue.path.join(".")}` : "";
    throw new Unreadable(
      row.seq,
      `${row.entryType} #${row.seq} can't be read${where}: ${issue?.message ?? "invalid"}`,
    );
  }
  return parsed.data;
}

type Requested = { row: ChainRow; payload: ExecutionRequestedPayload };

// One intent's requests and results, in seq order.
type IntentTrail = {
  first: Requested;
  // The intent's latest entry is a failed result, so its last attempt moved no money.
  lastFailed: boolean;
};

function buildHistory(rows: readonly ChainRow[]): ExecutionSnapshot[] {
  const requests = new Map<number, Requested>();
  const trails = new Map<string, IntentTrail>();
  // Every first request in log order; a replay never adds one.
  const firsts: Requested[] = [];

  for (const row of rows) {
    if (row.entryType === "execution.requested") {
      const payload = parsePayload(row, ExecutionRequestedPayloadSchema);
      if (row.refId !== payload.intentId) {
        throw new Unreadable(
          row.seq,
          `execution.requested #${row.seq} has a ref that isn't its intent`,
        );
      }
      const requested = { row, payload };
      requests.set(row.seq, requested);
      if (payload.replay) {
        const first = requests.get(payload.firstRequestSeq);
        const trail = trails.get(payload.intentId);
        if (first === undefined || first.payload.intentId !== payload.intentId || !trail) {
          throw new Unreadable(
            row.seq,
            `execution.requested #${row.seq} replays #${payload.firstRequestSeq}, which isn't a request for its intent`,
          );
        }
        trail.lastFailed = false;
      } else {
        firsts.push(requested);
        // A second first request for one intent shouldn't happen; counting it is the safe side.
        trails.set(payload.intentId, { first: requested, lastFailed: false });
      }
    } else if (row.entryType === "execution.result") {
      const payload = parsePayload(row, ExecutionResultPayloadSchema);
      const request = requests.get(payload.requestSeq);
      const trail = row.refId === null ? undefined : trails.get(row.refId);
      if (request === undefined || request.payload.intentId !== row.refId || !trail) {
        throw new Unreadable(
          row.seq,
          `execution.result #${row.seq} names request #${payload.requestSeq}, which isn't a request for its intent`,
        );
      }
      trail.lastFailed = payload.outcome === "failed";
    } else {
      parsePayload(row, ReconciliationPayloadSchema);
    }
  }

  return firsts
    .filter((first) => {
      const trail = trails.get(first.payload.intentId);
      return !(trail?.first === first && trail.lastFailed);
    })
    .map(({ row, payload }) => ({
      call: CALLS.executions,
      id: payload.intentId,
      principal: payload.principal,
      captureId: payload.captureId,
      amount: payload.amount,
      executedAt: row.at,
    }));
}

// Reads the whole execution history. A request counts as executed unless the intent's latest
// request or result is a failed result (ADR 0026): a request with no result, or an unknown
// result, counts. Pass the deciding transaction so the read sees its own appends and holds the
// ledger's lock. A database that can't be read throws; an entry that can't be read makes the
// history unknown, never skipped.
export async function readExecutionHistory(reader: Reader): Promise<ExecutionHistory> {
  const rows: ChainRow[] = await reader
    .select()
    .from(auditLog)
    .where(
      sql`${auditLog.entryType} IN ('execution.requested', 'execution.result', 'reconciliation')`,
    )
    .orderBy(asc(auditLog.seq));
  try {
    return { known: true, executions: buildHistory(rows) };
  } catch (error) {
    if (error instanceof Unreadable) return { known: false, seq: error.seq, detail: error.message };
    throw error;
  }
}
