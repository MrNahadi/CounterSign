// A failed PayPal call. It carries what PayPal said, and never a token, secret or header.

export type PayPalErrorKind =
  // PayPal answered with an error status.
  | "http"
  // PayPal couldn't be reached.
  | "network"
  // PayPal answered, but the response is missing a field we use or doesn't parse.
  | "invalid_response"
  // We refused the request before calling PayPal.
  | "invalid_request";

export type PayPalErrorDetail = {
  kind: PayPalErrorKind;
  call: string;
  status: number | null;
  paypalName?: string | null;
  paypalMessage?: string | null;
  debugId?: string | null;
  issues?: string[];
  field?: string | null;
  reason?: string;
};

export class PayPalError extends Error {
  override readonly name = "PayPalError";
  readonly kind: PayPalErrorKind;
  readonly call: string;
  readonly status: number | null;
  readonly paypalName: string | null;
  readonly paypalMessage: string | null;
  readonly debugId: string | null;
  readonly issues: string[];
  readonly field: string | null;

  constructor(detail: PayPalErrorDetail) {
    super(describe(detail));
    this.kind = detail.kind;
    this.call = detail.call;
    this.status = detail.status;
    this.paypalName = detail.paypalName ?? null;
    this.paypalMessage = detail.paypalMessage ?? null;
    this.debugId = detail.debugId ?? null;
    this.issues = detail.issues ?? [];
    this.field = detail.field ?? null;
  }
}

// PayPal's refusal of a reused `sender_batch_id` (ADR 0039). Its name isn't documented, so a
// 4xx counts when its name or any issue mentions a duplicate or the batch ID, in any case: the
// sandbox writes "Batch with given sender_batch_id already exists".
const DUPLICATE_BATCH = /DUPLICATE|SENDER_BATCH_ID/i;

export function isDuplicateBatch(error: unknown): boolean {
  if (!(error instanceof PayPalError) || error.kind !== "http") return false;
  if (error.status === null || error.status < 400 || error.status >= 500) return false;
  return [error.paypalName ?? "", ...error.issues].some((text) => DUPLICATE_BATCH.test(text));
}

function describe(detail: PayPalErrorDetail): string {
  const debug = detail.debugId ? ` Debug ID ${detail.debugId}.` : "";
  switch (detail.kind) {
    case "http": {
      const name = detail.paypalName ? ` ${detail.paypalName}` : "";
      const message = detail.paypalMessage ? `: ${detail.paypalMessage.replace(/\.+$/, "")}` : "";
      const issues = detail.issues?.length ? ` Issues: ${detail.issues.join(", ")}.` : "";
      return `${detail.call} failed with HTTP ${detail.status}${name}${message}.${issues}${debug}`;
    }
    case "invalid_response":
      return detail.field
        ? `${detail.call} returned a response we can't read: ${detail.field} is missing or invalid.${debug}`
        : `${detail.call} returned a response we can't read: ${detail.reason ?? "it isn't JSON"}.${debug}`;
    case "network":
      return `${detail.call} couldn't reach PayPal: ${detail.reason ?? "the request failed"}.`;
    case "invalid_request":
      return `${detail.call} was refused before calling PayPal: ${detail.reason ?? "the request is invalid"}.`;
  }
}
