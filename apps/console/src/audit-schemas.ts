import { z } from "zod";

// What the gate's audit API answers (ADR 0034), as the console's routes and audit pages read it,
// and the requests the console sends it. Every answer is parsed with these before anything uses
// it, and only the fields named here are passed on; an answer that doesn't parse is junk. Plain
// zod only, so a client component can import them.

const Text = z.string().max(4096);
const LongText = z.string().max(65_536);
const Id = z.string().min(1).max(256);
const Time = z.string().min(1).max(64);
const Name = z.string().regex(/^[a-z0-9_.]{1,64}$/);
const Code = z.string().regex(/^[A-Z0-9_]{1,64}$/);
const Seq = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const Count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
// A stored hash is shown as it is, so a tampered one still reads; an intent hash is SHA-256.
const StoredHash = z.string().min(1).max(128);
const IntentHash = z.string().regex(/^[0-9a-f]{64}$/);

export const DECISION_KINDS = ["allow", "step_up", "deny"] as const;
export const CLAIM_VERDICTS = [
  "matches",
  "contradicts",
  "passes",
  "fails",
  "no_record",
  "not_used",
] as const;

const MoneySchema = z.object({
  minor: z.number().int(),
  currency: z.string().regex(/^[A-Z]{3}$/),
  display: z.string().min(1).max(64),
});

const RecordRef = z.object({ id: Id, status: z.string().min(1).max(64) });

// A dispute's status is null when the gate couldn't re-read it after the call.
const DisputeRef = z.object({ id: Id, status: z.string().min(1).max(64).nullable() });

const ExecutionSchema = z.object({
  outcome: z.enum(["executed", "failed", "unknown", "pending"]),
  refund: RecordRef.nullable(),
  invoice: RecordRef.nullable(),
  dispute: DisputeRef.nullable().optional(),
});

const StatusSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.enum(["executed", "failed", "unknown", "pending"]),
    execution: ExecutionSchema,
  }),
  z.object({ kind: z.literal("approved"), execution: ExecutionSchema }),
  z.object({
    kind: z.enum(["not_executable", "open", "denied", "expired"]),
    execution: z.null(),
  }),
]);

// `unknown` is also a step-up whose answer can't be read, which carries no execution.
const RowStatusSchema = z.union([
  StatusSchema,
  z.object({ kind: z.literal("unknown"), execution: z.null() }),
]);

const ReadableRowFields = {
  readable: z.literal(true),
  seq: Seq,
  at: Time,
  principal: Id,
  intent_id: Id.nullable(),
  action: Name.nullable(),
  action_words: z.string().min(1).max(64).nullable(),
  amount: MoneySchema.nullable(),
  target: z
    .object({
      kind: z.enum(["capture", "dispute", "invoice", "order", "payee"]),
      id: Id,
      order_id: Id.nullable(),
    })
    .nullable(),
  order_number: Id.nullable(),
  sender: Id.nullable(),
  claim: z.enum(["not_received", "damaged", "wrong_item"]).nullable(),
  claim_words: Text.nullable(),
  decision: z.enum(DECISION_KINDS),
  reasons: z.array(z.object({ code: Code, words: Text, detail: Text })).max(64),
  matched_rules: z.array(Id).max(64),
  status: RowStatusSchema.nullable(),
};

const UnreadableRowSchema = z.object({
  readable: z.literal(false),
  seq: Seq,
  at: Time,
  problem: Text,
});

export const DecisionRowSchema = z.discriminatedUnion("readable", [
  z.object(ReadableRowFields),
  UnreadableRowSchema,
]);
export type DecisionRow = z.infer<typeof DecisionRowSchema>;

export const DecisionRowsPageSchema = z.object({
  rows: z.array(DecisionRowSchema).max(200),
  counts: z.object({ all: Count, allowed: Count, stepped_up: Count, denied: Count }),
  next_before: Seq.nullable(),
});
export type DecisionRowsPage = z.infer<typeof DecisionRowsPageSchema>;

const SourceSchema = z.object({ words: Text, call: Text, id: Id });

export const ClaimPairSchema = z.object({
  check: Name,
  claim: z.object({ text: Text, quote: Text.nullable(), simulated: z.boolean() }).nullable(),
  record: z.object({
    words: Text,
    detail: Text,
    value: Text.nullable(),
    sources: z.array(SourceSchema).max(64),
  }),
  verdict: z.enum(CLAIM_VERDICTS),
});
export type ClaimPair = z.infer<typeof ClaimPairSchema>;

const TraceEntrySchema = z.object({
  verifier: Name,
  words: Text,
  result: z.enum(["pass", "fail", "unknown"]),
  value: Text.nullable(),
  detail: Text,
  records: z.array(z.object({ words: Text, call: Text, id: Id.nullable() })).max(64),
});

const TicketSchema = z.object({
  id: Id,
  channel: z.enum(["email", "chat"]),
  sender: Id.nullable(),
  subject: Text.nullable(),
  excerpt: Text,
  received_at: Time,
  attachment_ids: z.array(Id).max(32),
  simulated: z.boolean(),
  thread_id: Id.nullable(),
});

const TrailPartsSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("decision"), decision: z.enum(DECISION_KINDS) }),
  z.object({
    kind: z.literal("approval"),
    step_up_seq: Seq,
    answer: z.enum(["approve", "deny"]),
    outcome: z.enum(["approved", "denied", "rejected"]),
    code: Code.nullable(),
    channel: Name,
  }),
  z.object({
    kind: z.literal("execution.requested"),
    action: Name.optional(),
    request_id: Id.nullable(),
    replay: z.boolean(),
    decision_seq: Seq.nullable(),
    approval_seq: Seq.nullable(),
    first_request_seq: Seq.nullable(),
    amount: MoneySchema,
  }),
  z.object({
    kind: z.literal("execution.result"),
    request_seq: Seq,
    outcome: z.enum(["executed", "failed", "unknown"]),
    refund: RecordRef.nullable(),
    invoice: RecordRef.nullable(),
    dispute: DisputeRef.extend({ action: Name.nullable() }).nullable().optional(),
    error: z
      .object({
        name: Text.nullable(),
        issues: z.array(Text).max(64),
        debug_id: Id.nullable(),
      })
      .nullable(),
  }),
  z.object({
    kind: z.literal("reconciliation"),
    source: z.enum(["webhook", "poll"]),
    event: z.object({ id: Id, type: Id }).nullable(),
    refund: z.object({ id: Id, status: z.string().min(1).max(64), amount: MoneySchema }),
    result_seq: Seq.nullable(),
  }),
  z.object({
    kind: z.literal("mandate.version"),
    id: Id,
    version: z.number().int().positive(),
  }),
]);

const TrailEntrySchema = z.discriminatedUnion("readable", [
  z.object({
    seq: Seq,
    type: z.string().min(1).max(64),
    at: Time,
    hash: StoredHash,
    readable: z.literal(true),
    parts: TrailPartsSchema,
  }),
  z.object({
    seq: Seq,
    type: z.string().min(1).max(64),
    at: Time,
    hash: StoredHash,
    readable: z.literal(false),
    problem: Text,
  }),
]);

const UsageSchema = z.discriminatedUnion("known", [
  z.object({
    known: z.literal(true),
    date: Time,
    per_currency: z
      .array(
        z.object({
          currency: z.string().regex(/^[A-Z]{3}$/),
          count: Count,
          total: MoneySchema,
        }),
      )
      .max(16),
  }),
  z.object({ known: z.literal(false), detail: Text }),
]);

const ReadableDetailSchema = z.object({
  ...ReadableRowFields,
  intent_hash: IntentHash.nullable(),
  intent_canonical: LongText.nullable(),
  mandate: z.object({
    id: Id,
    version: z.number().int().positive(),
    hash: StoredHash,
    seq: Seq,
  }),
  usage: UsageSchema,
  safe_reply_hint: Text.nullable(),
  expires_at: Time.nullable(),
  claims: z.array(ClaimPairSchema).max(64),
  trace: z.array(TraceEntrySchema).max(64),
  ticket: TicketSchema.nullable(),
  proposal: LongText,
  proposal_truncated: z.boolean(),
  entry: z.object({ seq: Seq, at: Time, hash: StoredHash, prev_hash: StoredHash }),
  trail: z.array(TrailEntrySchema).max(1000),
});

const UnreadableDetailSchema = z.object({
  readable: z.literal(false),
  seq: Seq,
  at: Time,
  hash: StoredHash,
  prev_hash: StoredHash,
  problem: Text,
  payload: LongText,
});

export const DecisionDetailSchema = z.discriminatedUnion("readable", [
  ReadableDetailSchema,
  UnreadableDetailSchema,
]);
export type DecisionDetail = z.infer<typeof DecisionDetailSchema>;

export const IntentDecisionSchema = z.object({ decision_seq: Seq });
export type IntentDecision = z.infer<typeof IntentDecisionSchema>;

export const EntryPageSchema = z.object({
  entries: z
    .array(
      z.object({
        seq: Seq,
        type: z.string().min(1).max(64),
        ref: Id.nullable(),
        at: Time,
        hash: StoredHash,
        prev_hash: StoredHash,
        summary: Text,
        readable: z.boolean(),
        problem: Text.nullable(),
      }),
    )
    .max(200),
  total: Count,
  next_before: Seq.nullable(),
});
export type EntryPage = z.infer<typeof EntryPageSchema>;

export const ChainVerdictSchema = z.object({
  intact: z.boolean(),
  entry_count: Count,
  head: z.object({ seq: Seq, hash: StoredHash }).nullable(),
  problems: z.array(z.object({ seq: Count, code: Code, detail: Text })).max(10_000),
});
export type ChainVerdict = z.infer<typeof ChainVerdictSchema>;

// --- Requests ------------------------------------------------------------------------------

export const EVIDENCE_FORMAT = "countersign-evidence-v1";
export const MAX_PAGE_SIZE = 200;

export const DecisionSeqSchema = z.string().regex(/^[1-9][0-9]{0,15}$/);
export const IntentIdSchema = z.string().regex(/^int_[0-9a-f]{24}$/);
export const CaptureIdSchema = z.string().regex(/^[A-Za-z0-9-]{1,64}$/);

const SeqParam = DecisionSeqSchema.refine((text) => Number.isSafeInteger(Number(text)));
const LimitParam = z
  .string()
  .regex(/^[1-9][0-9]{0,2}$/)
  .refine((text) => Number(text) <= MAX_PAGE_SIZE);

export const DecisionQuerySchema = z.strictObject({
  decision: z.enum(DECISION_KINDS).optional(),
  q: z.string().max(200).optional(),
  before: SeqParam.optional(),
  limit: LimitParam.optional(),
});
export type DecisionQuery = z.infer<typeof DecisionQuerySchema>;

export const EntryQuerySchema = z.strictObject({
  before: SeqParam.optional(),
  limit: LimitParam.optional(),
});
export type EntryQuery = z.infer<typeof EntryQuerySchema>;

export const ExportScopeSchema = z.union([
  z.strictObject({ intent: IntentIdSchema }).transform(({ intent }) => ({
    kind: "intent" as const,
    id: intent,
  })),
  z.strictObject({ capture: CaptureIdSchema }).transform(({ capture }) => ({
    kind: "capture" as const,
    id: capture,
  })),
]);
export type ExportScope = z.output<typeof ExportScopeSchema>;

// The part of an evidence file the console checks before passing it on: its format and scope.
// The rest goes through as the gate wrote it, so `ledger check-export` can re-hash it.
export const EvidenceHeadSchema = z.object({
  format: z.literal(EVIDENCE_FORMAT),
  scope: z.object({ kind: z.enum(["intent", "capture"]), id: Id }),
});
