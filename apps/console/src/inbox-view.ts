import { REASONS } from "@countersign/mandate";
import {
  AgentResponseSchema,
  CallToolResultSchema,
  type Run,
  type RunStatus,
  TextContentSchema,
  type ThreadDetail,
  type ThreadList,
  type ThreadMessage,
  type ThreadSummary,
  type ToolStep,
} from "./resolve-schemas";
import { formatTime } from "./time";

// What the inbox shows, worked out from Resolve's parsed answers. Pure: the caller passes the
// time, so the same answer always gives the same view.

export const POLL_INTERVAL_MS = 2_000;

/**
 * The Agent Toolkit's money tools, which the gate guards under the same names (ADR 0028). In
 * baseline mode these go straight to PayPal.
 */
export const MONEY_TOOLS: readonly string[] = [
  "create_refund",
  "accept_dispute_claim",
  "provide_dispute_evidence",
  "make_offer",
  "send_invoice",
  "pay_order",
  "create_payout",
];

export const NO_CHECKS = "No checks: straight to PayPal";

export type Tone = "neutral" | "positive" | "warning" | "danger";

export type StatusBadge = {
  label: "Replied" | "Working" | "Stopped" | "Not run";
  tone: Tone;
  /** A breathing dot, for work in progress. */
  live: boolean;
};

export type ThreadListItem = {
  id: string;
  href: string;
  channel: "email" | "chat";
  channelLabel: "Email" | "Chat";
  sender: string;
  title: string;
  time: string;
  status: StatusBadge;
  selected: boolean;
};

export type DecisionView = {
  label:
    | "Allowed"
    | "Waiting for approval"
    | "Approved by you"
    | "Denied by you"
    | "Expired, so denied"
    | "Denied";
  tone: Tone;
  reasons: { words: string; code: string }[];
};

export type ToolRow = {
  id: string;
  name: string;
  args: { label: string; value: string }[];
  /** The result in a few words. */
  result: string;
  /** The gate's decision, for a guarded call. */
  decision: DecisionView | null;
  /** PayPal's refund ID, for an allowed refund the gate executed or a baseline refund. */
  refundId: string | null;
  /** PayPal's invoice ID, for a held invoice send the merchant approved. */
  invoiceId: string | null;
  /** A baseline money call: no Countersign checks. */
  noChecks: boolean;
  /** The decision page for a guarded call whose proposal became an intent. */
  decisionHref: string | null;
};

export type RunView = {
  id: string;
  modeLabel: "Protected" | "Baseline";
  model: string;
  duration: string | null;
  status: StatusBadge;
  working: boolean;
  toolRows: ToolRow[];
  reply: string | null;
  /** One plain sentence for a run that stopped, failed or didn't run. */
  outcome: string | null;
};

export type MessageView = {
  id: string;
  sender: string;
  subject: string | null;
  body: string;
  time: string;
  photos: { src: string; alt: string }[];
};

export type ThreadEntry = { kind: "message"; message: MessageView } | { kind: "run"; run: RunView };

export type ThreadView = {
  id: string;
  title: string;
  sender: string;
  channelLabel: "Email" | "Chat";
  working: boolean;
  entries: ThreadEntry[];
};

const isWorking = (status: RunStatus) => status === "queued" || status === "running";

export function statusBadge(status: RunStatus | null): StatusBadge {
  switch (status) {
    case "queued":
    case "running":
      return { label: "Working", tone: "neutral", live: true };
    case "replied":
      return { label: "Replied", tone: "positive", live: false };
    case "stopped":
    case "failed":
      return { label: "Stopped", tone: "warning", live: false };
    default:
      return { label: "Not run", tone: "neutral", live: false };
  }
}

const sender = (from: { sender_email: string | null; sender_phone: string | null }) =>
  from.sender_email ?? from.sender_phone ?? "Unknown sender";

const channelLabel = (channel: "email" | "chat") => (channel === "email" ? "Email" : "Chat");

export { formatTime };

/** Compact, "1m 08s" or "14s"; null until the run has started and finished. */
export function formatDuration(startedAt: string | null, finishedAt: string | null): string | null {
  if (startedAt === null || finishedAt === null) return null;
  const ms = Date.parse(finishedAt) - Date.parse(startedAt);
  if (Number.isNaN(ms) || ms < 0) return null;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
}

const titleOf = (thread: Pick<ThreadSummary, "subject" | "preview">) =>
  thread.subject ?? (thread.preview.trim() === "" ? "No message text" : thread.preview);

export function threadListItems(
  list: ThreadList,
  options: { now: Date; selectedId?: string | null },
): ThreadListItem[] {
  const time = (iso: string) => {
    const at = Date.parse(iso);
    return Number.isNaN(at) ? 0 : at;
  };
  return [...list.threads]
    .sort((a, b) => time(b.latest_activity_at) - time(a.latest_activity_at))
    .map((thread) => ({
      id: thread.thread_id,
      href: `/inbox?thread=${thread.thread_id}`,
      channel: thread.channel,
      channelLabel: channelLabel(thread.channel),
      sender: sender(thread),
      title: titleOf(thread),
      time: formatTime(thread.latest_activity_at, options.now),
      status: statusBadge(thread.latest_run?.status ?? null),
      selected: thread.thread_id === options.selectedId,
    }));
}

/** True while any listed thread's latest run is queued or running. */
export const listIsWorking = (list: ThreadList): boolean =>
  list.threads.some((thread) => thread.latest_run !== null && isWorking(thread.latest_run.status));

// Outcomes, one plain sentence each. Unknown codes still get a sentence, never silence.
const OUTCOMES: Record<string, string> = {
  step_cap: "Resolve stopped: it reached its limit of 8 model calls or 12 tool calls.",
  unknown_tool: "Resolve stopped: Gemini asked for a tool Resolve doesn't have.",
  empty_reply: "Resolve stopped: Gemini finished without a reply.",
  model_unavailable: "Resolve stopped: Gemini wasn't available.",
  model_error: "Resolve stopped: Gemini refused the request.",
  tool_transport_failed: "Resolve stopped: the connection to its tools broke.",
  gate_unavailable: "Resolve stopped: it couldn't reach Countersign.",
  baseline_unavailable: "Resolve stopped: it couldn't connect to PayPal's tools.",
  interrupted: "Resolve stopped: it was restarted during this run.",
  daily_cap: "Resolve didn't run: today's run limit is reached.",
  not_configured: "Resolve didn't run: no Gemini API key is set.",
};

const BLOCKED = new Set([
  "SAFETY",
  "BLOCKLIST",
  "PROHIBITED_CONTENT",
  "SPII",
  "IMAGE_SAFETY",
  "JAILBREAK",
  "RECITATION",
]);

const STOP_REASONS: Record<string, string> = {
  NO_CANDIDATE: "Resolve stopped: Gemini sent no answer.",
  NO_PARTS: "Resolve stopped: Gemini's answer was empty.",
};

export function outcomeSentence(status: RunStatus, outcome: string | null): string | null {
  if (status === "replied" || isWorking(status)) return null;
  if (outcome?.startsWith("model_stopped:")) {
    const reason = outcome.slice("model_stopped:".length);
    if (BLOCKED.has(reason)) return "Resolve stopped: Gemini blocked its answer.";
    return STOP_REASONS[reason] ?? "Resolve stopped: Gemini didn't finish its answer.";
  }
  const known = outcome === null ? undefined : OUTCOMES[outcome];
  if (known !== undefined) return known;
  return status === "not_run" ? "Resolve didn't run." : "Resolve stopped.";
}

const DECISIONS = {
  allowed: { label: "Allowed", tone: "positive" },
  pending_approval: { label: "Waiting for approval", tone: "warning" },
  denied: { label: "Denied", tone: "danger" },
} as const;

/** A reason code's words from the mandate catalog (ADR 0018). */
export function reasonWords(code: string): string {
  return Object.hasOwn(REASONS, code)
    ? REASONS[code as keyof typeof REASONS].words
    : "Countersign gave a reason this console doesn't know.";
}

const ARG_LABELS: [string, string][] = [
  ["order_number", "Order"],
  ["capture_id", "Capture"],
  ["dispute_id", "Dispute"],
  ["invoice_id", "Invoice"],
  ["amount", "Amount"],
  ["offer_amount", "Amount"],
];

function argText(value: unknown): string | null {
  if (typeof value === "string") return value.length > 60 ? `${value.slice(0, 59)}…` : value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "object" && value !== null) {
    const money = value as { value?: unknown; currency_code?: unknown };
    if (
      (typeof money.value === "string" || typeof money.value === "number") &&
      typeof money.currency_code === "string"
    ) {
      return `${money.value} ${money.currency_code}`;
    }
  }
  return null;
}

function keyArgs(args: Record<string, unknown>): { label: string; value: string }[] {
  const shown: { label: string; value: string }[] = [];
  for (const [key, label] of ARG_LABELS) {
    const value = Object.hasOwn(args, key) ? argText(args[key]) : null;
    if (value !== null) shown.push({ label, value });
  }
  return shown;
}

const firstText = (content: unknown[] | undefined): string | null => {
  for (const part of content ?? []) {
    const text = TextContentSchema.safeParse(part);
    if (text.success && text.data.text.trim() !== "") return text.data.text.trim();
  }
  return null;
};

const short = (text: string) => {
  const line = text.split(/\r?\n/)[0] ?? "";
  return line.length > 100 ? `${line.slice(0, 99)}…` : line;
};

/** A JSON object from the structured content, or from the first text part. */
function answerObject(structured: unknown, text: string | null): Record<string, unknown> | null {
  if (typeof structured === "object" && structured !== null && !Array.isArray(structured)) {
    return structured as Record<string, unknown>;
  }
  if (text === null) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

const str = (value: unknown) => (typeof value === "string" && value !== "" ? value : null);

/** What a held call turned into, once the merchant answered or the step-up ran out. */
const HELD_STATES = {
  approved: { label: "Approved by you", tone: "positive" },
  denied: { label: "Denied by you", tone: "danger" },
  expired: { label: "Expired, so denied", tone: "danger" },
  waiting: { label: "Waiting for approval", tone: "warning" },
} as const;

export function toolRow(step: ToolStep, run: Pick<Run, "mode" | "executions" | "held">): ToolRow {
  const row: ToolRow = {
    id: step.id,
    name: step.name,
    args: keyArgs(step.args),
    result: "Answered.",
    decision: null,
    refundId: null,
    invoiceId: null,
    noChecks: run.mode === "baseline" && MONEY_TOOLS.includes(step.name),
    decisionHref: null,
  };
  if (step.result === null) return { ...row, result: "The connection to the tool failed." };
  const result = CallToolResultSchema.safeParse(step.result);
  if (!result.success) return { ...row, result: "The tool's answer couldn't be read." };
  const text = firstText(result.data.content);
  if (result.data.isError === true) {
    return { ...row, result: text === null ? "The tool answered with an error." : short(text) };
  }

  if (run.mode === "protected") {
    const decided = AgentResponseSchema.safeParse(result.data.structuredContent);
    if (decided.success) {
      const response = decided.data;
      const heldCall =
        response.decision === "pending_approval"
          ? run.held.find((entry) => entry.intent_id === response.intent_id)
          : undefined;
      const shown =
        heldCall === undefined ? DECISIONS[response.decision] : HELD_STATES[heldCall.state];
      const reasons =
        response.decision === "allowed"
          ? []
          : response.reasons.map(({ code }) => ({ words: reasonWords(code), code }));
      const execution =
        response.decision === "allowed"
          ? run.executions.find((entry) => entry.intent_id === response.intent_id)
          : undefined;
      return {
        ...row,
        result: shown.label,
        decision: { label: shown.label, tone: shown.tone, reasons },
        decisionHref:
          response.intent_id === null
            ? null
            : `/decisions/intent/${encodeURIComponent(response.intent_id)}`,
        refundId:
          step.name === "create_refund"
            ? (execution?.refund_id ?? heldCall?.refund_id ?? null)
            : null,
        invoiceId: heldCall?.state === "approved" ? heldCall.invoice_id : null,
      };
    }
  }

  const answer = answerObject(result.data.structuredContent, text);
  if (row.noChecks) {
    const id = str(answer?.id);
    const status = str(answer?.status);
    if (step.name === "create_refund" && id !== null) {
      return {
        ...row,
        result: status === null ? `Refund ${id}` : `Refund ${id}, ${status}`,
        refundId: id,
      };
    }
    return { ...row, result: status === null ? "PayPal answered." : `PayPal answered: ${status}` };
  }
  if (step.local && answer !== null && str(answer.order_number) !== null) {
    const amount = argText(answer.amount);
    return {
      ...row,
      result: `Found ${answer.order_number}${amount === null ? "" : `, ${amount}`}`,
    };
  }
  return row;
}

export function runView(run: Run): RunView {
  const steps = run.trace?.steps ?? [];
  return {
    id: run.run_id,
    modeLabel: run.mode === "protected" ? "Protected" : "Baseline",
    model: run.model_versions.at(-1) ?? run.model,
    duration: formatDuration(run.started_at, run.finished_at),
    status: statusBadge(run.status),
    working: isWorking(run.status),
    toolRows: steps.flatMap((step) => (step.kind === "tool" ? [toolRow(step, run)] : [])),
    reply: run.status === "replied" ? run.reply : null,
    outcome: outcomeSentence(run.status, run.outcome),
  };
}

function messageView(message: ThreadMessage, now: Date): MessageView {
  return {
    id: message.ticket_id,
    sender: sender(message),
    subject: message.subject,
    body: message.body,
    time: formatTime(message.received_at, now),
    photos: message.attachments.map((photo, index) => ({
      src: `/api/resolve/attachments/${photo.id}`,
      alt: `Photo ${index + 1} from the customer`,
    })),
  };
}

export function threadView(thread: ThreadDetail, options: { now: Date }): ThreadView {
  const entries: ThreadEntry[] = [];
  const placed = new Set<string>();
  for (const message of thread.messages) {
    entries.push({ kind: "message", message: messageView(message, options.now) });
    for (const run of thread.runs) {
      if (run.ticket_id !== message.ticket_id) continue;
      entries.push({ kind: "run", run: runView(run) });
      placed.add(run.run_id);
    }
  }
  for (const run of thread.runs) {
    if (!placed.has(run.run_id)) entries.push({ kind: "run", run: runView(run) });
  }
  const first = thread.messages[0] as ThreadMessage;
  return {
    id: thread.thread_id,
    title: first.subject ?? titleOf({ subject: null, preview: first.body.split(/\r?\n/)[0] ?? "" }),
    sender: sender(first),
    channelLabel: channelLabel(first.channel),
    working: thread.runs.some((run) => isWorking(run.status)),
    entries,
  };
}
