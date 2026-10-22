// The words the merchant reads for actions, verifiers and the records they read. Display only:
// nothing in the decision path imports this module.

import type { Action, VerifierName } from "@countersign/mandate";
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
