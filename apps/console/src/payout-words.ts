// A payout item's status in words (requirements.md, "The console"), shared by the approvals page
// and the decision pages. A status without words shows as PayPal's code, never hidden. No
// server-only imports, so client components can use it.

const PAYOUT_STATUS_WORDS: Record<string, string> = {
  UNCLAIMED: "Waiting for the payee to claim it",
  SUCCESS: "Paid",
  PENDING: "Pending",
  RETURNED: "Returned to you",
  FAILED: "Failed",
};

/** "Waiting for the payee to claim it" for `UNCLAIMED`; PayPal's code for a status without words. */
export function payoutStatusWords(status: string): string {
  return PAYOUT_STATUS_WORDS[status] ?? status;
}

/** The status words inside a sentence: lower-cased, apart from a PayPal code. */
export function payoutStatusInline(status: string): string {
  const words = PAYOUT_STATUS_WORDS[status];
  return words === undefined ? status : words.charAt(0).toLowerCase() + words.slice(1);
}
