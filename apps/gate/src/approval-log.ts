// Step-ups and their answers in the audit log (ADR 0032): what an `approval` entry holds, a
// writer that builds only valid ones, and the step-up reader. A step-up is a `decision` entry
// whose decision is `step_up` and that has an intent; its ID is the entry's `seq`. Whether it's
// open, answered or expired is worked out here from the log and an injected time, never stored.
// No AI, and no network.

import { asc, auditLog, type Database, sql } from "@countersign/db";
import type { ChainRow, EntryInput, Transaction } from "@countersign/ledger";
import {
  ACTIONS,
  CLAIMS,
  CURRENCIES,
  DECISIONS,
  IdSchema as Id,
  type Intent,
  RAILS,
  ReasonCodeSchema,
  SHIPMENT_STATUSES,
  TimestampSchema,
  VERIFIER_RESULTS,
  VERIFIERS,
} from "@countersign/mandate";
import { z } from "zod";
import { AgentResponseSchema } from "./decide";

const Seq = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const Hash = z.string().regex(/^[0-9a-f]{64}$/, "Must be a SHA-256 hash in lowercase hex");
const IntentId = z.string().regex(/^int_[0-9a-f]{24}$/, "Must be an intent ID");

// --- The `approval` entry ------------------------------------------------------------------

export const APPROVAL_ANSWERS = ["approve", "deny"] as const;
export type ApprovalAnswer = (typeof APPROVAL_ANSWERS)[number];

export const APPROVAL_CHANNELS = ["approvals_page", "cli"] as const;
export type ApprovalChannel = (typeof APPROVAL_CHANNELS)[number];

// Checked in this order; the first that fails is the one code a rejection records.
export const APPROVAL_REJECTION_CODES = [
  "HASH_MISMATCH",
  "ALREADY_ANSWERED",
  "EXPIRED",
  "ALREADY_REQUESTED",
  "ACTION_UNAVAILABLE",
  "DUPLICATE_REFUND",
] as const;
export type ApprovalRejectionCode = (typeof APPROVAL_REJECTION_CODES)[number];

// The codes only an `approve` can be rejected with.
const APPROVE_ONLY_CODES: readonly ApprovalRejectionCode[] = [
  "ALREADY_REQUESTED",
  "ACTION_UNAVAILABLE",
  "DUPLICATE_REFUND",
];

const AnswerCommon = {
  stepUpSeq: Seq,
  // The intent hash the approver was shown and sent back, as sent.
  intentHash: Hash,
  // The one approver while there's one merchant (brief §5, Out of scope).
  approver: z.literal("merchant"),
  channel: z.enum(APPROVAL_CHANNELS),
};

// `approval`, ref the intent ID. Its `at` is the answer time.
export const ApprovalPayloadSchema = z
  .discriminatedUnion("outcome", [
    z.strictObject({
      ...AnswerCommon,
      answer: z.literal("approve"),
      outcome: z.literal("approved"),
    }),
    z.strictObject({ ...AnswerCommon, answer: z.literal("deny"), outcome: z.literal("denied") }),
    z.strictObject({
      ...AnswerCommon,
      answer: z.enum(APPROVAL_ANSWERS),
      outcome: z.literal("rejected"),
      code: z.enum(APPROVAL_REJECTION_CODES),
    }),
  ])
  .refine(
    (payload) =>
      payload.outcome !== "rejected" ||
      payload.answer === "approve" ||
      !APPROVE_ONLY_CODES.includes(payload.code),
    { message: "Only an approve can be rejected with this code", path: ["code"] },
  );
export type ApprovalPayload = z.infer<typeof ApprovalPayloadSchema>;
export type ApprovalOutcome = ApprovalPayload["outcome"];

export type ApprovalInput = { at: string; intentId: string } & ApprovalPayload;

// Builds an `approval` entry for the ledger's append, and throws on any other shape, so nothing
// invalid is ever written.
export function approvalEntry(input: ApprovalInput): EntryInput {
  const { at, intentId, ...payload } = input;
  TimestampSchema.parse(at);
  IntentId.parse(intentId);
  return {
    entryType: "approval",
    refId: intentId,
    at,
    payload: ApprovalPayloadSchema.parse(payload),
  } satisfies EntryInput;
}

// --- What a step-up's decision entry holds -------------------------------------------------

const MoneySchema = z.strictObject({
  minor: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  currency: z.enum(CURRENCIES),
});

const TargetSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("capture"), captureId: Id, orderId: Id.nullable() }),
  z.strictObject({ kind: z.literal("dispute"), disputeId: Id }),
  z.strictObject({ kind: z.literal("invoice"), invoiceId: Id }),
  z.strictObject({ kind: z.literal("order"), orderId: Id }),
  z.strictObject({ kind: z.literal("payee"), email: z.string().min(1) }),
]);

const ParamsSchema = z.strictObject({
  note: z.string().nullable().optional(),
  evidence: z
    .array(
      z.strictObject({
        evidenceType: z.string(),
        notes: z.string(),
        trackingNumbers: z.array(z.string()).nullable().optional(),
      }),
    )
    .nullable()
    .optional(),
  offerType: z.string().nullable().optional(),
  sendToRecipient: z.boolean().nullable().optional(),
  additionalRecipients: z.array(z.string()).nullable().optional(),
});

// The stored intent, kept exactly as decided so its hash can be checked again.
const IntentSchema = z.strictObject({
  principal: Id,
  rail: z.enum(RAILS),
  action: z.enum(ACTIONS),
  amount: MoneySchema,
  target: TargetSchema,
  ticketId: Id.nullable(),
  params: ParamsSchema.optional(),
  claim: z.enum(CLAIMS).nullable(),
  mandateVersion: z.number().int().positive(),
}) satisfies z.ZodType<Intent>;

const TraceEntrySchema = z.object({
  verifier: z.enum(VERIFIERS),
  result: z.enum(VERIFIER_RESULTS),
  records: z.array(z.object({ call: z.string(), id: z.string().nullable() })),
  detail: z.string(),
  value: z.enum(SHIPMENT_STATUSES).optional(),
});

const ReasonSchema = z.object({ code: ReasonCodeSchema, detail: z.string() });

// Every decision entry is read this far, to tell a step-up from any other decision.
const AnyDecisionSchema = z.object({
  record: z.object({ decision: z.enum(DECISIONS), intentId: IntentId.nullable() }),
});

// A step-up's decision entry, read in full.
const StepUpPayloadSchema = z.object({
  principal: Id,
  record: z.object({
    intent: IntentSchema,
    intentId: IntentId,
    intentHash: Hash,
    intentCanonical: z.string().min(1),
    mandate: z.object({ id: Id, version: z.number().int().positive(), hash: Hash }),
    trace: z.array(TraceEntrySchema),
    matchedRules: z.array(z.string()),
    decision: z.literal("step_up"),
    reasons: z.array(ReasonSchema).min(1),
    decidedAt: TimestampSchema,
  }),
  response: AgentResponseSchema,
});
type StepUpPayload = z.infer<typeof StepUpPayloadSchema>;

// --- The step-up reader --------------------------------------------------------------------

export const STEP_UP_STATES = ["open", "answered", "expired"] as const;
export type StepUpState = (typeof STEP_UP_STATES)[number];

// The answer that closed a step-up: the first approved or denied `approval` entry for its intent
// that comes after it.
export type StepUpAnswer = {
  seq: number;
  at: string;
  outcome: "approved" | "denied";
  channel: ApprovalChannel;
};

export type StepUp = {
  // The decision entry's `seq`, shown as the step-up ID.
  seq: number;
  intentId: string;
  intentHash: string;
  // The exact canonical JSON the intent hash covers (ADR 0020).
  intentCanonical: string;
  intent: Intent;
  principal: string;
  mandate: StepUpPayload["record"]["mandate"];
  trace: StepUpPayload["record"]["trace"];
  matchedRules: string[];
  reasons: StepUpPayload["record"]["reasons"];
  decidedAt: string;
  expiresAt: string;
  state: StepUpState;
  // Null unless the state is answered.
  answer: StepUpAnswer | null;
};

// The most answered or expired step-ups a read lists.
export const RECENT_STEP_UPS = 20;

export type StepUpList = {
  // One per intent, its newest open step-up, newest first.
  open: StepUp[];
  // The last answered or expired step-ups, newest first.
  recent: StepUp[];
};

export type StepUpListRead =
  | ({ known: true } & StepUpList)
  // An entry couldn't be read, so nothing about the step-ups is known.
  | { known: false; seq: number; detail: string };

export type StepUpRead =
  // `stepUp` is null when the `seq` isn't a step-up.
  { known: true; stepUp: StepUp | null } | { known: false; seq: number; detail: string };

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

// The step-up a decision entry is, or null for any other decision.
function stepUpOf(row: ChainRow): Omit<StepUp, "state" | "answer"> | null {
  const { record } = parsePayload(row, AnyDecisionSchema);
  if (row.refId !== record.intentId) {
    throw new Unreadable(row.seq, `decision #${row.seq} has a ref that isn't its intent`);
  }
  if (record.decision !== "step_up" || record.intentId === null) return null;
  const payload = parsePayload(row, StepUpPayloadSchema);
  const { response } = payload;
  if (response.decision !== "pending_approval" || response.intent_id !== record.intentId) {
    throw new Unreadable(row.seq, `decision #${row.seq} is a step-up without a pending response`);
  }
  const full = payload.record;
  return {
    seq: row.seq,
    intentId: full.intentId,
    intentHash: full.intentHash,
    intentCanonical: full.intentCanonical,
    intent: full.intent,
    principal: payload.principal,
    mandate: full.mandate,
    trace: full.trace,
    matchedRules: full.matchedRules,
    reasons: full.reasons,
    decidedAt: full.decidedAt,
    expiresAt: response.expires_at,
  };
}

// Every step-up in the log, oldest first, with its state at `now`.
function buildStepUps(rows: readonly ChainRow[], now: Date): StepUp[] {
  const stepUps: StepUp[] = [];
  const bySeq = new Map<number, StepUp>();
  // Each intent's step-ups that no answer has closed yet.
  const unanswered = new Map<string, StepUp[]>();

  for (const row of rows) {
    if (row.entryType === "decision") {
      const found = stepUpOf(row);
      if (found === null) continue;
      const stepUp: StepUp = { ...found, state: "open", answer: null };
      stepUps.push(stepUp);
      bySeq.set(stepUp.seq, stepUp);
      const waiting = unanswered.get(stepUp.intentId) ?? [];
      waiting.push(stepUp);
      unanswered.set(stepUp.intentId, waiting);
    } else {
      const payload = parsePayload(row, ApprovalPayloadSchema);
      const answered = bySeq.get(payload.stepUpSeq);
      if (answered === undefined || answered.intentId !== row.refId) {
        throw new Unreadable(
          row.seq,
          `approval #${row.seq} answers #${payload.stepUpSeq}, which isn't an earlier step-up of its intent`,
        );
      }
      // A rejected answer leaves every step-up as it was.
      if (payload.outcome === "rejected") continue;
      const answer: StepUpAnswer = {
        seq: row.seq,
        at: row.at,
        outcome: payload.outcome,
        channel: payload.channel,
      };
      // One answer closes every earlier step-up of the intent.
      for (const stepUp of unanswered.get(answered.intentId) ?? []) {
        stepUp.state = "answered";
        stepUp.answer = answer;
      }
      unanswered.delete(answered.intentId);
    }
  }

  const time = now.getTime();
  for (const stepUp of stepUps) {
    if (stepUp.state === "open" && time > Date.parse(stepUp.expiresAt)) stepUp.state = "expired";
  }
  return stepUps;
}

async function readRows(reader: Reader): Promise<ChainRow[]> {
  return reader
    .select()
    .from(auditLog)
    .where(sql`${auditLog.entryType} IN ('decision', 'approval')`)
    .orderBy(asc(auditLog.seq));
}

function listOf(stepUps: readonly StepUp[]): StepUpList {
  const newestFirst = [...stepUps].reverse();
  const open: StepUp[] = [];
  const carded = new Set<string>();
  for (const stepUp of newestFirst) {
    if (stepUp.state !== "open" || carded.has(stepUp.intentId)) continue;
    carded.add(stepUp.intentId);
    open.push(stepUp);
  }
  const recent = newestFirst.filter((stepUp) => stepUp.state !== "open").slice(0, RECENT_STEP_UPS);
  return { open, recent };
}

// Reads the open step-ups and the recent answered or expired ones at `now`. A database that
// can't be read throws; an entry that can't be read makes the read unknown, never skipped.
export async function readStepUps(reader: Reader, now: Date): Promise<StepUpListRead> {
  const rows = await readRows(reader);
  try {
    return { known: true, ...listOf(buildStepUps(rows, now)) };
  } catch (error) {
    if (error instanceof Unreadable) return { known: false, seq: error.seq, detail: error.message };
    throw error;
  }
}

// Reads one step-up by its `seq` at `now`. Any `seq` that isn't a step-up reads as null. Pass a
// transaction to read under the ledger's lock.
export async function readStepUp(reader: Reader, seq: number, now: Date): Promise<StepUpRead> {
  const rows = await readRows(reader);
  try {
    const stepUp = buildStepUps(rows, now).find((candidate) => candidate.seq === seq) ?? null;
    return { known: true, stepUp };
  } catch (error) {
    if (error instanceof Unreadable) return { known: false, seq: error.seq, detail: error.message };
    throw error;
  }
}
