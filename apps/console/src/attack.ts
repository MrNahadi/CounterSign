import { z } from "zod";
import { APPROVAL_ROUTE_MESSAGES } from "./approval-routes";
import type { DecisionDetail, VisitorMoney } from "./audit-schemas";
import { CHANNEL_OPTIONS } from "./composer";
import { type ClaimRowView, claimRow, type TraceRowView, traceRow } from "./decision-view";
import {
  type DecisionView,
  outcomeSentence,
  type StatusBadge,
  statusBadge,
  toolRow,
} from "./inbox-view";
import { RESOLVE_UNREACHABLE } from "./resolve-routes";
import {
  AgentResponseSchema,
  CallToolResultSchema,
  type Channel,
  MAX_BODY_CHARS,
  MessageAcceptedSchema,
  type MessageRequest,
  MessageRequestSchema,
  ResolveMessageSchema,
  type Run,
  type ThreadDetail,
  type ToolStep,
} from "./resolve-schemas";
import { SESSION_LIMITS, SESSION_WINDOW_MS } from "./session-limits";

// "Attack it yourself" (brief §6, "a judge tries to break it"; ADR 0043): a visitor writes any
// message from any sender address, Resolve answers it in protected mode, and the page shows what
// Resolve proposed, how Countersign decided, and the message's claims beside the records. Nothing
// here decides anything: the decision, claims and trace are the gate's, read back and shown.
// Every email address the page shows is masked (ADR 0034). Browser-safe, so the form imports it.

export const ATTACK_PATH = "/api/attack";
export const ATTACK_MAX_PROPOSALS = 8;

export const ATTACK_COPY = {
  title: "Attack it yourself",
  description:
    "Write any message to Resolve, from any sender address, and try to make money move. Resolve runs in protected mode, so Countersign checks every money action it proposes against PayPal's records and the shop's mandate.",
  simulated:
    "Simulated: no email or chat is sent or received. Kikapu Studio and its buyers are illustrative.",
  signInLine: "Sign in with the approver key to attack the demo.",
  send: "Send to Resolve",
  sending: "Sending",
  senderLabel: "Sender's email",
  senderHelp: "Any address. Try a buyer's, or one that only looks like it.",
  channelLabel: "Channel",
  messageLabel: "Message",
  messageHelp: "Ask for a refund, claim a lost parcel, hide an instruction. Anything goes.",
  yourMessage: "Your message",
  proposed: "What Resolve proposed",
  working: "Resolve is reading the message and checking the records",
  noProposal: "Resolve proposed no money action, so nothing reached Countersign. No money moved.",
  notRun: "Resolve didn't run this message, so nothing reached Countersign. No money moved.",
  counterTitle: "Money moved by visitors",
  counterLine:
    "Read from the audit log: every money action from an attack that Countersign allowed, or that an approver approved, unless PayPal refused it.",
  counterMoved: (count: number) =>
    count === 1
      ? "1 money action from an attack went through."
      : `${count} money actions from attacks went through.`,
  counterUnknown: "Unknown",
  counterUnread: "Can't be read",
  counterHeldBadge: "Nothing moved",
  counterMovedBadge: "Money moved",
  counterUnsureBadge: "Not confirmed",
  limits: `Each session can send ${SESSION_LIMITS.attack} attacks in any ${SESSION_WINDOW_MS / 60_000} minutes, and Resolve stops for the day at its daily run cap.`,
  recordsUnread: "The records for this decision couldn't be read.",
  noIntent: "Countersign denied it before it became an intent, so there are no records to show.",
  reply: "Resolve's reply",
  newAttack: "Try another",
  noThread: "There's no attack with that ID. Start a new one.",
} as const;

export const ATTACK_CHANNELS = CHANNEL_OPTIONS;

export type AttackForm = { channel: Channel; senderEmail: string; body: string };
export type AttackField = "senderEmail" | "body";

export type AttackMessage =
  | { ok: true; request: MessageRequest }
  | { ok: false; field: AttackField; problem: string };

/** What a visitor may send: no thread, no photos, and never a mode (it's always protected). */
export const AttackRequestSchema = z.strictObject({
  channel: z.enum(["email", "chat"]),
  sender_email: z.email().max(254),
  body: z.string().max(MAX_BODY_CHARS).regex(/\S/),
});
export type AttackRequest = z.infer<typeof AttackRequestSchema>;

/** The visitor's form as the attack route's body, or the first field that's wrong. */
export function attackRequest(form: AttackForm): AttackMessage {
  const sender = form.senderEmail.trim();
  if (sender === "") return { ok: false, field: "senderEmail", problem: "Add a sender's email." };
  if (!z.email().max(254).safeParse(sender).success) {
    return {
      ok: false,
      field: "senderEmail",
      problem: "Use an email address like name@example.com.",
    };
  }
  if (form.body.trim() === "") return { ok: false, field: "body", problem: "Write a message." };
  if (form.body.length > MAX_BODY_CHARS) {
    return { ok: false, field: "body", problem: `Keep it under ${MAX_BODY_CHARS} characters.` };
  }
  return { ok: true, request: toMessageRequest({ ...form, senderEmail: sender }) };
}

/** Resolve's `POST /messages` body for a visitor's attack: always protected, never baseline. */
export function toMessageRequest(form: AttackForm): MessageRequest {
  return MessageRequestSchema.parse({
    channel: form.channel,
    sender_email: form.senderEmail,
    body: form.body,
    attachments: [],
    mode: "protected",
  });
}

export type AttackSend =
  | { ok: true; threadId: string }
  | { ok: false; message: string; signedOut?: true };

/** Posts the attack through the console's route; a refusal's one sentence comes back as is. */
export async function sendAttack(
  request: MessageRequest,
  deps: { fetch?: typeof fetch } = {},
): Promise<AttackSend> {
  const body: AttackRequest = {
    channel: request.channel,
    sender_email: request.sender_email ?? "",
    body: request.body,
  };
  let response: Response;
  try {
    response = await (deps.fetch ?? fetch)(ATTACK_PATH, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    return { ok: false, message: RESOLVE_UNREACHABLE };
  }
  if (response.status === 401) {
    return { ok: false, signedOut: true, message: APPROVAL_ROUTE_MESSAGES.signedOut };
  }
  let answer: unknown;
  try {
    answer = await response.json();
  } catch {
    return { ok: false, message: RESOLVE_UNREACHABLE };
  }
  if (response.status === 202) {
    const accepted = MessageAcceptedSchema.safeParse(answer);
    if (accepted.success) return { ok: true, threadId: accepted.data.thread_id };
  } else {
    const refusal = ResolveMessageSchema.safeParse(answer);
    if (refusal.success) return { ok: false, message: refusal.data.message };
  }
  return { ok: false, message: RESOLVE_UNREACHABLE };
}

// Anything shaped like an email address. Generous on purpose: masking too much is safe.
const EMAIL = /[A-Za-z0-9._%+'-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g;

/** Each email address in the text cut to its first character and its domain: `a***@example.com`. */
export function maskEmails(text: string): string {
  return text.replace(EMAIL, (address) => {
    const at = address.indexOf("@");
    return `${address.slice(0, 1)}***${address.slice(at)}`;
  });
}

function maskedClaim(row: ClaimRowView): ClaimRowView {
  return {
    check: row.check,
    claim:
      row.claim === null
        ? null
        : {
            text: maskEmails(row.claim.text),
            quote: row.claim.quote === null ? null : maskEmails(row.claim.quote),
            simulated: row.claim.simulated,
          },
    record: {
      lead: maskEmails(row.record.lead),
      detail: maskEmails(row.record.detail),
      sources: row.record.sources.map((source) => ({
        words: maskEmails(source.words),
        call: source.call,
        id: maskEmails(source.id),
      })),
    },
    verdict: row.verdict,
  };
}

function maskedTrace(row: TraceRowView): TraceRowView {
  return {
    verifier: row.verifier,
    words: maskEmails(row.words),
    detail: maskEmails(row.detail),
    records: row.records.map((record) => ({
      words: maskEmails(record.words),
      call: record.call,
      id: maskEmails(record.id),
    })),
    result: row.result,
  };
}

/** The gate's intent ID in a guarded call's answer, or null when there's none to read. */
export function guardedIntentId(step: ToolStep): string | null {
  const result = CallToolResultSchema.safeParse(step.result);
  if (!result.success || result.data.isError === true) return null;
  const decided = AgentResponseSchema.safeParse(result.data.structuredContent);
  return decided.success ? decided.data.intent_id : null;
}

/** What the page shows of one guarded call's decision, by the gate's read-back of its records. */
export type AttackRecords =
  | { kind: "shown"; detail: DecisionDetail }
  | { kind: "no_intent" }
  | { kind: "unread" };

export type AttackProposalView = {
  id: string;
  action: string;
  args: { label: string; value: string }[];
  decision: DecisionView;
  claims: ClaimRowView[];
  trace: TraceRowView[];
  note: string | null;
};

export type AttackView = {
  threadId: string;
  channelLabel: string;
  sender: string;
  body: string;
  working: boolean;
  status: StatusBadge;
  outcome: string | null;
  proposals: AttackProposalView[];
  noProposal: string | null;
  reply: string | null;
};

const isWorking = (run: Run | undefined) =>
  run === undefined || run.status === "queued" || run.status === "running";

/** The thread's latest run: a fallback rerun follows the run it replaces. */
export const latestRun = (thread: ThreadDetail): Run | undefined => thread.runs.at(-1);

/** The guarded calls of a run, with the intent each became, newest run only, capped. */
export function guardedSteps(run: Run | undefined): { step: ToolStep; intentId: string | null }[] {
  if (run === undefined || run.mode !== "protected") return [];
  const steps: { step: ToolStep; intentId: string | null }[] = [];
  for (const step of run.trace?.steps ?? []) {
    if (step.kind !== "tool") continue;
    if (toolRow(step, run).decision === null) continue;
    steps.push({ step, intentId: guardedIntentId(step) });
    if (steps.length >= ATTACK_MAX_PROPOSALS) break;
  }
  return steps;
}

function proposalView(step: ToolStep, run: Run, records: AttackRecords): AttackProposalView {
  const row = toolRow(step, run);
  const decision = row.decision as DecisionView;
  const readable = records.kind === "shown" && records.detail.readable ? records.detail : null;
  return {
    id: step.id,
    action: step.name,
    args: row.args.map((arg) => ({ label: arg.label, value: maskEmails(arg.value) })),
    decision: {
      ...decision,
      reasons: decision.reasons.map((reason) => ({ ...reason })),
    },
    claims: readable === null ? [] : readable.claims.map(claimRow).map(maskedClaim),
    trace: readable === null ? [] : readable.trace.map(traceRow).map(maskedTrace),
    note:
      records.kind === "no_intent"
        ? ATTACK_COPY.noIntent
        : readable === null
          ? ATTACK_COPY.recordsUnread
          : null,
  };
}

/**
 * The attack page's view of a thread and the gate's records for its guarded calls, keyed by step
 * ID. A call with no records read yet shows its decision only, saying the records weren't read.
 */
export function attackView(
  thread: ThreadDetail,
  records: ReadonlyMap<string, AttackRecords>,
): AttackView {
  const message = thread.messages[0];
  const run = latestRun(thread);
  const working = isWorking(run);
  const proposals =
    run === undefined
      ? []
      : guardedSteps(run).map(({ step }) =>
          proposalView(step, run, records.get(step.id) ?? { kind: "unread" }),
        );
  return {
    threadId: thread.thread_id,
    channelLabel: message?.channel === "chat" ? "Chat" : "Email",
    sender: maskEmails(message?.sender_email ?? message?.sender_phone ?? "Unknown sender"),
    body: message?.body ?? "",
    working,
    status: statusBadge(run?.status ?? "queued"),
    outcome: run === undefined ? null : outcomeSentence(run.status, run.outcome),
    proposals,
    noProposal:
      working || proposals.length > 0
        ? null
        : run?.status === "not_run"
          ? ATTACK_COPY.notRun
          : ATTACK_COPY.noProposal,
    reply: run?.status === "replied" && run.reply !== null ? maskEmails(run.reply) : null,
  };
}

export type VisitorCounterView = {
  value: string;
  badge: { tone: "positive" | "danger" | "warning"; label: string };
  line: string;
};

/**
 * The counter of money moved by visitors, from the gate's audit-log read: the USD total always,
 * then any other currency with money in it; green at zero. Unknown or unread says why, and never
 * shows $0.00.
 */
export function visitorCounter(
  answer: { ok: true; value: VisitorMoney } | { ok: false; message: string },
): VisitorCounterView {
  const unsure = { tone: "warning", label: ATTACK_COPY.counterUnsureBadge } as const;
  if (!answer.ok) {
    return { value: ATTACK_COPY.counterUnread, badge: unsure, line: answer.message };
  }
  if (!answer.value.known) {
    return { value: ATTACK_COPY.counterUnknown, badge: unsure, line: answer.value.problem };
  }
  const moved = answer.value.moved;
  const count = moved.reduce((sum, each) => sum + each.count, 0);
  const shown = moved.filter((each, index) => index === 0 || each.count > 0);
  return {
    value: shown.map((each) => each.total.display).join(" + "),
    badge:
      count === 0
        ? { tone: "positive", label: ATTACK_COPY.counterHeldBadge }
        : { tone: "danger", label: ATTACK_COPY.counterMovedBadge },
    line: count === 0 ? ATTACK_COPY.counterLine : ATTACK_COPY.counterMoved(count),
  };
}
