import type {
  Action,
  Claim,
  Mandate,
  Rail,
  Rule,
  RuleReasonCode,
  ShipmentStatus,
  VerifierName,
} from "@countersign/mandate";
import { CURRENCIES, formatMoney } from "@countersign/mandate/money";

// The mandate compiler's read-back (brief §5 item 12, PLAN E1): a compiled mandate in plain
// English, written by this code from the validated rules, never by the model. So what the merchant
// reads is what the gate would enforce, word for word, including what the brief's evaluation
// order does with it (brief "How the mandate is evaluated"): a failed check denies, an amount over
// the cap or a passed daily limit holds an allow, the strictest match wins, and anything no rule
// covers is denied. Client-safe: type imports and the money module only.

export type ReadBackRule = {
  id: string;
  decide: Rule["decide"];
  /** What the rule covers and what it does with it, as one sentence. */
  sentence: string;
  /** The checks that deny it when any fails, as one sentence, or null for none. */
  checks: string | null;
  /** Why a hold or a denial happens, in the gate's own words, or null for an allow. */
  reason: string | null;
};

export type ReadBack = {
  title: string;
  rules: ReadBackRule[];
  limits: string[];
  payees: string[];
  /** What happens to everything the rules don't say. */
  always: string[];
};

const ACTION_PHRASES: Record<Action, string> = {
  "paypal.refund": "PayPal refunds",
  "paypal.dispute.accept_claim": "accepting a PayPal dispute claim",
  "paypal.dispute.provide_evidence": "sending PayPal dispute evidence",
  "paypal.dispute.make_offer": "making a PayPal dispute offer",
  "paypal.invoice.send": "sending a PayPal invoice",
  "paypal.payout": "PayPal payouts",
  "paypal.order.capture": "capturing a PayPal order",
  "mpesa.b2c": "M-Pesa payments to customers",
  "mpesa.reversal": "M-Pesa reversals",
  "order.mark_paid": "marking an order paid",
};

const CLAIM_PHRASES: Record<Claim, string> = {
  not_received: "the customer says the parcel never arrived",
  damaged: "the customer says it arrived damaged",
  wrong_item: "the customer says they got the wrong item",
};

const STATUS_PHRASES: Record<ShipmentStatus, string> = {
  lost: "lost",
  stalled_10d: "stalled for 10 days or more",
  in_transit: "in transit",
  delivered: "delivered",
};

const RAIL_PHRASES: Record<Rail, string> = {
  paypal: "it was paid through PayPal",
  mpesa: "it was paid through M-Pesa",
};

export const CHECK_PHRASES: Record<VerifierName, string> = {
  "ticket.from_payer": "the message comes from the buyer who paid",
  "capture.refundable": "PayPal shows the payment can still be refunded",
  "dispute.none_open": "no PayPal dispute is open on it",
  "shipment.status": "the carrier's status can be read",
  "evidence.photo_present": "there's a photo of the damage",
  "payee.allowlisted": "the payee is on your list",
  "ledger.not_duplicate": "it hasn't been refunded before",
  "ledger.velocity": "it's within your usual pace",
  "mpesa.receipt_verified": "the M-Pesa receipt is confirmed",
  "mpesa.amount_matches_order": "the receipt amount matches the order",
  "mpesa.overpayment_covers_refund": "the overpayment covers the refund",
  "mpesa.recipient_is_payer": "the recipient paid the receipt",
  "mpesa.receipt_unused": "the receipt hasn't been used before",
};

/** The gate's words for the reasons a rule may name (`REASONS` in the mandate package). */
export const RULE_REASON_WORDS: Record<RuleReasonCode, string> = {
  SHIPMENT_DELIVERED: "The carrier shows the parcel delivered.",
  ALWAYS_NEEDS_APPROVAL: "Your rules always ask you first for this.",
  RULE_DENIES: "Your rules don't allow this.",
};

/** "a", "a and b", "a, b and c". */
export function joinWords(items: readonly string[], last = "and"): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} ${last} ${items[items.length - 1]}`;
}

const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

function conditions(rule: Rule): string[] {
  const when = rule.when;
  if (!when) return [];
  const out: string[] = [];
  if (when.claim) out.push(CLAIM_PHRASES[when.claim]);
  const statuses = when["shipment.status"];
  if (statuses) {
    out.push(
      `the carrier shows it ${joinWords(
        statuses.map((status) => STATUS_PHRASES[status]),
        "or",
      )}`,
    );
  }
  if (when.rail) out.push(RAIL_PHRASES[when.rail]);
  return out;
}

function outcome(rule: Rule): string {
  if (rule.decide === "step_up") return "held for your approval";
  if (rule.decide === "deny") return "denied";
  if (!rule.max) return "allowed, at any amount";
  return `allowed up to ${formatMoney({ minor: rule.max.amount, currency: rule.max.currency })} each; above that, held for your approval`;
}

/** One rule in words. */
export function readBackRule(rule: Rule): ReadBackRule {
  const actions = (typeof rule.action === "string" ? [rule.action] : rule.action).map(
    (action) => ACTION_PHRASES[action],
  );
  const when = conditions(rule);
  const covers =
    when.length > 0 ? `${joinWords(actions)} when ${joinWords(when)}` : joinWords(actions);
  const checks = rule.require ?? [];
  return {
    id: rule.id,
    decide: rule.decide,
    sentence: `${capitalize(covers)}: ${outcome(rule)}.`,
    checks:
      checks.length > 0
        ? `Denied unless ${joinWords(checks.map((name) => CHECK_PHRASES[name]))}.`
        : null,
    reason: rule.decide === "allow" ? null : RULE_REASON_WORDS[rule.reason],
  };
}

/** A whole mandate in words, rules in their own order. */
export function readBackMandate(mandate: Mandate): ReadBack {
  const limits = CURRENCIES.map((currency) => {
    const limit = mandate.limits.find((each) => each.currency === currency);
    if (!limit) {
      return `${currency}: no daily limit, so every allowed ${currency} action is held for your approval.`;
    }
    const caps: string[] = [];
    if (limit.per_day_total !== undefined) {
      caps.push(`${formatMoney({ minor: limit.per_day_total, currency })} in total`);
    }
    if (limit.per_day_count !== undefined) {
      caps.push(`${limit.per_day_count} ${limit.per_day_count === 1 ? "action" : "actions"}`);
    }
    return `${currency}: allowed actions stop at ${joinWords(caps)} a day; past that, they're held for your approval.`;
  });
  return {
    title: `${mandate.id}, version ${mandate.version}, for ${mandate.principal}`,
    rules: mandate.rules.map(readBackRule),
    limits,
    payees: (mandate.payees ?? []).map((payee) => `${payee.name} (${payee.email})`),
    always: [
      "When more than one rule fits, the strictest outcome wins.",
      "Anything no rule covers is denied, and so is any action Countersign doesn't know.",
      `Days are counted in the time zone ${mandate.time_zone}.`,
    ],
  };
}
