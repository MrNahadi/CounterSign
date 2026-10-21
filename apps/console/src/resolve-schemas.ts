import { z } from "zod";

// What Resolve's HTTP API answers (ADR 0030), as the console's routes and inbox read it. Every
// answer is parsed with these before anything uses it; an answer that doesn't parse is junk.

export const ThreadIdSchema = z.string().regex(/^tkt_[0-9a-f]{32}$/);
export const AttachmentIdSchema = z.string().regex(/^att_[0-9a-f]{32}$/);

export const PHOTO_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;

const Channel = z.enum(["email", "chat"]);
const Mode = z.enum(["protected", "baseline"]);
export const RUN_STATUSES = [
  "queued",
  "running",
  "replied",
  "stopped",
  "failed",
  "not_run",
] as const;
const Status = z.enum(RUN_STATUSES);
const Time = z.string().min(1).max(64);
const Nullable = z.string().nullable();

export const ThreadSummarySchema = z.object({
  thread_id: ThreadIdSchema,
  channel: Channel,
  sender_email: Nullable,
  sender_phone: Nullable,
  subject: Nullable,
  preview: z.string(),
  latest_activity_at: Time,
  latest_run: z
    .object({ run_id: z.string().min(1), mode: Mode, status: Status, outcome: Nullable })
    .nullable(),
});

export const ThreadListSchema = z.object({ threads: z.array(ThreadSummarySchema) });

export const MessageSchema = z.object({
  ticket_id: ThreadIdSchema,
  channel: Channel,
  sender_email: Nullable,
  sender_phone: Nullable,
  subject: Nullable,
  body: z.string(),
  attachments: z.array(z.object({ id: AttachmentIdSchema, content_type: z.enum(PHOTO_TYPES) })),
  received_at: Time,
  simulated: z.boolean(),
});

const ModelStepSchema = z.looseObject({ kind: z.literal("model") });

export const ToolStepSchema = z.object({
  kind: z.literal("tool"),
  step: z.number(),
  id: z.string(),
  name: z.string(),
  args: z.record(z.string(), z.unknown()),
  /** The MCP `CallToolResult` as the server sent it, or null when the transport failed. */
  result: z.unknown(),
  latencyMs: z.number(),
  local: z.boolean(),
});

export const TraceSchema = z.object({
  mode: Mode,
  steps: z.array(z.discriminatedUnion("kind", [ModelStepSchema, ToolStepSchema])),
});

export const ExecutionSchema = z.object({
  intent_id: z.string(),
  outcome: z.enum(["executed", "failed", "unknown"]),
  refund_id: Nullable,
  refund_status: Nullable,
});

export const RunSchema = z.object({
  run_id: z.string().min(1),
  ticket_id: ThreadIdSchema,
  mode: Mode,
  model: z.string(),
  model_versions: z.array(z.string()),
  status: Status,
  outcome: Nullable,
  reply: Nullable,
  queued_at: Time,
  started_at: Time.nullable(),
  finished_at: Time.nullable(),
  trace: TraceSchema.nullable(),
  executions: z.array(ExecutionSchema),
});

export const ThreadDetailSchema = z.object({
  thread_id: ThreadIdSchema,
  messages: z.array(MessageSchema).min(1),
  runs: z.array(RunSchema),
});

// What the console sends to Resolve's `POST /messages` (requirements.md, "Messages in"). Resolve
// checks every rule again, including each photo's first bytes; this keeps junk from leaving.
export const MAX_PHOTOS = 3;
export const MAX_SUBJECT_CHARS = 200;
export const MAX_BODY_CHARS = 4_000;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
// 2 MB of bytes is at most this many base64 characters.
const MAX_PHOTO_BASE64_CHARS = Math.ceil((2 * 1024 * 1024) / 3) * 4;

export const MessageRequestSchema = z.strictObject({
  channel: Channel,
  thread_id: ThreadIdSchema.optional(),
  sender_email: z.email().max(254).optional(),
  sender_phone: z
    .string()
    .regex(/^\+?[0-9][0-9 ()-]{3,30}$/)
    .optional(),
  subject: z.string().max(MAX_SUBJECT_CHARS).regex(/\S/).optional(),
  body: z.string().max(MAX_BODY_CHARS).regex(/\S/),
  attachments: z
    .array(
      z.strictObject({
        content_type: z.enum(PHOTO_TYPES),
        data: z.string().min(1).max(MAX_PHOTO_BASE64_CHARS).regex(BASE64),
      }),
    )
    .max(MAX_PHOTOS),
  mode: Mode,
});

export const MessageAcceptedSchema = z.object({
  ticket_id: ThreadIdSchema,
  thread_id: ThreadIdSchema,
  run_id: z.string().min(1).max(64),
});

/** Resolve's one-sentence refusal. */
export const ResolveMessageSchema = z.object({ message: z.string().min(1).max(500) });

// A tool's result as MCP sends it, and the gate's agent response inside a guarded call's result.
export const CallToolResultSchema = z.object({
  content: z.array(z.unknown()).optional(),
  structuredContent: z.unknown().optional(),
  isError: z.boolean().optional(),
});

export const TextContentSchema = z.object({ type: z.literal("text"), text: z.string() });

const ReasonSchema = z.object({ code: z.string().min(1), detail: z.string() });

export const AgentResponseSchema = z.discriminatedUnion("decision", [
  z.object({ decision: z.literal("allowed"), intent_id: z.string() }),
  z.object({
    decision: z.literal("pending_approval"),
    intent_id: z.string(),
    reasons: z.array(ReasonSchema),
  }),
  z.object({
    decision: z.literal("denied"),
    intent_id: z.string().nullable(),
    reasons: z.array(ReasonSchema),
  }),
]);

export type ThreadSummary = z.infer<typeof ThreadSummarySchema>;
export type ThreadList = z.infer<typeof ThreadListSchema>;
export type ThreadMessage = z.infer<typeof MessageSchema>;
export type ToolStep = z.infer<typeof ToolStepSchema>;
export type Run = z.infer<typeof RunSchema>;
export type ThreadDetail = z.infer<typeof ThreadDetailSchema>;
export type RunStatus = (typeof RUN_STATUSES)[number];
export type MessageRequest = z.infer<typeof MessageRequestSchema>;
export type MessageAccepted = z.infer<typeof MessageAcceptedSchema>;
export type Mode = z.infer<typeof Mode>;
export type Channel = z.infer<typeof Channel>;
