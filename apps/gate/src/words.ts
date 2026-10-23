// The words the merchant reads for actions, verifiers and the records they read. Display only:
// nothing in the decision path imports this module.

import type { Action, Decision, VerifierName } from "@countersign/mandate";
import { CALLS } from "@countersign/verifiers";

export const ACTION_WORDS: Record<Action, string> = {
  "paypal.refund": "Refund",
  "paypal.dispute.accept_claim": "Accept dispute claim",
  "paypal.dispute.provide_evidence": "Provide dispute evidence",
  "paypal.dispute.make_offer": "Make dispute offer",
  "paypal.invoice.send": "Send invoice",
  "paypal.payout": "Send payout",
  "paypal.order.capture": "Capture order",
  "mpesa.b2c": "Send M-Pesa payment",
  "mpesa.reversal": "Reverse M-Pesa payment",
  "order.mark_paid": "Mark order paid",
};

export const VERIFIER_WORDS: Record<VerifierName, string> = {
  "capture.refundable": "Payment can be refunded",
  "ticket.from_payer": "Sender paid for the order",
  "dispute.none_open": "No open PayPal dispute",
  "shipment.status": "Carrier status",
  "evidence.photo_present": "Photo of the damage",
  "payee.allowlisted": "Payee is on your list",
  "ledger.not_duplicate": "Not refunded before",
  "ledger.velocity": "Within your usual pace",
  "mpesa.receipt_verified": "M-Pesa receipt confirmed",
  "mpesa.amount_matches_order": "Receipt amount matches the order",
  "mpesa.overpayment_covers_refund": "Overpayment covers the refund",
  "mpesa.recipient_is_payer": "Recipient paid the receipt",
  "mpesa.receipt_unused": "Receipt not used before",
};

const SOURCE_WORDS: Record<string, string> = {
  [CALLS.capture]: "PayPal capture",
  [CALLS.order]: "PayPal order",
  [CALLS.disputes]: "PayPal disputes",
  [CALLS.dispute]: "PayPal dispute",
  [CALLS.invoice]: "PayPal invoice",
  [CALLS.carrier]: "Carrier (simulated)",
  [CALLS.ticket]: "Ticket store",
  [CALLS.executions]: "Audit log",
};

// A record's source in words, by the call it came from. A call with no words shows as itself.
export function sourceWords(call: string): string {
  return Object.hasOwn(SOURCE_WORDS, call) ? (SOURCE_WORDS[call] ?? call) : call;
}

export const DECISION_WORDS: Record<Decision, string> = {
  allow: "Allowed",
  step_up: "Step-up",
  deny: "Denied",
};

// PayPal's dispute reasons in words. A reason PayPal adds later shows as itself.
const DISPUTE_REASON_WORDS: Record<string, string> = {
  MERCHANDISE_OR_SERVICE_NOT_RECEIVED: "Item not received",
  MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED: "Item not as described",
  UNAUTHORISED: "Payment not authorised",
  CREDIT_NOT_PROCESSED: "Refund not processed",
  DUPLICATE_TRANSACTION: "Charged twice",
  INCORRECT_AMOUNT: "Wrong amount charged",
  PAYMENT_BY_OTHER_MEANS: "Paid another way",
  CANCELED_RECURRING_BILLING: "Cancelled recurring payment",
  PROBLEM_WITH_REMITTANCE: "Problem with the payment",
  OTHER: "Other",
};

/** PayPal's upper snake case code in words: `PROOF_OF_REFUND` reads "Proof of refund". */
export function codeWords(code: string): string {
  const words = code.toLowerCase().split("_").filter(Boolean).join(" ");
  return words.length === 0 ? code : `${words[0]?.toUpperCase()}${words.slice(1)}`;
}

/** A dispute reason in words, by PayPal's reason code. */
export function disputeReasonWords(reason: string): string {
  return Object.hasOwn(DISPUTE_REASON_WORDS, reason)
    ? (DISPUTE_REASON_WORDS[reason] ?? reason)
    : reason;
}
