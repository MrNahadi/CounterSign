// The intent: one normalized proposal of a guarded action, and the hash that identifies it.

import { type CanonicalHash, type JsonValue, sha256Canonical } from "./canonical-json";
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

// What an action executes on, one shape per kind of record (ADR 0027). A capture's order ID comes
// only from the capture record and isn't hashed.
export type CaptureTarget = { kind: "capture"; captureId: string; orderId: string | null };
export type DisputeTarget = { kind: "dispute"; disputeId: string };
export type InvoiceTarget = { kind: "invoice"; invoiceId: string };
export type OrderTarget = { kind: "order"; orderId: string };
// The payee's email, compared and hashed lower-cased and trimmed.
export type PayeeTarget = { kind: "payee"; email: string };
export type IntentTarget =
  | CaptureTarget
  | DisputeTarget
  | InvoiceTarget
  | OrderTarget
  | PayeeTarget;

// One piece of dispute evidence, as it executes.
export type EvidenceItem = {
  evidenceType: string;
  notes: string;
  trackingNumbers?: string[] | null;
};

// The parameters that execute alongside the target, for actions other than a refund. Each
// action hashes its own fixed keys (HASHED_PARAMS), with absent values as null.
export type IntentParams = {
  note?: string | null;
  evidence?: EvidenceItem[] | null;
  offerType?: string | null;
  sendToRecipient?: boolean | null;
  additionalRecipients?: string[] | null;
};

export type Intent = {
  principal: string;
  rail: Rail;
  action: Action;
  amount: Money;
  target: IntentTarget;
  // Required for a refund, which normalization enforces; null for other actions without one.
  ticketId: string | null;
  // Absent for a refund, which hashes no parameters.
  params?: IntentParams;
  // Kept with the intent but not hashed (ADRs 0019 and 0020), like the target's order ID.
  claim: Claim | null;
  mandateVersion: number;
};

export type IntentHash = CanonicalHash & { id: string };

// The parameter keys each action hashes. A refund hashes none, and keeps its phase 6 JSON.
export const HASHED_PARAMS = {
  "paypal.refund": null,
  "paypal.dispute.accept_claim": ["note"],
  "paypal.dispute.provide_evidence": ["evidence"],
  "paypal.dispute.make_offer": ["offerType", "note"],
  "paypal.invoice.send": ["note", "sendToRecipient", "additionalRecipients"],
  "paypal.payout": ["note"],
  "paypal.order.capture": [],
  "mpesa.b2c": [],
  "mpesa.reversal": [],
  "order.mark_paid": [],
} as const satisfies Record<Action, readonly (keyof IntentParams)[] | null>;

export function normalizePayeeEmail(email: string): string {
  return email.trim().toLowerCase();
}

// The target as it's hashed: only the ID that executes.
function hashedTarget(target: IntentTarget): JsonValue {
  switch (target.kind) {
    case "capture":
      return { captureId: target.captureId };
    case "dispute":
      return { disputeId: target.disputeId };
    case "invoice":
      return { invoiceId: target.invoiceId };
    case "order":
      return { orderId: target.orderId };
    case "payee":
      return { email: normalizePayeeEmail(target.email) };
  }
}

function hashedParam(params: IntentParams, key: keyof IntentParams): JsonValue {
  if (key === "evidence") {
    return (
      params.evidence?.map((item) => ({
        evidenceType: item.evidenceType,
        notes: item.notes,
        trackingNumbers: item.trackingNumbers ?? null,
      })) ?? null
    );
  }
  return params[key] ?? null;
}

// The target, in words, for traces and CLIs.
export function describeTarget(target: IntentTarget): string {
  switch (target.kind) {
    case "capture":
      return `capture ${target.captureId}`;
    case "dispute":
      return `dispute ${target.disputeId}`;
    case "invoice":
      return `invoice ${target.invoiceId}`;
    case "order":
      return `order ${target.orderId}`;
    case "payee":
      return `payee ${normalizePayeeEmail(target.email)}`;
  }
}

// SHA-256 over the canonical JSON of what executes. A refund executes on the capture alone, so
// the order ID, which only the capture record supplies, isn't hashed. The claim and mandate
// version only explain it, so a changed justification or a new mandate version can't make the
// same refund twice. Other actions also hash the parameters that execute with them (ADR 0027).
export function hashIntent(intent: Intent): IntentHash {
  const executes: { [key: string]: JsonValue } = {
    principal: intent.principal,
    rail: intent.rail,
    action: intent.action,
    amount: intent.amount.minor,
    currency: intent.amount.currency,
    target: hashedTarget(intent.target),
    ticketId: intent.ticketId,
  };
  const keys: readonly (keyof IntentParams)[] | null = HASHED_PARAMS[intent.action];
  if (keys) {
    const params = intent.params ?? {};
    executes.params = Object.fromEntries(keys.map((key) => [key, hashedParam(params, key)]));
  }
  const { hash, canonical } = sha256Canonical(executes);
  return { hash, canonical, id: `int_${hash.slice(0, 24)}` };
}
