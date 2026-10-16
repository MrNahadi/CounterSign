// The intent: one normalized proposal of a guarded action, and the hash that identifies it.

import { sha256Canonical } from "./canonical-json";
import type { Money } from "./money";

export const RAILS = ["paypal", "mpesa"] as const;
export type Rail = (typeof RAILS)[number];

// Guarded actions (original brief §9). Anything else is an unknown action.
export const ACTIONS = [
  "paypal.refund",
  "paypal.dispute.accept_claim",
  "paypal.dispute.provide_evidence",
  "paypal.dispute.make_offer",
  "paypal.invoice.send",
  "paypal.payout",
  "paypal.order.capture",
  "mpesa.b2c",
  "mpesa.reversal",
  "order.mark_paid",
] as const;
export type Action = (typeof ACTIONS)[number];

// What a customer asserts about an order. A claim selects a rule but never proves anything.
export const CLAIMS = ["not_received", "damaged", "wrong_item"] as const;
export type Claim = (typeof CLAIMS)[number];

export type IntentTarget = { captureId: string; orderId: string | null };

export type Intent = {
  principal: string;
  rail: Rail;
  action: Action;
  amount: Money;
  target: IntentTarget;
  ticketId: string;
  // Kept with the intent but not hashed (ADR 0019).
  claim: Claim | null;
  mandateVersion: number;
};

export type IntentHash = { hash: string; id: string };

// SHA-256 over the canonical JSON of what executes. The claim and mandate version only explain
// it, so a changed justification or a new mandate version can't make the same refund twice.
export function hashIntent(intent: Intent): IntentHash {
  const executes = {
    principal: intent.principal,
    rail: intent.rail,
    action: intent.action,
    amount: intent.amount.minor,
    currency: intent.amount.currency,
    target: { captureId: intent.target.captureId, orderId: intent.target.orderId },
    ticketId: intent.ticketId,
  };
  const hash = sha256Canonical(executes);
  return { hash, id: `int_${hash.slice(0, 24)}` };
}
