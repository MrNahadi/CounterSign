// Reason codes: why a decision came out as it did. Codes never change once used.

import { z } from "zod";

export type ReasonText = {
  // Words for the merchant.
  words: string;
  // What the agent can safely tell the customer. Null for codes that only step up.
  hint: string | null;
};

export const REASONS = {
  TICKET_NOT_FROM_PAYER: {
    words: "The ticket didn't come from the person who paid.",
    hint: "Refunds go only to the customer who placed the order. Ask them to write from the email address they paid with.",
  },
  PAYER_UNKNOWN: {
    words: "There's no payer email to check the sender against.",
    hint: "We can't match this request to the order's payer. Ask them to write from the email address they paid with.",
  },
  CAPTURE_NOT_REFUNDABLE: {
    words: "The payment can't be refunded for this amount.",
    hint: "This order can't be refunded for that amount. Offer to check the order details with them.",
  },
  CAPTURE_UNKNOWN: {
    words: "There's no payment record for this refund.",
    hint: "We couldn't find the payment for this order. Ask them to confirm the order number.",
  },
  DISPUTE_OPEN: {
    words: "The payment has an open PayPal dispute.",
    hint: "This order has an open PayPal case, and it will be resolved there.",
  },
  DISPUTES_UNKNOWN: {
    words: "Countersign couldn't check for open disputes.",
    hint: "We need to check this order before refunding. Tell them we'll follow up.",
  },
  SHIPMENT_STATUS_UNKNOWN: {
    words: "There's no carrier record for this order.",
    hint: "We couldn't find tracking for this order. Tell them we'll check with the carrier.",
  },
  NO_PHOTO_EVIDENCE: {
    words: "The damage claim has no photo.",
    hint: "Ask them for a photo of the damage.",
  },
  TICKET_UNKNOWN: {
    words: "There's no ticket record for this claim.",
    hint: "We need the original message to look into this. Ask them to write in again.",
  },
  DUPLICATE_REFUND: {
    words: "This payment was already refunded once.",
    hint: "This order has already been refunded.",
  },
  HISTORY_UNKNOWN: {
    words: "Countersign couldn't check earlier refunds.",
    hint: "We need to check this order before refunding. Tell them we'll follow up.",
  },
  VERIFIER_UNAVAILABLE: {
    words: "Countersign can't check this yet.",
    hint: "We need to check this request before acting on it. Tell them we'll follow up.",
  },
  ABOVE_AUTO_LIMIT: { words: "It's over your auto-refund cap.", hint: null },
  DAILY_LIMIT_REACHED: { words: "It would pass your daily refund limit.", hint: null },
  DAILY_LIMIT_UNKNOWN: { words: "Countersign couldn't count today's refunds.", hint: null },
  NO_DAILY_LIMIT: { words: "Your rules set no daily limit for this currency.", hint: null },
  SHIPMENT_DELIVERED: {
    words: "The carrier shows the parcel delivered.",
    hint: "Our carrier shows this order as delivered. Suggest they check with neighbours or their building's front desk.",
  },
  ALWAYS_NEEDS_APPROVAL: { words: "Your rules always ask you first for this.", hint: null },
  RULE_DENIES: {
    words: "Your rules don't allow this.",
    hint: "We can't do that for this order.",
  },
  NO_MATCHING_RULE: {
    words: "No rule in your mandate allows this.",
    hint: "We can't do that automatically. Tell them the team will look at it.",
  },
  UNKNOWN_ACTION: {
    words: "Countersign doesn't know this action.",
    hint: "We can't do that. Tell them the team will look at it.",
  },
  WRONG_MANDATE: {
    words: "This agent isn't covered by this mandate.",
    hint: "We can't do that. Tell them the team will look at it.",
  },
  INVALID_PROPOSAL: {
    words: "The proposal was incomplete or malformed.",
    hint: "We need a few more details. Ask them to confirm the order number and amount.",
  },
} as const satisfies Record<string, ReasonText>;

export type ReasonCode = keyof typeof REASONS;
export const REASON_CODES = Object.keys(REASONS) as readonly ReasonCode[];

export const ReasonCodeSchema = z.custom<ReasonCode>(
  (value) => typeof value === "string" && Object.hasOwn(REASONS, value),
  "Must be a known reason code",
);

// The only codes a mandate rule may name as its reason.
export const RULE_REASON_CODES = [
  "SHIPMENT_DELIVERED",
  "ALWAYS_NEEDS_APPROVAL",
  "RULE_DENIES",
] as const satisfies readonly ReasonCode[];
export type RuleReasonCode = (typeof RULE_REASON_CODES)[number];
