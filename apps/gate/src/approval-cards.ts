// The approval cards (ADR 0032): what the merchant sees for each step-up, built from the step-up
// reader, the ticket store, the seeded order book and the execution entries. Read-only, no AI,
// and no network. The JSON uses the API's snake_case names.

import {
  type Database,
  readTicket,
  type SeedOrderRow,
  seedOrders,
  sql,
  type Ticket,
} from "@countersign/db";
import {
  type Action,
  formatMoney,
  hashMandate,
  type IntentTarget,
  type Mandate,
  type Money,
  REASONS,
  type VerifierName,
} from "@countersign/mandate";
import { readStepUps, type StepUp, type StepUpState } from "./approval-log";
import { isExecutable } from "./executable";
import { type ExecutionOutcome, readIntentRecord } from "./execution-log";
import { ACTION_WORDS } from "./words";

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
  reasons: { code: string; words: string; detail: string }[];
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
  // The principals' mandates. A step-up's own (by hash) narrows the checks to its matched rules.
  mandates: readonly Mandate[];
};

const amountOf = (money: Money): CardAmount => ({ ...money, display: formatMoney(money) });

function targetOf(target: IntentTarget): CardTarget {
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

function ticketOf(ticket: Ticket): CardTicket {
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

// The verifiers the step-up's matched rules use, or null when its mandate isn't one of the
// principals' (then every check in the trace is shown).
function usedVerifiers(stepUp: StepUp, mandates: readonly Mandate[]): Set<VerifierName> | null {
  const mandate = mandates.find((candidate) => hashMandate(candidate).hash === stepUp.mandate.hash);
  if (mandate === undefined) return null;
  const used = new Set<VerifierName>();
  for (const rule of mandate.rules) {
    if (!stepUp.matchedRules.includes(rule.id)) continue;
    for (const verifier of rule.require ?? []) used.add(verifier);
    if (rule.when?.["shipment.status"]) used.add("shipment.status");
  }
  return used;
}

// One step-up as the merchant's card.
export function cardView(stepUp: StepUp, context: CardContext): Card {
  const { intent } = stepUp;
  const used = usedVerifiers(stepUp, context.mandates);
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
    reasons: stepUp.reasons.map(({ code, detail }) => ({
      code,
      words: REASONS[code].words,
      detail,
    })),
    checks: stepUp.trace
      .filter((entry) => used === null || used.has(entry.verifier))
      .map((entry) => ({
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

async function contextOf(
  db: Database,
  stepUp: StepUp,
  mandates: readonly Mandate[],
): Promise<CardContext> {
  const { ticketId, target } = stepUp.intent;
  const [ticket, orderNumber] = await Promise.all([
    ticketId === null ? null : readTicket(db, ticketId),
    orderNumberOf(db, target),
  ]);
  return { ticket, orderNumber, mandates };
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
  if (!read.known) return { outcome: "unknown", refund: null, invoice: null };
  const { trail } = read;
  if (trail === null) return { outcome: "pending", refund: null, invoice: null };
  const { executed } = trail;
  return {
    outcome: executed !== null ? "executed" : (trail.lastOutcome ?? "pending"),
    refund: executed?.refund ? { id: executed.refund.id, status: executed.refund.status } : null,
    invoice: executed?.invoice
      ? { id: executed.invoice.id, status: executed.invoice.status }
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
