import { z } from "zod";

// What the gate's approval API answers (ADR 0032), as the console's routes and approvals page
// read it. Every answer is parsed with these before anything uses it; an answer that doesn't
// parse is junk. Plain zod only, so a client component can import them.

export const StepUpIdSchema = z.string().regex(/^[1-9][0-9]{0,15}$/);
export const IntentHashSchema = z.string().regex(/^[0-9a-f]{64}$/);

// The approver key as typed: printable ASCII without spaces, at least 32 characters (the gate
// counts a shorter key as unset).
export const ApproverKeySchema = z.string().regex(/^[\x21-\x7e]{32,512}$/);

export const SignInRequestSchema = z.strictObject({ key: z.string().max(1024) });

export const APPROVAL_ANSWERS = ["approve", "deny"] as const;
export const AnswerRequestSchema = z.strictObject({
  answer: z.enum(APPROVAL_ANSWERS),
  intent_hash: IntentHashSchema,
});
export type AnswerRequest = z.infer<typeof AnswerRequestSchema>;

export const APPROVAL_REJECTION_CODES = [
  "HASH_MISMATCH",
  "ALREADY_ANSWERED",
  "EXPIRED",
  "ALREADY_REQUESTED",
  "ACTION_UNAVAILABLE",
  "DUPLICATE_REFUND",
] as const;

const Text = z.string().max(4096);
const Id = z.string().min(1).max(256);
const Time = z.string().min(1).max(64);
const Name = z.string().regex(/^[a-z0-9_.]{1,64}$/);
const Seq = z.number().int().positive();

const AmountSchema = z.object({
  minor: z.number().int(),
  currency: z.string().regex(/^[A-Z]{3}$/),
  display: z.string().min(1).max(64),
});

const RecordSchema = z.object({ id: Id, status: z.string().min(1).max(64) });

export const CardSchema = z.object({
  step_up_id: Seq,
  intent_id: Id,
  intent_hash: IntentHashSchema,
  principal: Id,
  action: Name,
  action_words: z.string().min(1).max(64),
  amount: AmountSchema,
  target: z.object({
    kind: z.enum(["capture", "dispute", "invoice", "order", "payee"]),
    id: Id,
    order_id: Id.nullable(),
  }),
  order_number: Id.nullable(),
  ticket: z
    .object({
      id: Id,
      channel: z.enum(["email", "chat"]),
      sender: Id.nullable(),
      subject: Text.nullable(),
      excerpt: Text,
      received_at: Time,
      attachment_ids: z.array(Id).max(32),
      simulated: z.boolean(),
    })
    .nullable(),
  claim: z.enum(["not_received", "damaged", "wrong_item"]).nullable(),
  reasons: z.array(
    z.object({ code: z.string().regex(/^[A-Z0-9_]{1,64}$/), words: Text, detail: Text }),
  ),
  checks: z.array(
    z.object({
      verifier: Name,
      result: z.enum(["pass", "fail", "unknown"]),
      value: Text.nullable(),
      detail: Text,
      records: z.array(z.object({ call: Text, id: Id.nullable() })),
    }),
  ),
  decided_at: Time,
  expires_at: Time,
  state: z.enum(["open", "answered", "expired"]),
  answer: z.object({ outcome: z.enum(["approved", "denied"]), at: Time, channel: Name }).nullable(),
  can_execute: z.boolean(),
  cannot_execute: Text.nullable(),
});
export type Card = z.infer<typeof CardSchema>;

export const RecentSummarySchema = z.object({
  step_up_id: Seq,
  intent_id: Id,
  action: Name,
  action_words: z.string().min(1).max(64),
  amount: AmountSchema,
  order_number: Id.nullable(),
  outcome: z.enum(["approved", "denied", "expired"]),
  at: Time,
  channel: Name.nullable(),
  execution: z
    .object({
      outcome: z.enum(["executed", "failed", "unknown", "pending"]),
      refund: RecordSchema.nullable(),
      invoice: RecordSchema.nullable(),
    })
    .nullable(),
});
export type RecentSummary = z.infer<typeof RecentSummarySchema>;

export const ApprovalsViewSchema = z.object({
  open: z.array(CardSchema),
  recent: z.array(RecentSummarySchema),
});
export type ApprovalsView = z.infer<typeof ApprovalsViewSchema>;

export const AnswerResultSchema = z.object({
  outcome: z.enum(["approved", "denied", "rejected"]),
  code: z.enum(APPROVAL_REJECTION_CODES).nullable(),
  step_up_id: Seq,
  intent_id: Id,
  approval_seq: Seq,
  execution: z
    .object({
      outcome: z.enum(["executed", "failed", "unknown"]),
      refund: RecordSchema.nullable(),
      invoice: RecordSchema.nullable(),
      error: z.object({ name: Text.nullable(), issues: z.array(Text).max(64) }).nullable(),
    })
    .nullable(),
});
export type AnswerResult = z.infer<typeof AnswerResultSchema>;

// The one sentence the gate answers with on a refusal.
export const GateMessageSchema = z.object({ message: z.string().min(1).max(300) });
