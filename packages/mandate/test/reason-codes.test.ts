import { describe, expect, it } from "vitest";
import { REASON_CODES, REASONS, RULE_REASON_CODES } from "../src/index";

// Copied from requirements.md, Reason codes. null where the table says "None (step-up only)".
const table: [string, string, string | null][] = [
  [
    "TICKET_NOT_FROM_PAYER",
    "The ticket didn't come from the person who paid.",
    "Refunds go only to the customer who placed the order. Ask them to write from the email address they paid with.",
  ],
  [
    "PAYER_UNKNOWN",
    "There's no payer email to check the sender against.",
    "We can't match this request to the order's payer. Ask them to write from the email address they paid with.",
  ],
  [
    "CAPTURE_NOT_REFUNDABLE",
    "The payment can't be refunded for this amount.",
    "This order can't be refunded for that amount. Offer to check the order details with them.",
  ],
  [
    "CAPTURE_UNKNOWN",
    "There's no payment record for this refund.",
    "We couldn't find the payment for this order. Ask them to confirm the order number.",
  ],
  [
    "DISPUTE_OPEN",
    "The payment has an open PayPal dispute.",
    "This order has an open PayPal case, and it will be resolved there.",
  ],
  [
    "DISPUTES_UNKNOWN",
    "Countersign couldn't check for open disputes.",
    "We need to check this order before refunding. Tell them we'll follow up.",
  ],
  [
    "SHIPMENT_STATUS_UNKNOWN",
    "There's no carrier record for this order.",
    "We couldn't find tracking for this order. Tell them we'll check with the carrier.",
  ],
  ["NO_PHOTO_EVIDENCE", "The damage claim has no photo.", "Ask them for a photo of the damage."],
  [
    "TICKET_UNKNOWN",
    "There's no ticket record for this claim.",
    "We need the original message to look into this. Ask them to write in again.",
  ],
  [
    "DUPLICATE_REFUND",
    "This payment was already refunded once.",
    "This order has already been refunded.",
  ],
  [
    "HISTORY_UNKNOWN",
    "Countersign couldn't check earlier refunds.",
    "We need to check this order before refunding. Tell them we'll follow up.",
  ],
  [
    "VERIFIER_UNAVAILABLE",
    "Countersign can't check this yet.",
    "We need to check this request before acting on it. Tell them we'll follow up.",
  ],
  ["ABOVE_AUTO_LIMIT", "It's over your auto-refund cap.", null],
  ["DAILY_LIMIT_REACHED", "It would pass your daily refund limit.", null],
  ["DAILY_LIMIT_UNKNOWN", "Countersign couldn't count today's refunds.", null],
  [
    "SHIPMENT_DELIVERED",
    "The carrier shows the parcel delivered.",
    "Our carrier shows this order as delivered. Suggest they check with neighbours or their building's front desk.",
  ],
  ["ALWAYS_NEEDS_APPROVAL", "Your rules always ask you first for this.", null],
  ["RULE_DENIES", "Your rules don't allow this.", "We can't do that for this order."],
  [
    "NO_MATCHING_RULE",
    "No rule in your mandate allows this.",
    "We can't do that automatically. Tell them the team will look at it.",
  ],
  [
    "UNKNOWN_ACTION",
    "Countersign doesn't know this action.",
    "We can't do that. Tell them the team will look at it.",
  ],
  [
    "WRONG_MANDATE",
    "This agent isn't covered by this mandate.",
    "We can't do that. Tell them the team will look at it.",
  ],
  [
    "INVALID_PROPOSAL",
    "The proposal was incomplete or malformed.",
    "We need a few more details. Ask them to confirm the order number and amount.",
  ],
];

describe("the reason-code catalog", () => {
  it("holds exactly the codes in requirements.md", () => {
    expect([...REASON_CODES].sort()).toEqual(table.map(([code]) => code).sort());
  });

  it.each(table)("gives %s its words and reply hint", (code, words, hint) => {
    expect(REASONS[code as keyof typeof REASONS]).toEqual({ words, hint });
  });

  it("allows only the three rule reasons in a rule", () => {
    expect([...RULE_REASON_CODES].sort()).toEqual([
      "ALWAYS_NEEDS_APPROVAL",
      "RULE_DENIES",
      "SHIPMENT_DELIVERED",
    ]);
    for (const code of RULE_REASON_CODES) expect(REASON_CODES).toContain(code);
  });
});
