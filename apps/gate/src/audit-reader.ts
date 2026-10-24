// The audit reader (ADR 0034): decision rows with their statuses, one decision in full with its
// intent's trail, the newest decision for an intent, and the raw entry pages. Read-only, over the
// audit log, the ticket store and the seeded order book. Payload text is parsed for display only
// and never re-hashed or stored (ADR 0022). Unlike the readers that guard money, an entry that
// can't be read is listed as unreadable with its problem; it never stops the rest. No AI, and no
// network. The JSON uses the API's snake_case names.

import {
  and,
  asc,
  auditLog,
  type Database,
  desc,
  eq,
  readTicket,
  seedOrders,
  sql,
  type Ticket,
  tickets,
} from "@countersign/db";
import type { ChainRow } from "@countersign/ledger";
import {
  type Action,
  CURRENCIES,
  DECISIONS,
  type Decision,
  IdSchema as Id,
  type IntentTarget,
  type Mandate,
  type Money,
  type RAILS,
  REASONS,
  TimestampSchema,
  type VerifierName,
} from "@countersign/mandate";
import { z } from "zod";
import {
  amountOf,
  type CardAmount,
  type CardTarget,
  type CardTicket,
  targetOf,
  ticketOf,
} from "./approval-cards";
import {
  ApprovalPayloadSchema,
  IntentSchema,
  ReasonSchema,
  TraceEntrySchema,
} from "./approval-log";
import { CLAIM_WORDS, type ClaimPair, claimsVsRecords } from "./claims";
import { AgentResponseSchema } from "./decide";
import { DisputeReceivedPayloadSchema } from "./dispute-log";
import {
  ExecutionRequestedPayloadSchema,
  ExecutionResultPayloadSchema,
  ReconciliationPayloadSchema,
} from "./execution-log";
import { ACTION_WORDS, disputeReasonWords, sourceWords, VERIFIER_WORDS } from "./words";

const Seq = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const Hash = z.string().regex(/^[0-9a-f]{64}$/, "Must be a SHA-256 hash in lowercase hex");
const IntentId = z.string().regex(/^int_[0-9a-f]{24}$/, "Must be an intent ID");

const MoneySchema = z.object({
  minor: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  currency: z.enum(CURRENCIES),
});

// --- Filters -------------------------------------------------------------------------------

export const DEFAULT_PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 200;

const Limit = z.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE);

export const DecisionFiltersSchema = z.strictObject({
  decision: z.enum(DECISIONS).optional(),
  // A case-insensitive substring of the order number, sender, target ID, intent ID or executed
  // refund or invoice ID. Empty matches everything.
  q: z.string().max(200).optional(),
  // Only rows older than this `seq`.
  before: Seq.optional(),
  limit: Limit,
});
export type DecisionFilters = z.input<typeof DecisionFiltersSchema>;

export const EntryPageSchema = z.strictObject({ before: Seq.optional(), limit: Limit });
export type EntryPageFilters = z.input<typeof EntryPageSchema>;

// --- What a decision entry holds ------------------------------------------------------------

const UsageSchema = z.union([
  z.object({
    known: z.literal(true),
    date: z.string(),
    perCurrency: z.record(
      z.string(),
      z.object({ count: z.number().int().nonnegative(), total: MoneySchema }),
    ),
  }),
  z.object({ known: z.literal(false), detail: z.string() }),
]);

const DecisionPayloadSchema = z.object({
  principal: Id,
  mandateSeq: Seq,
  proposal: z.string(),
  proposalTruncated: z.boolean(),
  record: z.object({
    intent: IntentSchema.nullable(),
    intentId: IntentId.nullable(),
    intentHash: Hash.nullable(),
    intentCanonical: z.string().nullable(),
    mandate: z.object({ id: Id, version: z.number().int().positive(), hash: Hash }),
    trace: z.array(TraceEntrySchema),
    usage: UsageSchema,
    matchedRules: z.array(z.string()),
    decision: z.enum(DECISIONS),
    reasons: z.array(ReasonSchema),
    decidedAt: TimestampSchema,
  }),
  response: AgentResponseSchema,
});
type DecisionPayload = z.infer<typeof DecisionPayloadSchema>;

const MandatePayloadSchema = z.object({
  mandate: z.object({ id: z.string(), version: z.number().int().positive() }),
  hash: Hash,
});

const RESPONSE_OF: Record<Decision, DecisionPayload["response"]["decision"]> = {
  allow: "allowed",
  step_up: "pending_approval",
  deny: "denied",
};

type Parsed<T> = { ok: true; value: T } | { ok: false; problem: string };

function parseEntry<T>(row: ChainRow, schema: z.ZodType<T>): Parsed<T> {
  let value: unknown;
  try {
    value = JSON.parse(row.payload);
  } catch {
    return { ok: false, problem: `${row.entryType} #${row.seq} isn't valid JSON.` };
  }
  const parsed = schema.safeParse(value);
  if (parsed.success) return { ok: true, value: parsed.data };
  const [issue] = parsed.error.issues;
  const where = issue && issue.path.length > 0 ? ` at ${issue.path.join(".")}` : "";
  return {
    ok: false,
    problem: `${row.entryType} #${row.seq} can't be read${where}: ${issue?.message ?? "invalid"}.`,
  };
}

// A decision entry read in full, with the checks that its parts agree with each other.
function parseDecision(row: ChainRow): Parsed<DecisionPayload> {
  const parsed = parseEntry(row, DecisionPayloadSchema);
  if (!parsed.ok) return parsed;
  const { record, response } = parsed.value;
  const fail = (what: string): Parsed<DecisionPayload> => ({
    ok: false,
    problem: `decision #${row.seq} ${what}.`,
  });
  if (row.refId !== record.intentId) return fail("has a ref that isn't its intent");
  if ((record.intent === null) !== (record.intentId === null)) {
    return fail("has an intent ID without an intent, or an intent without an ID");
  }
  if (
    response.decision !== RESPONSE_OF[record.decision] ||
    response.intent_id !== record.intentId
  ) {
    return fail("has an agent response that doesn't match its decision");
  }
  return parsed;
}

// --- Rows ----------------------------------------------------------------------------------

export type RowReason = { code: string; words: string; detail: string };

export type RowExecution = {
  outcome: "executed" | "failed" | "unknown" | "pending";
  refund: { id: string; status: string } | null;
  invoice: { id: string; status: string } | null;
  // The dispute an executed dispute action acted on, with its status as re-read after the call
  // (null when that read failed).
  dispute: { id: string; status: string | null } | null;
};

export type RowStatus =
  // An allow: what carrying it out did, or `not_executable` when it was never requested.
  | { kind: RowExecution["outcome"]; execution: RowExecution }
  | { kind: "not_executable"; execution: null }
  // A step-up, at the time asked. `unknown` when an answer to it can't be read.
  | { kind: "open" | "denied" | "expired" | "unknown"; execution: null }
  | { kind: "approved"; execution: RowExecution };

export type ReadableDecisionRow = {
  readable: true;
  seq: number;
  at: string;
  principal: string;
  intent_id: string | null;
  // Null when the proposal never became an intent.
  action: Action | null;
  action_words: string | null;
  amount: CardAmount | null;
  target: CardTarget | null;
  order_number: string | null;
  sender: string | null;
  claim: keyof typeof CLAIM_WORDS | null;
  claim_words: string | null;
  decision: Decision;
  reasons: RowReason[];
  matched_rules: string[];
  // Null for a deny.
  status: RowStatus | null;
};

export type UnreadableDecisionRow = { readable: false; seq: number; at: string; problem: string };

export type DecisionRow = ReadableDecisionRow | UnreadableDecisionRow;

export type DecisionCounts = { all: number; allowed: number; stepped_up: number; denied: number };

export type DecisionRowsPage = {
  rows: DecisionRow[];
  // For the current `q`, whatever the decision filter and cursor.
  counts: DecisionCounts;
  // The `before` for the next page, or null on the last one.
  next_before: number | null;
};

// --- Loading the log -----------------------------------------------------------------------

type ReadDecision = { row: ChainRow; parsed: Parsed<DecisionPayload> };

type OrderBook = { byCapture: Map<string, string>; byOrder: Map<string, string> };

type LoadedLog = {
  rows: ChainRow[];
  decisions: ReadDecision[];
  byRef: Map<string, ChainRow[]>;
  stepUps: Map<number, RowStatus>;
  executions: Map<string, RowExecution | null>;
  orders: OrderBook;
  tickets: Map<string, Ticket | null>;
};

async function readOrderBook(db: Database): Promise<OrderBook> {
  const rows = await db
    .select({
      orderNumber: seedOrders.orderNumber,
      captureId: seedOrders.paypalCaptureId,
      orderId: seedOrders.paypalOrderId,
    })
    .from(seedOrders);
  const book: OrderBook = { byCapture: new Map(), byOrder: new Map() };
  for (const { orderNumber, captureId, orderId } of rows) {
    book.byCapture.set(captureId, orderNumber);
    book.byOrder.set(orderId, orderNumber);
  }
  return book;
}

function orderNumberOf(book: OrderBook, target: IntentTarget): string | null {
  if (target.kind === "capture") {
    return (
      book.byCapture.get(target.captureId) ??
      (target.orderId === null ? undefined : book.byOrder.get(target.orderId)) ??
      null
    );
  }
  if (target.kind === "order") return book.byOrder.get(target.orderId) ?? null;
  return null;
}

// What carrying out an intent did, from its requests and results; null when it was never
// requested. An entry that can't be read makes it unknown, unless a readable result already says
// money moved.
function executionOf(entries: readonly ChainRow[]): RowExecution | null {
  let requested = false;
  let unreadable = false;
  let last: RowExecution["outcome"] | null = null;
  let executed: RowExecution | null = null;
  for (const row of entries) {
    if (row.entryType === "execution.requested") {
      requested = true;
      if (!parseEntry(row, ExecutionRequestedPayloadSchema).ok) unreadable = true;
    } else if (row.entryType === "execution.result") {
      const parsed = parseEntry(row, ExecutionResultPayloadSchema);
      if (!parsed.ok) {
        unreadable = true;
        continue;
      }
      const result = parsed.value;
      last = result.outcome;
      if (result.outcome === "executed" && executed === null) {
        executed = {
          outcome: "executed",
          refund:
            "refund" in result ? { id: result.refund.id, status: result.refund.status } : null,
          invoice:
            "invoice" in result ? { id: result.invoice.id, status: result.invoice.status } : null,
          dispute:
            "dispute" in result ? { id: result.dispute.id, status: result.dispute.status } : null,
        };
      }
    }
  }
  if (executed !== null) return executed;
  if (unreadable) return { outcome: "unknown", refund: null, invoice: null, dispute: null };
  if (!requested) return null;
  return { outcome: last ?? "pending", refund: null, invoice: null, dispute: null };
}

type StepUpTrack = { seq: number; intentId: string; expiresAt: string };

// Each step-up's state at `now`, worked out as the step-up reader does: the first approved or
// denied answer closes every earlier step-up of its intent, a rejected one changes nothing, and
// an open one past its expiry is expired. An answer that can't be read leaves the step-ups it
// might have closed unknown, never open.
function stepUpStates(
  rows: readonly ChainRow[],
  decisions: ReadonlyMap<number, DecisionPayload>,
  executions: ReadonlyMap<string, RowExecution | null>,
  now: Date,
): Map<number, RowStatus> {
  const states = new Map<number, RowStatus>();
  const unanswered = new Map<string, StepUpTrack[]>();
  const known = new Map<number, StepUpTrack>();
  const close = (intentId: string, status: (track: StepUpTrack) => RowStatus) => {
    for (const track of unanswered.get(intentId) ?? []) states.set(track.seq, status(track));
    unanswered.delete(intentId);
  };

  for (const row of rows) {
    if (row.entryType === "decision") {
      const payload = decisions.get(row.seq);
      if (payload === undefined || payload.record.decision !== "step_up") continue;
      const { intentId } = payload.record;
      if (intentId === null || payload.response.decision !== "pending_approval") continue;
      const track = { seq: row.seq, intentId, expiresAt: payload.response.expires_at };
      known.set(row.seq, track);
      unanswered.set(intentId, [...(unanswered.get(intentId) ?? []), track]);
    } else if (row.entryType === "approval" && row.refId !== null) {
      const parsed = parseEntry(row, ApprovalPayloadSchema);
      const answered = parsed.ok ? known.get(parsed.value.stepUpSeq) : undefined;
      if (!parsed.ok || answered === undefined || answered.intentId !== row.refId) {
        close(row.refId, () => ({ kind: "unknown", execution: null }));
        continue;
      }
      const { outcome } = parsed.value;
      if (outcome === "rejected") continue;
      const intentId = row.refId;
      close(intentId, () =>
        outcome === "denied"
          ? { kind: "denied", execution: null }
          : {
              kind: "approved",
              execution: executions.get(intentId) ?? {
                outcome: "pending",
                refund: null,
                invoice: null,
                dispute: null,
              },
            },
      );
    }
  }
  const time = now.getTime();
  for (const waiting of unanswered.values()) {
    for (const track of waiting) {
      const expired = time > Date.parse(track.expiresAt);
      states.set(track.seq, { kind: expired ? "expired" : "open", execution: null });
    }
  }
  return states;
}

async function loadLog(db: Database, now: Date): Promise<LoadedLog> {
  const rows: ChainRow[] = await db.select().from(auditLog).orderBy(asc(auditLog.seq));
  const byRef = new Map<string, ChainRow[]>();
  const decisions: ReadDecision[] = [];
  const readable = new Map<number, DecisionPayload>();
  for (const row of rows) {
    if (row.refId !== null) byRef.set(row.refId, [...(byRef.get(row.refId) ?? []), row]);
    if (row.entryType !== "decision") continue;
    const parsed = parseDecision(row);
    decisions.push({ row, parsed });
    if (parsed.ok) readable.set(row.seq, parsed.value);
  }
  const executions = new Map<string, RowExecution | null>();
  const ticketIds = new Set<string>();
  for (const payload of readable.values()) {
    const { intentId, intent } = payload.record;
    if (intentId !== null && !executions.has(intentId)) {
      executions.set(intentId, executionOf(byRef.get(intentId) ?? []));
    }
    if (intent?.ticketId) ticketIds.add(intent.ticketId);
  }
  const ids = [...ticketIds];
  const [orders, ticketList] = await Promise.all([
    readOrderBook(db),
    Promise.all(ids.map((id) => readTicket(db, id))),
  ]);
  const ticketMap = new Map<string, Ticket | null>();
  ids.forEach((id, index) => {
    ticketMap.set(id, ticketList[index] ?? null);
  });
  return {
    rows,
    decisions,
    byRef,
    stepUps: stepUpStates(rows, readable, executions, now),
    executions,
    orders,
    tickets: ticketMap,
  };
}

function statusOf(log: LoadedLog, seq: number, payload: DecisionPayload): RowStatus | null {
  const { decision, intentId } = payload.record;
  if (decision === "deny") return null;
  if (decision === "step_up") return log.stepUps.get(seq) ?? { kind: "unknown", execution: null };
  const execution = intentId === null ? null : (log.executions.get(intentId) ?? null);
  if (execution === null) return { kind: "not_executable", execution: null };
  return { kind: execution.outcome, execution };
}

function senderOf(ticket: Ticket | null | undefined): string | null {
  return ticket ? (ticket.senderEmail ?? ticket.senderPhone) : null;
}

function rowOf(log: LoadedLog, row: ChainRow, payload: DecisionPayload): ReadableDecisionRow {
  const { record } = payload;
  const { intent } = record;
  const ticket = intent?.ticketId ? log.tickets.get(intent.ticketId) : null;
  return {
    readable: true,
    seq: row.seq,
    at: row.at,
    principal: payload.principal,
    intent_id: record.intentId,
    action: intent?.action ?? null,
    action_words: intent ? ACTION_WORDS[intent.action] : null,
    amount: intent ? amountOf(intent.amount) : null,
    target: intent ? targetOf(intent.target) : null,
    order_number: intent ? orderNumberOf(log.orders, intent.target) : null,
    sender: senderOf(ticket),
    claim: intent?.claim ?? null,
    claim_words: intent?.claim ? CLAIM_WORDS[intent.claim] : null,
    decision: record.decision,
    reasons: record.reasons.map(({ code, detail }) => ({
      code,
      words: REASONS[code].words,
      detail,
    })),
    matched_rules: [...record.matchedRules],
    status: statusOf(log, row.seq, payload),
  };
}

function decisionRows(log: LoadedLog): DecisionRow[] {
  return log.decisions
    .map(
      ({ row, parsed }): DecisionRow =>
        parsed.ok
          ? rowOf(log, row, parsed.value)
          : { readable: false, seq: row.seq, at: row.at, problem: parsed.problem },
    )
    .reverse();
}

function matches(row: ReadableDecisionRow, needle: string): boolean {
  const fields = [
    row.order_number,
    row.sender,
    row.target?.id,
    row.intent_id,
    row.status?.execution?.refund?.id,
    row.status?.execution?.invoice?.id,
  ];
  return fields.some((field) => typeof field === "string" && field.toLowerCase().includes(needle));
}

// The decision rows newest first, filtered and paged, with the counts for the current `q`. A
// database that can't be read throws, and so do filters out of range.
export async function readDecisionRows(
  db: Database,
  filters: DecisionFilters,
  now: Date,
): Promise<DecisionRowsPage> {
  const { decision, q, before, limit } = DecisionFiltersSchema.parse(filters);
  const all = decisionRows(await loadLog(db, now));
  const needle = (q ?? "").trim().toLowerCase();
  const searched = needle === "" ? all : all.filter((row) => row.readable && matches(row, needle));
  const count = (kind: Decision) =>
    searched.filter((row) => row.readable && row.decision === kind).length;
  const counts = {
    all: searched.length,
    allowed: count("allow"),
    stepped_up: count("step_up"),
    denied: count("deny"),
  };
  const ofKind =
    decision === undefined
      ? searched
      : searched.filter((row) => row.readable && row.decision === decision);
  const older = before === undefined ? ofKind : ofKind.filter((row) => row.seq < before);
  const rows = older.slice(0, limit);
  const next = older.length > limit ? (rows.at(-1)?.seq ?? null) : null;
  return { rows, counts, next_before: next };
}

// --- One decision --------------------------------------------------------------------------

export type DetailTraceEntry = {
  verifier: VerifierName;
  words: string;
  result: "pass" | "fail" | "unknown";
  value: string | null;
  detail: string;
  records: { words: string; call: string; id: string | null }[];
};

export type DetailTicket = CardTicket & { thread_id: string | null };

export type ShownMoney = CardAmount;

export type TrailParts =
  | { kind: "decision"; decision: Decision }
  | {
      kind: "approval";
      step_up_seq: number;
      answer: "approve" | "deny";
      outcome: "approved" | "denied" | "rejected";
      code: string | null;
      channel: string;
    }
  | {
      kind: "execution.requested";
      action: Action;
      request_id: string | null;
      replay: boolean;
      decision_seq: number | null;
      approval_seq: number | null;
      first_request_seq: number | null;
      amount: ShownMoney;
    }
  | {
      kind: "execution.result";
      request_seq: number;
      outcome: "executed" | "failed" | "unknown";
      refund: { id: string; status: string } | null;
      invoice: { id: string; status: string } | null;
      // The action comes from the request this result answers; null when that can't be read.
      dispute: { id: string; status: string | null; action: Action | null } | null;
      error: { name: string | null; issues: string[]; debug_id: string | null } | null;
    }
  | {
      kind: "reconciliation";
      source: "webhook" | "poll";
      event: { id: string; type: string } | null;
      refund: { id: string; status: string; amount: ShownMoney };
      result_seq: number | null;
    }
  | { kind: "mandate.version"; id: string; version: number };

export type TrailEntry = { seq: number; type: string; at: string; hash: string } & (
  | { readable: true; parts: TrailParts }
  | { readable: false; problem: string }
);

export type UsageView =
  | {
      known: true;
      date: string;
      per_currency: { currency: string; count: number; total: ShownMoney }[];
    }
  | { known: false; detail: string };

export type DecisionDetail = ReadableDecisionRow & {
  intent_hash: string | null;
  intent_canonical: string | null;
  mandate: { id: string; version: number; hash: string; seq: number };
  usage: UsageView;
  // Denials only.
  safe_reply_hint: string | null;
  // Step-ups only.
  expires_at: string | null;
  claims: ClaimPair[];
  trace: DetailTraceEntry[];
  ticket: DetailTicket | null;
  proposal: string;
  proposal_truncated: boolean;
  entry: { seq: number; at: string; hash: string; prev_hash: string };
  trail: TrailEntry[];
};

export type UnreadableDecisionDetail = {
  readable: false;
  seq: number;
  at: string;
  hash: string;
  prev_hash: string;
  problem: string;
  // The stored payload text, as it is.
  payload: string;
};

const shown = (money: Money): ShownMoney => amountOf(money);

// The action each request entry asked for, by the request's `seq`. A request that can't be read
// has none.
type RequestActions = ReadonlyMap<number, Action>;

function requestActionsOf(rows: readonly ChainRow[]): Map<number, Action> {
  const actions = new Map<number, Action>();
  for (const row of rows) {
    if (row.entryType !== "execution.requested") continue;
    const parsed = parseEntry(row, ExecutionRequestedPayloadSchema);
    if (parsed.ok) actions.set(row.seq, parsed.value.action);
  }
  return actions;
}

function partsOf(row: ChainRow, requests: RequestActions = new Map()): Parsed<TrailParts> {
  switch (row.entryType) {
    case "decision": {
      const parsed = parseDecision(row);
      return parsed.ok
        ? { ok: true, value: { kind: "decision", decision: parsed.value.record.decision } }
        : parsed;
    }
    case "approval": {
      const parsed = parseEntry(row, ApprovalPayloadSchema);
      if (!parsed.ok) return parsed;
      const value = parsed.value;
      return {
        ok: true,
        value: {
          kind: "approval",
          step_up_seq: value.stepUpSeq,
          answer: value.answer,
          outcome: value.outcome,
          code: value.outcome === "rejected" ? value.code : null,
          channel: value.channel,
        },
      };
    }
    case "execution.requested": {
      const parsed = parseEntry(row, ExecutionRequestedPayloadSchema);
      if (!parsed.ok) return parsed;
      const value = parsed.value;
      return {
        ok: true,
        value: {
          kind: "execution.requested",
          action: value.action,
          request_id: value.requestId,
          replay: value.replay,
          decision_seq: "decisionSeq" in value ? value.decisionSeq : null,
          approval_seq: "approvalSeq" in value ? value.approvalSeq : null,
          first_request_seq: "firstRequestSeq" in value ? value.firstRequestSeq : null,
          amount: shown(value.amount),
        },
      };
    }
    case "execution.result": {
      const parsed = parseEntry(row, ExecutionResultPayloadSchema);
      if (!parsed.ok) return parsed;
      const value = parsed.value;
      const refund = "refund" in value && value.refund ? value.refund : null;
      const invoice = "invoice" in value ? value.invoice : null;
      const dispute = "dispute" in value ? value.dispute : null;
      const error = "error" in value && value.error ? value.error : null;
      return {
        ok: true,
        value: {
          kind: "execution.result",
          request_seq: value.requestSeq,
          outcome: value.outcome,
          refund: refund ? { id: refund.id, status: refund.status } : null,
          invoice: invoice ? { id: invoice.id, status: invoice.status } : null,
          dispute: dispute
            ? {
                id: dispute.id,
                status: dispute.status,
                action: requests.get(value.requestSeq) ?? null,
              }
            : null,
          error: error
            ? { name: error.name, issues: [...error.issues], debug_id: error.debugId }
            : null,
        },
      };
    }
    case "reconciliation": {
      const parsed = parseEntry(row, ReconciliationPayloadSchema);
      if (!parsed.ok) return parsed;
      const value = parsed.value;
      // TODO(T-010): describe payout reconciliations; until then they read as not shown.
      if (value.refund === undefined) {
        return {
          ok: false,
          problem: `reconciliation #${row.seq} is a payout's, which the reader doesn't show yet.`,
        };
      }
      return {
        ok: true,
        value: {
          kind: "reconciliation",
          source: value.source,
          event: value.source === "webhook" ? { ...value.event } : null,
          refund: {
            id: value.refund.id,
            status: value.refund.status,
            amount: shown(value.refund.amount),
          },
          result_seq: value.resultSeq,
        },
      };
    }
    case "mandate.version": {
      const parsed = parseEntry(row, MandatePayloadSchema);
      if (!parsed.ok) return parsed;
      const { id, version } = parsed.value.mandate;
      return { ok: true, value: { kind: "mandate.version", id, version } };
    }
    default:
      return { ok: false, problem: `#${row.seq} has an entry type the reader doesn't know.` };
  }
}

function trailOf(rows: readonly ChainRow[]): TrailEntry[] {
  const requests = requestActionsOf(rows);
  return rows.map((row) => {
    const base = { seq: row.seq, type: row.entryType, at: row.at, hash: row.hash };
    const parts = partsOf(row, requests);
    return parts.ok
      ? { ...base, readable: true, parts: parts.value }
      : { ...base, readable: false, problem: parts.problem };
  });
}

function usageOf(usage: DecisionPayload["record"]["usage"]): UsageView {
  if (!usage.known) return { known: false, detail: usage.detail };
  return {
    known: true,
    date: usage.date,
    per_currency: Object.entries(usage.perCurrency).map(([currency, each]) => ({
      currency,
      count: each.count,
      total: shown(each.total),
    })),
  };
}

async function threadIdOf(db: Database, ticketId: string): Promise<string | null> {
  const [row] = await db
    .select({ threadId: tickets.threadId })
    .from(tickets)
    .where(eq(tickets.id, ticketId))
    .limit(1);
  return row?.threadId ?? null;
}

// One decision in full, by its entry's `seq`, with its state at `now`. Null for any `seq` that
// isn't a decision entry; an unreadable one comes back with its problem and raw payload text.
export async function readDecisionDetail(
  db: Database,
  seq: number,
  now: Date,
  mandates: readonly Mandate[],
): Promise<DecisionDetail | UnreadableDecisionDetail | null> {
  if (!Seq.safeParse(seq).success) return null;
  const log = await loadLog(db, now);
  const found = log.decisions.find((decision) => decision.row.seq === seq);
  if (found === undefined) return null;
  const { row, parsed } = found;
  if (!parsed.ok) {
    return {
      readable: false,
      seq: row.seq,
      at: row.at,
      hash: row.hash,
      prev_hash: row.prevHash,
      problem: parsed.problem,
      payload: row.payload,
    };
  }
  const payload = parsed.value;
  const { record, response } = payload;
  const base = rowOf(log, row, payload);
  const ticketId = record.intent?.ticketId ?? null;
  const ticket = ticketId === null ? null : (log.tickets.get(ticketId) ?? null);
  const threadId = ticket === null ? null : await threadIdOf(db, ticket.id);
  return {
    ...base,
    intent_hash: record.intentHash,
    intent_canonical: record.intentCanonical,
    mandate: { ...record.mandate, seq: payload.mandateSeq },
    usage: usageOf(record.usage),
    safe_reply_hint: response.decision === "denied" ? response.safe_reply_hint : null,
    expires_at: response.decision === "pending_approval" ? response.expires_at : null,
    claims: claimsVsRecords(
      { ...record, proposal: payload.proposal },
      { ticket, orderNumber: base.order_number, mandates },
    ),
    trace: record.trace.map((entry) => ({
      verifier: entry.verifier,
      words: VERIFIER_WORDS[entry.verifier],
      result: entry.result,
      value: entry.value ?? null,
      detail: entry.detail,
      records: entry.records.map(({ call, id }) => ({ words: sourceWords(call), call, id })),
    })),
    ticket: ticket === null ? null : { ...ticketOf(ticket), thread_id: threadId },
    proposal: payload.proposal,
    proposal_truncated: payload.proposalTruncated,
    entry: { seq: row.seq, at: row.at, hash: row.hash, prev_hash: row.prevHash },
    trail: record.intentId === null ? [] : trailOf(log.byRef.get(record.intentId) ?? []),
  };
}

// --- By intent -----------------------------------------------------------------------------

// The newest decision entry's `seq` for an intent ID, or null when there's none.
export async function readDecisionSeqByIntent(
  db: Database,
  intentId: string,
): Promise<number | null> {
  if (!IntentId.safeParse(intentId).success) return null;
  const [row] = await db
    .select({ seq: auditLog.seq })
    .from(auditLog)
    .where(and(eq(auditLog.entryType, "decision"), eq(auditLog.refId, intentId)))
    .orderBy(desc(auditLog.seq))
    .limit(1);
  return row?.seq ?? null;
}

// --- Entries -------------------------------------------------------------------------------

export const UNREADABLE_SUMMARY = "This entry can't be read.";

export type EntryRow = {
  seq: number;
  type: string;
  ref: string | null;
  at: string;
  hash: string;
  prev_hash: string;
  summary: string;
  readable: boolean;
  // Null when the entry reads.
  problem: string | null;
};

export type EntryPage = { entries: EntryRow[]; total: number; next_before: number | null };

const RAIL_WORDS: Record<(typeof RAILS)[number], string> = { paypal: "PayPal", mpesa: "M-Pesa" };

const lowerFirst = (text: string) => text.charAt(0).toLowerCase() + text.slice(1);

const DECISION_VERBS: Record<Decision, string> = {
  allow: "Allowed",
  step_up: "Held",
  deny: "Denied",
};

function decisionSummary(payload: DecisionPayload, orders: OrderBook): string {
  const { intent, decision } = payload.record;
  if (intent === null) return `${DECISION_VERBS[decision]} a proposal Countersign couldn't read.`;
  const target = targetOf(intent.target);
  const where = orderNumberOf(orders, intent.target) ?? target.id;
  const words = lowerFirst(ACTION_WORDS[intent.action]);
  const tail = decision === "step_up" ? " for approval" : "";
  return `${DECISION_VERBS[decision]} ${words} ${shown(intent.amount).display} on ${where}${tail}.`;
}

// PayPal's status codes in lower-case words, such as UNDER_REVIEW as "under review".
const statusWords = (status: string) => status.toLowerCase().replaceAll("_", " ");

type DisputeResult = NonNullable<Extract<TrailParts, { kind: "execution.result" }>["dispute"]>;

/** What an executed dispute action did, as one sentence; the action comes from its request. */
export function disputeResultWords({ id, status, action }: DisputeResult): string {
  switch (action) {
    case "paypal.dispute.provide_evidence":
      return `PayPal took the evidence for ${id}${status === null ? "" : `: ${statusWords(status)}`}.`;
    case "paypal.dispute.accept_claim":
      return `Accepted the claim on ${id}.`;
    case "paypal.dispute.make_offer":
      return `Sent an offer on ${id}.`;
    default:
      return `PayPal acted on ${id}${status === null ? "" : `: ${statusWords(status)}`}.`;
  }
}

function disputeReceivedSummary(row: ChainRow): Parsed<string> {
  const parsed = parseEntry(row, DisputeReceivedPayloadSchema);
  if (!parsed.ok) return parsed;
  const { disputeId, dispute } = parsed.value;
  if (row.refId !== disputeId) {
    return { ok: false, problem: `dispute.received #${row.seq} has a ref that isn't its dispute.` };
  }
  const [captureId] = dispute.captureIds;
  const on = captureId === undefined ? "" : ` on capture ${captureId}`;
  // A reason PayPal adds later has no words, so it shows as the code it is.
  const words = disputeReasonWords(dispute.reason);
  const reason = words === dispute.reason ? words : lowerFirst(words);
  return {
    ok: true,
    value: `PayPal opened dispute ${disputeId}${on} for ${shown(dispute.amount).display} (${reason}).`,
  };
}

function summaryOf(row: ChainRow, orders: OrderBook, requests: RequestActions): Parsed<string> {
  if (row.entryType === "dispute.received") return disputeReceivedSummary(row);
  if (row.entryType === "decision") {
    const parsed = parseDecision(row);
    return parsed.ok ? { ok: true, value: decisionSummary(parsed.value, orders) } : parsed;
  }
  if (row.entryType === "execution.requested") {
    const parsed = parseEntry(row, ExecutionRequestedPayloadSchema);
    if (!parsed.ok) return parsed;
    const { rail, action, amount, replay } = parsed.value;
    const again = replay ? " again" : "";
    const words = lowerFirst(ACTION_WORDS[action]);
    return {
      ok: true,
      value: `Asked ${RAIL_WORDS[rail]}${again} to ${words} ${shown(amount).display}.`,
    };
  }
  const parts = partsOf(row, requests);
  if (!parts.ok) return parts;
  const value = parts.value;
  switch (value.kind) {
    case "approval":
      if (value.outcome === "rejected") {
        return {
          ok: true,
          value: `Refused an answer to step-up ${value.step_up_seq}: ${value.code}.`,
        };
      }
      return {
        ok: true,
        value: `${value.outcome === "approved" ? "Approved" : "Denied"} step-up ${value.step_up_seq}.`,
      };
    case "execution.result": {
      if (value.outcome === "executed" && value.refund) {
        const { id, status } = value.refund;
        return { ok: true, value: `PayPal refunded it: ${id} ${status.toLowerCase()}.` };
      }
      if (value.outcome === "executed" && value.invoice) {
        const { id, status } = value.invoice;
        return { ok: true, value: `PayPal sent invoice ${id}: ${status.toLowerCase()}.` };
      }
      if (value.outcome === "executed" && value.dispute) {
        return { ok: true, value: disputeResultWords(value.dispute) };
      }
      if (value.outcome === "failed") {
        const reason = value.error?.name ?? value.refund?.status.toLowerCase() ?? "no reason given";
        return { ok: true, value: `PayPal refused it: ${reason}.` };
      }
      return { ok: true, value: "PayPal's answer isn't known." };
    }
    case "reconciliation": {
      const refund = value.refund.id;
      if (value.event !== null) {
        return {
          ok: true,
          value:
            value.result_seq === null
              ? `Webhook ${value.event.id} names refund ${refund}, which matches no request.`
              : `Matched webhook ${value.event.id} to refund ${refund}.`,
        };
      }
      return {
        ok: true,
        value:
          value.result_seq === null
            ? `Re-read refund ${refund}, which matches no request.`
            : `Re-read refund ${refund}: ${value.refund.status.toLowerCase()}.`,
      };
    }
    case "mandate.version":
      return { ok: true, value: `Mandate ${value.id} version ${value.version}.` };
    default:
      return { ok: false, problem: `#${row.seq} has an entry type the reader doesn't know.` };
  }
}

// The actions of the requests that the page's dispute results answer. A dispute result doesn't
// say which action it was, so its request is read, even when that is on another page. A request
// that isn't there, can't be read, or belongs to another intent gives no action.
async function requestActionsFor(
  db: Database,
  rows: readonly ChainRow[],
): Promise<Map<number, Action>> {
  const wanted = new Map<number, string | null>();
  for (const row of rows) {
    if (row.entryType !== "execution.result") continue;
    const parsed = parseEntry(row, ExecutionResultPayloadSchema);
    if (parsed.ok && "dispute" in parsed.value) wanted.set(parsed.value.requestSeq, row.refId);
  }
  const found = await Promise.all(
    [...wanted.keys()].map((seq) =>
      db.select().from(auditLog).where(eq(auditLog.seq, seq)).limit(1),
    ),
  );
  const requests: ChainRow[] = found
    .flat()
    .filter((request) => request.refId === wanted.get(request.seq));
  return requestActionsOf(requests);
}

// Every audit-log row newest first, paged, each with one summary sentence, plus the total.
export async function readEntries(db: Database, filters: EntryPageFilters): Promise<EntryPage> {
  const { before, limit } = EntryPageSchema.parse(filters);
  const [page, totals, orders] = await Promise.all([
    db
      .select()
      .from(auditLog)
      .where(before === undefined ? undefined : sql`${auditLog.seq} < ${before}`)
      .orderBy(desc(auditLog.seq))
      .limit(limit + 1),
    db.select({ total: sql<number>`count(*)::int` }).from(auditLog),
    readOrderBook(db),
  ]);
  const rows: ChainRow[] = page.slice(0, limit);
  const requests = await requestActionsFor(db, rows);
  const entries = rows.map((row): EntryRow => {
    const summary = summaryOf(row, orders, requests);
    return {
      seq: row.seq,
      type: row.entryType,
      ref: row.refId,
      at: row.at,
      hash: row.hash,
      prev_hash: row.prevHash,
      summary: summary.ok ? summary.value : UNREADABLE_SUMMARY,
      readable: summary.ok,
      problem: summary.ok ? null : summary.problem,
    };
  });
  return {
    entries,
    total: Number(totals[0]?.total ?? 0),
    next_before: page.length > limit ? (rows.at(-1)?.seq ?? null) : null,
  };
}
