// How the product page reads the checkout routes' answers in the browser. Anything it can't read
// is a failure, never a payment.

import { CURRENCIES, formatMoney } from "@countersign/mandate";
import { z } from "zod";

export type CreateOutcome =
  | { ok: true; orderId: string }
  | { ok: false; message: string; debugId: string | null };

export type PaymentResult =
  | { kind: "paid"; orderId: string; captureId: string; amount: string }
  | { kind: "not_paid"; status: string }
  | { kind: "failed"; message: string; debugId: string | null };

const UNREADABLE =
  "We couldn't read the payment result. Check the order in the PayPal sandbox before you try again.";

const FailureSchema = z.object({
  error: z.string().min(1),
  debugId: z.string().nullish(),
});
const CreatedSchema = z.object({ orderId: z.string().min(1) });
const PaidSchema = z.object({
  paid: z.literal(true),
  orderId: z.string().min(1),
  captureId: z.string().min(1),
  amount: z.object({ minor: z.number().int().positive(), currency: z.enum(CURRENCIES) }),
});
const NotPaidSchema = z.object({ paid: z.literal(false), status: z.string().min(1) });

function failure(body: unknown): { message: string; debugId: string | null } {
  const parsed = FailureSchema.safeParse(body);
  return parsed.success
    ? { message: parsed.data.error, debugId: parsed.data.debugId ?? null }
    : { message: UNREADABLE, debugId: null };
}

export function readCreateResponse(status: number, body: unknown): CreateOutcome {
  if (status === 200) {
    const created = CreatedSchema.safeParse(body);
    if (created.success) return { ok: true, orderId: created.data.orderId };
    return { ok: false, message: UNREADABLE, debugId: null };
  }
  return { ok: false, ...failure(body) };
}

export function readCaptureResponse(status: number, body: unknown): PaymentResult {
  if (status !== 200) return { kind: "failed", ...failure(body) };
  const paid = PaidSchema.safeParse(body);
  if (paid.success) {
    const { orderId, captureId, amount } = paid.data;
    return { kind: "paid", orderId, captureId, amount: formatMoney(amount) };
  }
  const notPaid = NotPaidSchema.safeParse(body);
  if (notPaid.success) return { kind: "not_paid", status: notPaid.data.status };
  return { kind: "failed", message: UNREADABLE, debugId: null };
}
