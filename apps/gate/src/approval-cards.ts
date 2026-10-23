// The approval cards (ADR 0032): what the merchant sees for each step-up, built from the step-up
// reader, the ticket store, the seeded order book and the execution entries. Read-only, no AI,
// and no network. The JSON uses the API's snake_case names.

import {
  type Database,
  readEvidenceDocument,
  readTicket,
  type SeedOrderRow,
  seedOrders,
  sha256Hex,
  sql,
  type Ticket,
} from "@countersign/db";
import {
  type Action,
  type EvidenceDocumentRef,
  formatMoney,
  type Intent,
  type IntentTarget,
  type Mandate,
  type Money,
  REASONS,
  type VerifierName,
} from "@countersign/mandate";
import { readStepUps, type StepUp, type StepUpState } from "./approval-log";
import { type ClaimPair, checksThatDecided, claimsVsRecords } from "./claims";
import { isExecutable } from "./executable";
import { type ExecutionOutcome, readIntentRecord } from "./execution-log";
import { EVIDENCE_CARRIER } from "./executors";
import { ACTION_WORDS, codeWords } from "./words";

export { ACTION_WORDS };

export const CANNOT_EXECUTE = "Countersign can't carry out this action yet.";

// The most characters of a ticket's body a card shows.
export const TICKET_EXCERPT_LENGTH = 280;

export type CardAmount = { minor: number; currency: Money["currency"]; display: string };

export type CardTarget = {
  kind: IntentTarget["kind"];
  // The capture, dispute, invoice or order ID, or the payee's email.
  id: string;
  // A capture's order, when known.
  order_id: string | null;
};

export type CardTicket = {
  id: string;
  channel: Ticket["channel"];
  sender: string | null;
  subject: string | null;
  excerpt: string;
  received_at: string;
  attachment_ids: string[];
  simulated: boolean;
};

export type CardCheck = {
  verifier: VerifierName;
  result: "pass" | "fail" | "unknown";
  value: string | null;
  detail: string;
  // Where the verifier read its records: the call and the record's ID.
  records: { call: string; id: string | null }[];
};

// One evidence item as it's sent. Tracking numbers go out under the simulated carrier's name.
export type CardEvidenceItem = {
  evidence_type: string;
  evidence_type_words: string;
  notes: string;
  tracking_numbers: string[];
  // The carrier name PayPal is sent with the tracking numbers; null when there are none.
  tracking_carrier: string | null;
  refund_ids: string[];
};

// One evidence document as the intent binds it, beside the stored row. `available` is false when
// the row is gone or isn't the one hashed, so approving it would send nothing; `size` is then null.
export type CardDocument = {
  id: string;
  name: string;
  sha256: string;
  size: number | null;
  available: boolean;
};

// The parameters that execute, by action. A refund, and any action with no executor, has none.
export type CardParams =
  | {
      kind: "invoice_send";
      note: string | null;
      send_to_recipient: boolean;
      additional_recipients: string[];
    }
  | { kind: "accept_claim"; note: string | null }
  | {
      kind: "make_offer";
      offer_type: string | null;
      offer_type_words: string | null;
      // Null for a replacement without a refund, which offers no money.
      amount: CardAmount | null;
      note: string | null;
    }
  | { kind: "provide_evidence"; items: CardEvidenceItem[]; documents: CardDocument[] };

export type Card = {
  step_up_id: number;
  intent_id: string;
  intent_hash: string;
  principal: string;
  action: Action;
  action_words: string;
  amount: CardAmount;
  target: CardTarget;
  order_number: string | null;
  ticket: CardTicket | null;
  claim: StepUp["intent"]["claim"];
  // What approving sends, from the stored intent's hashed parameters.
  params: CardParams | null;
  reasons: { code: string; words: string; detail: string }[];
  // What the message claims beside what the records say (the same pairs as the decision page).
  claims: ClaimPair[];
  checks: CardCheck[];
  decided_at: string;
  expires_at: string;
  state: StepUpState;
  answer: { outcome: "approved" | "denied"; at: string; channel: string } | null;
  can_execute: boolean;
  // The sentence a card that can't execute shows; null when it can.
  cannot_execute: string | null;
};

export type CardExecution = {
  // `pending` while the result isn't logged yet; `unknown` when the entries can't be read.
  outcome: ExecutionOutcome | "pending";
  refund: { id: string; status: string } | null;
  invoice: { id: string; status: string } | null;
  // The dispute a dispute action acted on, with its status as re-read after the call.
  dispute: { id: string; status: string | null } | null;
};

export type RecentSummary = {
  step_up_id: number;
  intent_id: string;
  action: Action;
  action_words: string;
  amount: CardAmount;
  order_number: string | null;
  outcome: "approved" | "denied" | "expired";
  // The answer time, or the expiry for an expired step-up.
  at: string;
  channel: string | null;
  // What carrying out an approved intent did; null unless approved.
  execution: CardExecution | null;
};

export type CardContext = {
  ticket: Ticket | null;
  orderNumber: string | null;
  // The principals' mandates. A step-up's own (by hash) narrows the checks to those that decided.
  mandates: readonly Mandate[];
  // The stored sizes of the evidence documents the intent names, by ID, for those whose bytes,
  // name and type are still the ones hashed. A document missing here shows as unavailable.
  documents?: ReadonlyMap<string, number>;
};

export const amountOf = (money: Money): CardAmount => ({ ...money, display: formatMoney(money) });

export function targetOf(target: IntentTarget): CardTarget {
  switch (target.kind) {
    case "capture":
      return { kind: "capture", id: target.captureId, order_id: target.orderId };
    case "dispute":
      return { kind: "dispute", id: target.disputeId, order_id: null };
    case "invoice":
      return { kind: "invoice", id: target.invoiceId, order_id: null };
    case "order":
      return { kind: "order", id: target.orderId, order_id: target.orderId };
    case "payee":
      return { kind: "payee", id: target.email, order_id: null };
  }
}

export function ticketOf(ticket: Ticket): CardTicket {
  return {
    id: ticket.id,
    channel: ticket.channel,
    sender: ticket.senderEmail ?? ticket.senderPhone,
    subject: ticket.subject,
    excerpt: [...ticket.body].slice(0, TICKET_EXCERPT_LENGTH).join(""),
    received_at: ticket.receivedAt,
    attachment_ids: ticket.attachments.map((attachment) => attachment.id),
    simulated: ticket.simulated,
  };
}

const listOf = (values: readonly string[] | null | undefined): string[] => [...(values ?? [])];

// The parameters that execute, as the action's executor reads them from the stored intent.
export function paramsOf(
  intent: Intent,
  documents: ReadonlyMap<string, number>,
): CardParams | null {
  const params = intent.params ?? {};
  const note = params.note ?? null;
  switch (intent.action) {
    case "paypal.invoice.send":
      return {
        kind: "invoice_send",
        note,
        send_to_recipient: params.sendToRecipient ?? true,
        additional_recipients: listOf(params.additionalRecipients),
      };
    case "paypal.dispute.accept_claim":
      return { kind: "accept_claim", note };
    case "paypal.dispute.make_offer": {
      const offerType = params.offerType ?? null;
      return {
        kind: "make_offer",
        offer_type: offerType,
        offer_type_words: offerType === null ? null : codeWords(offerType),
        amount: offerType === "REPLACEMENT_WITHOUT_REFUND" ? null : amountOf(intent.amount),
        note,
      };
    }
    case "paypal.dispute.provide_evidence":
      return {
        kind: "provide_evidence",
        items: (params.evidence ?? []).map((item) => {
          const tracking = listOf(item.trackingNumbers);
          return {
            evidence_type: item.evidenceType,
            evidence_type_words: codeWords(item.evidenceType),
            notes: item.notes,
            tracking_numbers: tracking,
            tracking_carrier: tracking.length === 0 ? null : EVIDENCE_CARRIER.nameOther,
            refund_ids: listOf(item.refundIds),
          };
        }),
        documents: (params.documents ?? []).map((ref) => {
          const size = documents.get(ref.id) ?? null;
          return { id: ref.id, name: ref.name, sha256: ref.sha256, size, available: size !== null };
        }),
      };
    default:
      return null;
  }
}

// One step-up as the merchant's card.
export function cardView(stepUp: StepUp, context: CardContext): Card {
  const { intent } = stepUp;
  // A step-up always has its intent, so the proposal text (read only for a malformed proposal)
  // is never used.
  const decision = { ...stepUp, intent, proposal: "" };
  const canExecute = isExecutable(intent.action);
  return {
    step_up_id: stepUp.seq,
    intent_id: stepUp.intentId,
    intent_hash: stepUp.intentHash,
    principal: stepUp.principal,
    action: intent.action,
    action_words: ACTION_WORDS[intent.action],
    amount: amountOf(intent.amount),
    target: targetOf(intent.target),
    order_number: context.orderNumber,
    ticket: context.ticket === null ? null : ticketOf(context.ticket),
    claim: intent.claim,
    params: paramsOf(intent, context.documents ?? new Map()),
    reasons: stepUp.reasons.map(({ code, detail }) => ({
      code,
      words: REASONS[code].words,
      detail,
    })),
    claims: claimsVsRecords(decision, context),
    checks: checksThatDecided(decision, context.mandates).map((entry) => ({
      verifier: entry.verifier,
      result: entry.result,
      value: entry.value ?? null,
      detail: entry.detail,
      records: entry.records.map(({ call, id }) => ({ call, id })),
    })),
    decided_at: stepUp.decidedAt,
    expires_at: stepUp.expiresAt,
    state: stepUp.state,
    answer:
      stepUp.answer === null
        ? null
        : { outcome: stepUp.answer.outcome, at: stepUp.answer.at, channel: stepUp.answer.channel },
    can_execute: canExecute,
    cannot_execute: canExecute ? null : CANNOT_EXECUTE,
  };
}

// The seeded order a target belongs to, by its capture or order ID.
async function orderNumberOf(db: Database, target: IntentTarget): Promise<string | null> {
  const ids =
    target.kind === "capture"
      ? { capture: target.captureId, order: target.orderId }
      : target.kind === "order"
        ? { capture: null, order: target.orderId }
        : null;
  if (ids === null) return null;
  const rows: Pick<SeedOrderRow, "orderNumber">[] = await db
    .select({ orderNumber: seedOrders.orderNumber })
    .from(seedOrders)
    .where(
      sql`${seedOrders.paypalCaptureId} = ${ids.capture ?? ""} OR ${seedOrders.paypalOrderId} = ${ids.order ?? ""}`,
    )
    .limit(1);
  return rows[0]?.orderNumber ?? null;
}

// The evidence documents' stored sizes, kept only where the row is still what the executor would
// send: the hashed SHA-256 (recomputed from the bytes), the hashed name and a PDF.
async function documentSizesOf(
  db: Database,
  refs: readonly EvidenceDocumentRef[],
): Promise<Map<string, number>> {
  const sizes = new Map<string, number>();
  for (const ref of refs) {
    const stored = await readEvidenceDocument(db, ref.id);
    if (
      stored !== null &&
      sha256Hex(stored.bytes) === ref.sha256 &&
      stored.name === ref.name &&
      stored.contentType === "application/pdf"
    ) {
      sizes.set(ref.id, stored.bytes.byteLength);
    }
  }
  return sizes;
}

async function contextOf(
  db: Database,
  stepUp: StepUp,
  mandates: readonly Mandate[],
): Promise<CardContext> {
  const { ticketId, target, params } = stepUp.intent;
  const [ticket, orderNumber, documents] = await Promise.all([
    ticketId === null ? null : readTicket(db, ticketId),
    orderNumberOf(db, target),
    documentSizesOf(db, params?.documents ?? []),
  ]);
  return { ticket, orderNumber, mandates, documents };
}

// One step-up's card, by its ID.
export async function buildCard(
  db: Database,
  stepUp: StepUp,
  mandates: readonly Mandate[],
): Promise<Card> {
  return cardView(stepUp, await contextOf(db, stepUp, mandates));
}

async function executionOf(db: Database, intentId: string): Promise<CardExecution> {
  const read = await readIntentRecord(db, intentId);
  if (!read.known) return { outcome: "unknown", refund: null, invoice: null, dispute: null };
  const { trail } = read;
  if (trail === null) return { outcome: "pending", refund: null, invoice: null, dispute: null };
  const { executed } = trail;
  return {
    outcome: executed !== null ? "executed" : (trail.lastOutcome ?? "pending"),
    refund: executed?.refund ? { id: executed.refund.id, status: executed.refund.status } : null,
    invoice: executed?.invoice
      ? { id: executed.invoice.id, status: executed.invoice.status }
      : null,
    dispute: executed?.dispute
      ? { id: executed.dispute.id, status: executed.dispute.status }
      : null,
  };
}

async function summaryOf(db: Database, stepUp: StepUp): Promise<RecentSummary> {
  const { intent, answer } = stepUp;
  const outcome = answer === null ? "expired" : answer.outcome;
  return {
    step_up_id: stepUp.seq,
    intent_id: stepUp.intentId,
    action: intent.action,
    action_words: ACTION_WORDS[intent.action],
    amount: amountOf(intent.amount),
    order_number: await orderNumberOf(db, intent.target),
    outcome,
    at: answer === null ? stepUp.expiresAt : answer.at,
    channel: answer === null ? null : answer.channel,
    execution: outcome === "approved" ? await executionOf(db, stepUp.intentId) : null,
  };
}

export type ApprovalsView = { open: Card[]; recent: RecentSummary[] };

export type ApprovalsRead =
  | { known: true; view: ApprovalsView }
  | { known: false; seq: number; detail: string };

// The open cards and the recent answers at `now`. An unreadable step-up entry makes it unknown.
export async function readApprovals(
  db: Database,
  now: Date,
  mandates: readonly Mandate[],
): Promise<ApprovalsRead> {
  const read = await readStepUps(db, now);
  if (!read.known) return read;
  const open = await Promise.all(read.open.map((stepUp) => buildCard(db, stepUp, mandates)));
  const recent = await Promise.all(read.recent.map((stepUp) => summaryOf(db, stepUp)));
  return { known: true, view: { open, recent } };
}
