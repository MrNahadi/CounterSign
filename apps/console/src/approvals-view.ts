import {
  type AnswerResult,
  AnswerResultSchema,
  type ApprovalsView,
  type Card,
  type CardParams,
  GateMessageSchema,
  type RecentSummary,
} from "./approval-schemas";
import type { ClaimPair } from "./audit-schemas";
import { formatTime } from "./time";

// What the approvals page shows (ADR 0032), worked out from the gate's parsed answers. Pure apart
// from the three calls at the bottom, which take their fetch. No server-only imports, so the
// page's client components can use it.

export const APPROVALS_POLL_INTERVAL_MS = 3_000;

export type Tone = "neutral" | "positive" | "warning" | "danger";

/** The approvals page's sentences that aren't an answer's outcome. */
export const APPROVALS_COPY = {
  keyLabel: "Approver key",
  signInLine: "Sign in with the approver key to answer held calls.",
  signIn: "Sign in",
  signOut: "Sign out",
  wrongKey: "That key isn't right.",
  unreachable: "The gate isn't reachable. Start it, then try again.",
  noOpen: "Nothing is waiting for you. Held calls will appear here.",
  noRecent: "No answers yet.",
  expired: "Expired",
  claimsHeading: "Claims vs records",
  claimsColumn: "What the message claims",
  recordsColumn: "What the records say",
  noClaim: "No claim",
  approvingHeading: "What you're approving",
  evidenceLine:
    "Approving sends exactly this evidence to PayPal. Nothing is sent until you approve.",
  itemsHeading: "Evidence",
  documentsHeading: "Documents",
  tracking: "Tracking",
  refunds: "Refunds",
  download: "Download",
  documentGone: "This document changed or is gone. Approving sends nothing.",
} as const;

// The rows' labels and fixed values for the parameters that aren't evidence.
const PARAM_WORDS = {
  dispute: "Dispute",
  note: "Note",
  noNote: "No note",
  offer: "Offer",
  notSet: "Not set",
  amount: "Amount",
  recipient: "Recipient",
  emailsRecipient: "PayPal emails the invoice's recipient",
  noEmail: "PayPal doesn't email the recipient",
  alsoTo: "Also sent to",
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

/** Verdict badges, worded as the decision page words them (ADR 0034). */
export const VERDICT_BADGES = {
  matches: { label: "Matches", tone: "positive" },
  contradicts: { label: "Contradicts", tone: "danger" },
  passes: { label: "Passes", tone: "positive" },
  fails: { label: "Fails", tone: "danger" },
  no_record: { label: "No record", tone: "neutral" },
  not_used: { label: "Not used", tone: "neutral" },
} as const satisfies Record<ClaimPair["verdict"], { label: string; tone: Tone }>;

export type ClaimPairView = {
  /** Stable key: the check that decided, or "message" / "proposal". */
  check: string;
  claim: { text: string; quote: string | null; simulated: boolean } | null;
  record: {
    lead: string;
    detail: string;
    sources: { words: string; call: string; id: string }[];
  };
  verdict: { label: string; tone: Tone };
};

export function claimPairView(pair: ClaimPair): ClaimPairView {
  return {
    check: pair.check,
    claim: pair.claim === null ? null : { ...pair.claim },
    record: {
      lead:
        pair.record.value === null
          ? pair.record.words
          : `${pair.record.words}: ${pair.record.value}`,
      detail: pair.record.detail,
      sources: pair.record.sources.map((source) => ({ ...source })),
    },
    verdict: { ...VERDICT_BADGES[pair.verdict] },
  };
}

export type CheckLine = {
  verifier: string;
  result: string;
  tone: Tone;
  value: string | null;
  recordId: string | null;
};

export type ParamRow = { label: string; text: string; mono: boolean };

export type EvidenceItemView = {
  /** Stable key: the item's place in the submission, from 1. */
  id: string;
  type: string;
  notes: string;
  /** The tracking numbers and the carrier name they're sent under; null when there are none. */
  tracking: { carrier: string; numbers: string[] } | null;
  refundIds: string[];
};

export type DocumentView = {
  id: string;
  name: string;
  size: string | null;
  sha: { short: string; full: string };
  /** The console route that downloads it; null when it changed or is gone. */
  href: string | null;
  problem: string | null;
};

/** What approving sends, from the card's parameters. */
export type ApprovingView = {
  line: string | null;
  rows: ParamRow[];
  items: EvidenceItemView[];
  documents: DocumentView[];
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
  /** What the message claims beside what the records say, one pair per check that decided. */
  claims: ClaimPairView[];
  /** What approving sends; null for a refund and any action with no executor. */
  approving: ApprovingView | null;
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

/** "1 byte", "512 bytes", "12.4 KB", "1.0 MB". */
export function sizeWords(bytes: number): string {
  if (bytes < 1024) return bytes === 1 ? "1 byte" : `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const shortHash = (full: string) => ({
  short: full.length > 16 ? `${full.slice(0, 12)}…` : full,
  full,
});

const row = (label: string, text: string, mono = false): ParamRow => ({ label, text, mono });
const noteRow = (note: string | null) => row(PARAM_WORDS.note, note ?? PARAM_WORDS.noNote);

/** What approving sends; a dispute action's rows start with the dispute it acts on. */
export function approvingView(params: CardParams, target: Card["target"]): ApprovingView {
  const view: ApprovingView = { line: null, rows: [], items: [], documents: [] };
  if (target.kind === "dispute") view.rows.push(row(PARAM_WORDS.dispute, target.id, true));
  switch (params.kind) {
    case "invoice_send":
      view.rows.push(
        row(
          PARAM_WORDS.recipient,
          params.send_to_recipient ? PARAM_WORDS.emailsRecipient : PARAM_WORDS.noEmail,
        ),
      );
      if (params.additional_recipients.length > 0) {
        view.rows.push(row(PARAM_WORDS.alsoTo, params.additional_recipients.join(", "), true));
      }
      view.rows.push(noteRow(params.note));
      return view;
    case "accept_claim":
      view.rows.push(noteRow(params.note));
      return view;
    case "make_offer":
      view.rows.push(
        row(PARAM_WORDS.offer, params.offer_type_words ?? params.offer_type ?? PARAM_WORDS.notSet),
      );
      if (params.amount !== null) view.rows.push(row(PARAM_WORDS.amount, params.amount.display));
      view.rows.push(noteRow(params.note));
      return view;
    case "provide_evidence":
      return {
        ...view,
        line: APPROVALS_COPY.evidenceLine,
        items: params.items.map((item, index) => ({
          id: `item-${index + 1}`,
          type: item.evidence_type_words,
          notes: item.notes,
          tracking:
            item.tracking_numbers.length === 0
              ? null
              : {
                  carrier: item.tracking_carrier ?? APPROVALS_COPY.tracking,
                  numbers: [...item.tracking_numbers],
                },
          refundIds: [...item.refund_ids],
        })),
        // A document that isn't the one hashed offers no download: approving it sends nothing.
        documents: params.documents.map((document) => {
          const available = document.available && document.size !== null;
          return {
            id: document.id,
            name: document.name,
            size: document.size === null ? null : sizeWords(document.size),
            sha: shortHash(document.sha256),
            href: available ? `/api/approvals/documents/${encodeURIComponent(document.id)}` : null,
            problem: available ? null : APPROVALS_COPY.documentGone,
          };
        }),
      };
  }
}

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
    claims: card.claims.map(claimPairView),
    approving: card.params === null ? null : approvingView(card.params, card.target),
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
    if (execution.dispute !== null) {
      const { id, status } = execution.dispute;
      return status === null ? `Dispute ${id}` : `Dispute ${id}, ${status}`;
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
  if (execution.dispute !== null) {
    const { id, status } = execution.dispute;
    return {
      sentence:
        status === null
          ? `Approved. PayPal took it for dispute ${id}.`
          : `Approved. Dispute ${id} is ${status.toLowerCase().replaceAll("_", " ")}.`,
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
  download: `${BUTTON} ${SECONDARY} h-8 gap-1.5 px-2.5`,
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
