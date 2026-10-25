import type { Answer } from "./approval-routes";
import { VERDICT_BADGES } from "./approvals-view";
import type { ChainVerdict, ClaimPair, DecisionDetail } from "./audit-schemas";
import {
  type ChainView,
  chainView,
  DECISION_BADGES,
  DECISIONS_COPY,
  type Tone,
} from "./decisions-view";
import { payoutStatusInline } from "./payout-words";
import { formatTime } from "./time";

// What a decision's page shows (ADR 0034), worked out from the gate's parsed decision detail and a
// fresh chain verdict. Pure, so the page only renders it. Nothing is judged here: the verdicts come
// from the gate's claims-vs-records pairs, an unreadable entry says so, and the chain badge comes
// only from a verdict.

export const DECISION_COPY = {
  decisions: "Decisions",
  openTicket: "Open ticket",
  claimsHeading: "Claims vs records",
  claimsColumn: "What the message claims",
  recordsColumn: "What the records say",
  resultColumn: "Result",
  noClaim: "No claim",
  simulated: "Simulated",
  traceHeading: "How the gate decided",
  traceCheck: "Check",
  traceRecords: "Records read",
  traceResult: "Result",
  noRecordsRead: "No records read",
  replyHeading: "Suggested reply",
  replyNote: "Only repeats what the records say",
  copyReply: "Copy reply",
  copied: "Copied",
  happenedHeading: "What happened",
  waiting: "Waiting for you",
  checkChain: "Check the chain",
  intentHash: "Intent hash",
  hash: "Hash",
  prevHash: "Previous hash",
  mandate: "Mandate",
  exportIntent: "Export evidence",
  exportCapture: "Export evidence for this payment",
  unreadable: "This entry can't be read.",
  rawPayload: "Raw payload",
  noDecision: "There's no decision with that number.",
  noIntentDecision: "There's no decision for that intent.",
  backToDecisions: "Back to decisions",
  noMoneyMoved: "No money moved.",
  refunded: "PayPal refunded it.",
  invoiceSent: "The invoice was sent.",
  payoutSent: "The payout was sent.",
  notConfirmed: "PayPal hasn't confirmed it yet.",
} as const;

// What an executed dispute action did, by action: the outcome sentence, the request line and the
// result's start and end around the dispute ID.
const DISPUTE_ACTION_COPY = new Map([
  [
    "paypal.dispute.provide_evidence",
    {
      outcome: "The evidence was sent.",
      asked: "send the evidence",
      resultStart: "PayPal took the evidence for ",
    },
  ],
  [
    "paypal.dispute.accept_claim",
    {
      outcome: "The claim was accepted.",
      asked: "accept the claim",
      resultStart: "Accepted the claim on ",
    },
  ],
  [
    "paypal.dispute.make_offer",
    { outcome: "The offer was sent.", asked: "send the offer", resultStart: "Sent an offer on " },
  ],
]);

export { VERDICT_BADGES };

export const RESULT_BADGES = {
  pass: { label: "Pass", tone: "positive" },
  fail: { label: "Fail", tone: "danger" },
  unknown: { label: "Unknown", tone: "neutral" },
} as const satisfies Record<"pass" | "fail" | "unknown", { label: string; tone: Tone }>;

/** A sentence in pieces, so sandbox IDs render in mono and codes as inline code. */
export type Piece = { text: string } | { mono: string } | { code: string };

export type HashView = { short: string; full: string };

export type ClaimRowView = {
  check: string;
  claim: { text: string; quote: string | null; simulated: boolean } | null;
  record: {
    lead: string;
    detail: string;
    sources: { words: string; call: string; id: string }[];
  };
  verdict: { label: string; tone: Tone };
};

export type TraceRowView = {
  verifier: string;
  words: string;
  detail: string;
  records: { words: string; call: string; id: string }[];
  result: { label: string; tone: Tone };
};

export type HappenedView = { seq: number; at: string; when: string; pieces: Piece[] };

type Breadcrumb = { parent: { label: string; href: string }; current: string };

export type DecisionPageView =
  | {
      readable: true;
      seq: number;
      breadcrumb: Breadcrumb;
      title: string;
      badge: { label: string; tone: Tone };
      line: string;
      ticketHref: string | null;
      claims: ClaimRowView[];
      trace: TraceRowView[];
      why: {
        heading: string;
        items: { words: string; code: string | null; detail: string | null }[];
      };
      reply: { text: string; note: string } | null;
      happened: HappenedView[];
      waiting: { words: string; href: string } | null;
      entry: {
        heading: string;
        chain: ChainView;
        intentHash: HashView | null;
        hash: HashView;
        prevHash: HashView;
        mandate: string;
        checkHref: string;
      };
      exports: { label: string; href: string }[];
    }
  | {
      readable: false;
      seq: number;
      breadcrumb: Breadcrumb;
      title: string;
      line: string;
      problem: string;
      payload: string;
      entry: {
        heading: string;
        chain: ChainView;
        hash: HashView;
        prevHash: HashView;
        checkHref: string;
      };
    };

export type NotFoundView = { message: string; link: { label: string; href: string } };

export type DecisionPageOutcome =
  | { kind: "sign_in" }
  | { kind: "not_found"; view: NotFoundView }
  | { kind: "error"; message: string }
  | { kind: "view"; view: DecisionPageView };

export type IntentPageOutcome =
  | { kind: "sign_in" }
  | { kind: "not_found"; view: NotFoundView }
  | { kind: "error"; message: string }
  | { kind: "redirect"; href: string };

type Readable = Extract<DecisionDetail, { readable: true }>;
type Execution = NonNullable<NonNullable<Readable["status"]>["execution"]>;

const decisionsLink = { label: DECISION_COPY.decisions, href: "/decisions" };

/** A hash cut to its first 12 characters, with the full value for its tooltip. */
export function hashView(full: string): HashView {
  return { short: full.length > 16 ? `${full.slice(0, 12)}…` : full, full };
}

/** An absolute time, such as "20 Oct 2026, 08:01 UTC". */
export function absoluteTime(iso: string): string {
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return iso;
  const date = new Date(at);
  const day = date.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
  const time = date.toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "UTC",
  });
  return `${day}, ${time} UTC`;
}

const isInvoice = (detail: Readable, execution: Execution | null) =>
  execution?.invoice != null || detail.action === "paypal.invoice.send";

const isPayout = (detail: Readable, execution: Execution | null) =>
  execution?.payout != null || detail.action === "paypal.payout";

function executedSentence(detail: Readable, execution: Execution): string {
  if (isPayout(detail, execution)) return DECISION_COPY.payoutSent;
  return isInvoice(detail, execution) ? DECISION_COPY.invoiceSent : DECISION_COPY.refunded;
}

function outcomeSentence(detail: Readable): string {
  const execution = detail.status?.execution ?? null;
  // A step-up whose answer can't be read may have run, so it's unconfirmed, not "no money moved".
  if (detail.status?.kind === "unknown" && execution === null) return DECISION_COPY.notConfirmed;
  if (execution === null) return DECISION_COPY.noMoneyMoved;
  switch (execution.outcome) {
    case "executed":
      return (
        DISPUTE_ACTION_COPY.get(detail.action ?? "")?.outcome ?? executedSentence(detail, execution)
      );
    case "unknown":
    case "pending":
      // Not confirmed either way, so the page never says no money moved.
      return DECISION_COPY.notConfirmed;
    case "failed":
      return DECISION_COPY.noMoneyMoved;
  }
}

function subjectOf(detail: Readable): string | null {
  return detail.order_number ?? detail.target?.id ?? null;
}

function claimRow(pair: ClaimPair): ClaimRowView {
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

function traceRow(entry: Readable["trace"][number]): TraceRowView {
  return {
    verifier: entry.verifier,
    words: entry.words,
    detail: entry.detail,
    records: entry.records.map((record) => ({
      words: record.words,
      call: record.call,
      id: record.id ?? "none",
    })),
    result: { ...RESULT_BADGES[entry.result] },
  };
}

function whyOf(detail: Readable): Extract<DecisionPageView, { readable: true }>["why"] {
  if (detail.decision === "allow") {
    return {
      heading: "Why it was allowed",
      items: detail.matched_rules.map((rule) => ({
        words: "Allowed by rule",
        code: rule,
        detail: null,
      })),
    };
  }
  return {
    heading: detail.decision === "step_up" ? "Why it was held" : "Why it was denied",
    items: detail.reasons.map((reason) => ({
      words: reason.words,
      code: reason.code,
      detail: reason.detail === "" ? null : reason.detail,
    })),
  };
}

const lower = (text: string) => text.toLowerCase();

type TrailParts = Extract<Readable["trail"][number], { readable: true }>["parts"];
type PayoutResultParts = NonNullable<Extract<TrailParts, { kind: "execution.result" }>["payout"]>;

// "Paid out $45.00 to <payee>, batch <id> (waiting for the payee to claim it)." Without the
// request's payee and amount it only names the batch.
function payoutResultPieces(payout: PayoutResultParts): Piece[] {
  const { batch_id, item, payee, amount } = payout;
  const start: Piece[] =
    payee === null || amount === null
      ? [{ text: "PayPal took the payout, batch " }]
      : [{ text: `Paid out ${amount.display} to ` }, { mono: payee }, { text: ", batch " }];
  const end = item === null ? "." : ` (${payoutStatusInline(item.status)}).`;
  return [...start, { mono: batch_id }, { text: end }];
}

/** One trail entry as its sentence (requirements.md, "What happened"). */
export function trailPieces(entry: Readable["trail"][number]): Piece[] {
  if (!entry.readable) {
    return [{ text: `Entry ${entry.seq} (${entry.type}) can't be read: ${entry.problem}` }];
  }
  const parts = entry.parts;
  switch (parts.kind) {
    case "decision":
      return [
        {
          text:
            parts.decision === "allow"
              ? "Countersign allowed it."
              : parts.decision === "step_up"
                ? "Countersign held it for your approval."
                : "Countersign denied it.",
        },
      ];
    case "approval": {
      const where = parts.channel === "cli" ? "from the command line" : "on the approvals page";
      if (parts.outcome === "approved") return [{ text: `Approved by you ${where}.` }];
      if (parts.outcome === "denied") return [{ text: `Denied by you ${where}.` }];
      return parts.code === null
        ? [{ text: `An answer ${where} was turned away.` }]
        : [{ text: `An answer ${where} was turned away: ` }, { code: parts.code }, { text: "." }];
    }
    case "execution.requested": {
      const again = parts.replay ? " again" : "";
      const dispute = DISPUTE_ACTION_COPY.get(parts.action ?? "");
      if (dispute !== undefined) return [{ text: `Asked PayPal${again} to ${dispute.asked}.` }];
      if (parts.action === "paypal.payout") {
        return [{ text: `Asked PayPal${again} to pay out ${parts.amount.display}.` }];
      }
      return parts.request_id === null
        ? [{ text: `Asked PayPal${again} to send the invoice.` }]
        : [{ text: `Asked PayPal${again} to refund ${parts.amount.display}.` }];
    }
    case "execution.result": {
      if (parts.outcome === "executed") {
        if (parts.refund !== null) {
          return [
            { text: "PayPal refunded it: " },
            { mono: parts.refund.id },
            { text: `, ${lower(parts.refund.status)}.` },
          ];
        }
        if (parts.invoice !== null) {
          return [
            { text: "PayPal sent the invoice: " },
            { mono: parts.invoice.id },
            { text: `, ${lower(parts.invoice.status)}.` },
          ];
        }
        if (parts.dispute != null) {
          const { id, status, action } = parts.dispute;
          const start = DISPUTE_ACTION_COPY.get(action ?? "")?.resultStart;
          // Accepting a claim and sending an offer say no more than that; the other two add the
          // dispute's status, such as "under review".
          const saysStatus =
            action !== "paypal.dispute.accept_claim" && action !== "paypal.dispute.make_offer";
          const end =
            saysStatus && status !== null ? `: ${lower(status).replaceAll("_", " ")}.` : ".";
          return [{ text: start ?? "PayPal acted on " }, { mono: id }, { text: end }];
        }
        if (parts.payout != null) return payoutResultPieces(parts.payout);
        return [{ text: "PayPal did it." }];
      }
      if (parts.outcome === "unknown") return [{ text: "PayPal didn't confirm it." }];
      // A batch PayPal took and then denied carries no error, only its batch.
      if (parts.payout != null && parts.error === null) {
        return [
          { text: "PayPal denied the payout batch " },
          { mono: parts.payout.batch_id },
          { text: "." },
        ];
      }
      const name = parts.error?.name ?? null;
      const debug = parts.error?.debug_id ?? null;
      return [
        name === null ? { text: "PayPal refused it." } : { text: `PayPal refused it: ${name}.` },
        ...(debug === null ? [] : [{ text: " Debug ID " }, { mono: debug }, { text: "." }]),
      ];
    }
    case "reconciliation": {
      const webhook = parts.source === "webhook" ? parts.event : null;
      if (parts.payout != null) {
        const { item_id, status } = parts.payout;
        const end = { text: `: ${payoutStatusInline(status)}.` };
        return webhook !== null
          ? [
              { text: "Matched webhook " },
              { mono: webhook.id },
              { text: " to payout item " },
              { mono: item_id },
              end,
            ]
          : [{ text: "Re-read payout item " }, { mono: item_id }, end];
      }
      if (parts.refund === null) return [{ text: "Reconciled, with no refund or payout named." }];
      return webhook !== null
        ? [
            { text: "Matched webhook " },
            { mono: webhook.id },
            { text: " to refund " },
            { mono: parts.refund.id },
            { text: `, ${lower(parts.refund.status)}.` },
          ]
        : [
            { text: "Re-read refund " },
            { mono: parts.refund.id },
            { text: `: ${lower(parts.refund.status)}.` },
          ];
    }
    case "mandate.version":
      return [{ text: `Mandate ${parts.id} version ${parts.version}.` }];
  }
}

function readableView(
  detail: Readable,
  chain: ChainView,
  now: Date,
): Extract<DecisionPageView, { readable: true }> {
  const action = detail.action_words ?? detail.action ?? DECISIONS_COPY.unreadProposal;
  const subject = subjectOf(detail);
  const amount = detail.amount?.display ?? null;
  const title = [action, amount, subject === null ? null : `on ${subject}`]
    .filter((part) => part !== null)
    .join(" ");
  const from = detail.sender === null ? "" : ` from ${detail.sender}'s ticket`;
  const threadId = detail.ticket?.thread_id ?? null;
  const exports: { label: string; href: string }[] = [];
  if (detail.intent_id !== null) {
    exports.push({
      label: DECISION_COPY.exportIntent,
      href: `/api/audit/export?intent=${encodeURIComponent(detail.intent_id)}`,
    });
  }
  if (detail.target?.kind === "capture") {
    exports.push({
      label: DECISION_COPY.exportCapture,
      href: `/api/audit/export?capture=${encodeURIComponent(detail.target.id)}`,
    });
  }
  return {
    readable: true,
    seq: detail.seq,
    breadcrumb: {
      parent: decisionsLink,
      current: subject === null ? action : `${action} on ${subject}`,
    },
    title,
    badge: { ...DECISION_BADGES[detail.decision] },
    line: `Proposed by ${detail.principal}${from} at ${absoluteTime(detail.at)}. ${outcomeSentence(detail)}`,
    ticketHref: threadId === null ? null : `/inbox?thread=${encodeURIComponent(threadId)}`,
    claims: detail.claims.map(claimRow),
    trace: detail.trace.map(traceRow),
    why: whyOf(detail),
    reply:
      detail.decision === "deny" && detail.safe_reply_hint !== null
        ? { text: detail.safe_reply_hint, note: DECISION_COPY.replyNote }
        : null,
    happened: detail.trail.map((entry) => ({
      seq: entry.seq,
      at: entry.at,
      when: formatTime(entry.at, now),
      pieces: trailPieces(entry),
    })),
    waiting:
      detail.status?.kind === "open" ? { words: DECISION_COPY.waiting, href: "/approvals" } : null,
    entry: {
      heading: `Audit entry ${detail.entry.seq}`,
      chain,
      intentHash: detail.intent_hash === null ? null : hashView(detail.intent_hash),
      hash: hashView(detail.entry.hash),
      prevHash: hashView(detail.entry.prev_hash),
      mandate: `${detail.mandate.id} version ${detail.mandate.version}`,
      checkHref: "/audit",
    },
    exports,
  };
}

/** A decision's page from its detail and a fresh chain verdict. */
export function decisionView(
  detail: DecisionDetail,
  verify: Answer<ChainVerdict>,
  now: Date,
): DecisionPageView {
  const chain = chainView(verify, now);
  if (detail.readable) return readableView(detail, chain, now);
  return {
    readable: false,
    seq: detail.seq,
    breadcrumb: { parent: decisionsLink, current: `Decision ${detail.seq}` },
    title: `Decision ${detail.seq}`,
    line: DECISION_COPY.unreadable,
    problem: detail.problem,
    payload: detail.payload,
    entry: {
      heading: `Audit entry ${detail.seq}`,
      chain,
      hash: hashView(detail.hash),
      prevHash: hashView(detail.prev_hash),
      checkHref: "/audit",
    },
  };
}

const notFound = (message: string): NotFoundView => ({
  message,
  link: { label: DECISION_COPY.backToDecisions, href: "/decisions" },
});

/** What `/decisions/[seq]` shows for the loader's answers. A malformed number is not found too. */
export function decisionPageOf(
  detail: Answer<DecisionDetail>,
  verify: Answer<ChainVerdict>,
  now: Date,
): DecisionPageOutcome {
  if (!detail.ok) {
    if (detail.status === 401) return { kind: "sign_in" };
    if (detail.status === 404 || detail.status === 400) {
      return { kind: "not_found", view: notFound(DECISION_COPY.noDecision) };
    }
    return { kind: "error", message: detail.message };
  }
  if (!verify.ok && verify.status === 401) return { kind: "sign_in" };
  return { kind: "view", view: decisionView(detail.value, verify, now) };
}

/** What `/decisions/intent/[id]` does: redirect to the intent's newest decision, or say why not. */
export function intentPageOf(answer: Answer<{ decision_seq: number }>): IntentPageOutcome {
  if (answer.ok) return { kind: "redirect", href: `/decisions/${answer.value.decision_seq}` };
  if (answer.status === 401) return { kind: "sign_in" };
  if (answer.status === 404 || answer.status === 400) {
    return { kind: "not_found", view: notFound(DECISION_COPY.noIntentDecision) };
  }
  return { kind: "error", message: answer.message };
}
