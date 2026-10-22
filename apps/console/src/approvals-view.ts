import {
  type AnswerResult,
  AnswerResultSchema,
  type ApprovalsView,
  type Card,
  GateMessageSchema,
  type RecentSummary,
} from "./approval-schemas";
import { formatTime } from "./time";

// What the approvals page shows (ADR 0032), worked out from the gate's parsed answers. Pure apart
// from the three calls at the bottom, which take their fetch. No server-only imports, so the
// page's client components can use it.

export const APPROVALS_POLL_INTERVAL_MS = 3_000;

export type Tone = "neutral" | "positive" | "warning" | "danger";

/** The approvals page's sentences that aren't an answer's outcome. */
export const APPROVALS_COPY = {
  keyLabel: "Approver key",
  signIn: "Sign in",
  signOut: "Sign out",
  wrongKey: "That key isn't right.",
  unreachable: "The gate isn't reachable. Start it, then try again.",
  noOpen: "Nothing is waiting for you. Held calls will appear here.",
  noRecent: "No answers yet.",
  expired: "Expired",
} as const;

// One sentence per answer the gate can give (requirements.md, "The console").
export const REJECTION_SENTENCES = {
  HASH_MISMATCH: "This card changed. Nothing was sent.",
  ALREADY_ANSWERED: "This was already answered.",
  EXPIRED: "This card expired, so it counts as denied.",
  ALREADY_REQUESTED: "This was already carried out.",
  ACTION_UNAVAILABLE: "Countersign can't carry out this action yet.",
  DUPLICATE_REFUND: "Another refund already went to this payment.",
} as const satisfies Record<NonNullable<AnswerResult["code"]>, string>;

export const DENIED_SENTENCE = "Denied. Nothing was sent.";
export const UNCONFIRMED_SENTENCE = "Approved. PayPal hasn't confirmed it yet.";

// Verifiers in words (mandate VERIFIERS). An unknown name shows as itself, never hidden.
const VERIFIER_WORDS: Record<string, string> = {
  "capture.refundable": "Payment can be refunded",
  "ticket.from_payer": "Message is from the payer",
  "dispute.none_open": "No open dispute",
  "shipment.status": "Shipment status",
  "evidence.photo_present": "Photo attached",
  "payee.allowlisted": "Payee is on the allowlist",
  "ledger.not_duplicate": "Not a duplicate",
  "ledger.velocity": "Refund rate",
  "mpesa.receipt_verified": "M-Pesa receipt verified",
  "mpesa.amount_matches_order": "M-Pesa amount matches the order",
  "mpesa.overpayment_covers_refund": "Overpayment covers the refund",
  "mpesa.recipient_is_payer": "M-Pesa recipient is the payer",
  "mpesa.receipt_unused": "M-Pesa receipt not used before",
};

const RESULTS = {
  pass: { label: "Passed", tone: "positive" },
  fail: { label: "Failed", tone: "danger" },
  unknown: { label: "Unknown", tone: "warning" },
} as const;

const CLAIMS: Record<NonNullable<Card["claim"]>, string> = {
  not_received: "Says it didn't arrive",
  damaged: "Says it arrived damaged",
  wrong_item: "Says it's the wrong item",
};

export type CheckLine = {
  verifier: string;
  result: string;
  tone: Tone;
  value: string | null;
  recordId: string | null;
};

export type CardView = {
  id: string;
  /** The hash the card shows, sent back with the answer. */
  intentHash: string;
  title: string;
  order: string | null;
  sender: string | null;
  simulated: boolean;
  subject: string | null;
  excerpt: string | null;
  claim: string | null;
  photos: { src: string; alt: string }[];
  reasons: { words: string; code: string }[];
  checks: CheckLine[];
  timeLeft: string;
  expired: boolean;
  /** Set when Countersign can't carry the action out; the card then offers only Deny. */
  cannotExecute: string | null;
  actions: ("approve" | "deny")[];
};

export type RecentLine = {
  id: string;
  title: string;
  order: string | null;
  outcome: string;
  tone: Tone;
  detail: string | null;
  time: string;
};

export type PageView = { cards: CardView[]; recent: RecentLine[]; openCount: number };

/** "Expires in 12 min", whole minutes rounded up, then "Expired". */
export function timeLeft(expiresAt: string, now: Date): string {
  const left = Date.parse(expiresAt) - now.getTime();
  if (Number.isNaN(left) || left <= 0) return APPROVALS_COPY.expired;
  const minutes = Math.ceil(left / 60_000);
  if (minutes < 60) return `Expires in ${minutes} min`;
  return `Expires in ${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

const orderLabel = (orderNumber: string | null) =>
  orderNumber === null ? null : `Order ${orderNumber}`;

const timeOf = (iso: string) => {
  const at = Date.parse(iso);
  return Number.isNaN(at) ? 0 : at;
};

export function cardView(card: Card, now: Date): CardView {
  const left = timeLeft(card.expires_at, now);
  const expired = left === APPROVALS_COPY.expired || card.state !== "open";
  const cannotExecute = card.can_execute
    ? null
    : (card.cannot_execute ?? REJECTION_SENTENCES.ACTION_UNAVAILABLE);
  const actions: CardView["actions"] = expired
    ? []
    : card.can_execute
      ? ["approve", "deny"]
      : ["deny"];
  return {
    id: String(card.step_up_id),
    intentHash: card.intent_hash,
    title: `${card.action_words} ${card.amount.display}`,
    order: orderLabel(card.order_number),
    sender: card.ticket?.sender ?? null,
    simulated: card.ticket?.simulated ?? false,
    subject: card.ticket?.subject ?? null,
    excerpt: card.ticket === null || card.ticket.excerpt.trim() === "" ? null : card.ticket.excerpt,
    claim: card.claim === null ? null : CLAIMS[card.claim],
    photos: (card.ticket?.attachment_ids ?? []).map((id, index) => ({
      src: `/api/resolve/attachments/${encodeURIComponent(id)}`,
      alt: `Photo ${index + 1} from the customer`,
    })),
    reasons: card.reasons.map(({ words, code }) => ({ words, code })),
    checks: card.checks.map((check) => ({
      verifier: VERIFIER_WORDS[check.verifier] ?? check.verifier,
      result: RESULTS[check.result].label,
      tone: RESULTS[check.result].tone,
      value: check.value,
      recordId: check.records.find((record) => record.id !== null)?.id ?? null,
    })),
    timeLeft: left,
    expired,
    cannotExecute,
    actions,
  };
}

function recentDetail(summary: RecentSummary): string | null {
  const execution = summary.execution;
  if (summary.outcome !== "approved" || execution === null) return null;
  if (execution.outcome === "executed") {
    if (execution.refund !== null)
      return `Refund ${execution.refund.id}, ${execution.refund.status}`;
    if (execution.invoice !== null) {
      return `Invoice ${execution.invoice.id}, ${execution.invoice.status}`;
    }
    return "Carried out";
  }
  if (execution.outcome === "failed") return "PayPal refused it";
  if (execution.outcome === "pending") return "Not run yet";
  return "PayPal hasn't confirmed it yet";
}

const RECENT_OUTCOMES = {
  approved: { outcome: "Approved", tone: "positive" },
  denied: { outcome: "Denied", tone: "neutral" },
  expired: { outcome: "Expired, so denied", tone: "neutral" },
} as const;

export function recentLine(summary: RecentSummary, now: Date): RecentLine {
  const shown = RECENT_OUTCOMES[summary.outcome];
  const failed = summary.execution?.outcome === "failed";
  return {
    id: String(summary.step_up_id),
    title: `${summary.action_words} ${summary.amount.display}`,
    order: orderLabel(summary.order_number),
    outcome: shown.outcome,
    tone: failed ? "danger" : shown.tone,
    detail: recentDetail(summary),
    time: formatTime(summary.at, now),
  };
}

/** The open cards, newest first, and the recent answers. */
export function pageView(view: ApprovalsView, now: Date): PageView {
  const cards = [...view.open]
    .sort((a, b) => timeOf(b.decided_at) - timeOf(a.decided_at) || b.step_up_id - a.step_up_id)
    .map((card) => cardView(card, now));
  return {
    cards,
    recent: view.recent.map((summary) => recentLine(summary, now)),
    openCount: view.open.length,
  };
}

export type Outcome = { sentence: string; tone: Tone };

/** One sentence for what an answer did. */
export function answerOutcome(result: AnswerResult): Outcome {
  if (result.outcome === "rejected") {
    return {
      sentence:
        result.code === null
          ? "Countersign didn't accept this answer. Nothing was sent."
          : REJECTION_SENTENCES[result.code],
      tone: "warning",
    };
  }
  if (result.outcome === "denied") return { sentence: DENIED_SENTENCE, tone: "neutral" };
  const execution = result.execution;
  if (execution === null || execution.outcome === "unknown") {
    return { sentence: UNCONFIRMED_SENTENCE, tone: "warning" };
  }
  if (execution.outcome === "failed") {
    return {
      sentence: `Approved, but PayPal refused it: ${refusalText(execution.error)}`,
      tone: "danger",
    };
  }
  if (execution.refund !== null) {
    return { sentence: `Approved. Refund ${execution.refund.id} is done.`, tone: "positive" };
  }
  if (execution.invoice !== null) {
    const { id, status } = execution.invoice;
    return {
      sentence:
        status === "SCHEDULED"
          ? `Approved. Invoice ${id} is scheduled to send.`
          : `Approved. Invoice ${id} is sent.`,
      tone: "positive",
    };
  }
  return { sentence: UNCONFIRMED_SENTENCE, tone: "warning" };
}

function refusalText(error: NonNullable<AnswerResult["execution"]>["error"]): string {
  const parts = [error?.name ?? null, ...(error?.issues ?? [])].filter(
    (part): part is string => part !== null && part.trim() !== "",
  );
  if (parts.length === 0) return "it gave no reason.";
  const text = parts.join(", ");
  return /[.!?]$/.test(text) ? text : `${text}.`;
}

// --- Controls (Graphite Button and Input specs) ---------------------------------------------

const BUTTON =
  "inline-flex shrink-0 items-center justify-center whitespace-nowrap rounded-lg font-medium text-body-sm motion-safe:transition motion-safe:duration-150 motion-safe:ease-out motion-safe:active:scale-[0.97] disabled:cursor-not-allowed";
const PRIMARY =
  "bg-inverted-solid text-on-inverted-foreground hover:bg-inverted-solid-hover disabled:bg-disabled disabled:text-disabled-foreground";
const SECONDARY =
  "bg-component-on-container-strong text-primary-foreground shadow-default hover:bg-component-on-container-strong-hover disabled:bg-disabled disabled:text-disabled-foreground disabled:shadow-none";

/** Approve and Deny are 40px (brief §11); every other control is at least 24px. */
export const CONTROL_CLASSES = {
  approve: `${BUTTON} ${PRIMARY} h-10 flex-1 gap-2 px-3.5`,
  deny: `${BUTTON} ${SECONDARY} h-10 flex-1 gap-2 px-3.5`,
  signIn: `${BUTTON} ${PRIMARY} h-10 w-full gap-2 px-3.5`,
  signOut: `${BUTTON} h-8 gap-1.5 px-2.5 text-secondary-foreground hover:bg-transparent-hover hover:text-primary-foreground`,
  keyInput:
    "h-10 w-full rounded-lg bg-component-on-container-strong px-2.5 font-mono text-code-sm text-primary-foreground shadow-default placeholder:text-tertiary-foreground aria-invalid:inset-ring aria-invalid:inset-ring-danger-border-default",
} as const;

// --- Calls from the page (through the console's own routes) ----------------------------------

export type CallResult<T> = { ok: true; value: T } | { ok: false; status: number; message: string };

async function messageOf(response: Response): Promise<string> {
  try {
    const parsed = GateMessageSchema.safeParse(await response.json());
    return parsed.success ? parsed.data.message : APPROVALS_COPY.unreachable;
  } catch {
    return APPROVALS_COPY.unreachable;
  }
}

/** Answers one card, sending the hash the card showed. */
export async function answerCard(
  card: Pick<CardView, "id" | "intentHash">,
  answer: "approve" | "deny",
  fetchImpl: typeof fetch = fetch,
): Promise<CallResult<Outcome>> {
  let response: Response;
  try {
    response = await fetchImpl(`/api/approvals/${encodeURIComponent(card.id)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ answer, intent_hash: card.intentHash }),
      cache: "no-store",
    });
  } catch {
    return { ok: false, status: 502, message: APPROVALS_COPY.unreachable };
  }
  if (response.status !== 200) {
    return { ok: false, status: response.status, message: await messageOf(response) };
  }
  try {
    const result = AnswerResultSchema.safeParse(await response.json());
    if (result.success && String(result.data.step_up_id) === card.id) {
      return { ok: true, value: answerOutcome(result.data) };
    }
  } catch {
    // Falls through to the fixed sentence.
  }
  return { ok: false, status: 502, message: APPROVALS_COPY.unreachable };
}

/** Signs in with the key as typed. The key goes to the console's route, never into storage. */
export async function signIn(
  key: string,
  fetchImpl: typeof fetch = fetch,
): Promise<CallResult<null>> {
  try {
    const response = await fetchImpl("/api/approvals/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key }),
      cache: "no-store",
    });
    if (response.status === 200) return { ok: true, value: null };
    if (response.status === 401)
      return { ok: false, status: 401, message: APPROVALS_COPY.wrongKey };
    return { ok: false, status: response.status, message: await messageOf(response) };
  } catch {
    return { ok: false, status: 502, message: APPROVALS_COPY.unreachable };
  }
}

/** Signs out: the console's route clears the cookie. */
export async function signOut(fetchImpl: typeof fetch = fetch): Promise<boolean> {
  try {
    const response = await fetchImpl("/api/approvals/session", {
      method: "DELETE",
      cache: "no-store",
    });
    return response.status === 200;
  } catch {
    return false;
  }
}
