import { formatMoney, type Money, parseMoney } from "@countersign/mandate";
import { z } from "zod";

// PayPal's JSON, parsed with zod into the client's own records. Only the fields we use are
// required; everything else PayPal sends is ignored. Money becomes integer minor units.

export type PayPalCapture = {
  id: string;
  status: string;
  amount: Money;
  // The order the capture belongs to. Null when PayPal doesn't say.
  orderId: string | null;
};

// PayPal's record that one capture shipped under a tracking number. Its ID is the capture ID,
// a hyphen and the tracking number (spike S2). Its status is only SHIPPED or CANCELLED.
export type PayPalTracker = {
  id: string;
  captureId: string;
  trackingNumber: string;
  status: string;
};

export type PayPalPurchaseUnit = {
  referenceId: string;
  customId: string | null;
  invoiceId: string | null;
  amount: Money;
  captures: PayPalCapture[];
  trackers: PayPalTracker[];
};

export type PayPalOrder = {
  id: string;
  status: string;
  payerEmail: string | null;
  payerId: string | null;
  purchaseUnits: PayPalPurchaseUnit[];
};

const text = z.string().min(1);

export const moneySchema = z
  .object({ currency_code: text, value: text })
  .transform((amount, ctx): Money => {
    const parsed = parseMoney(amount.value, amount.currency_code);
    if (parsed.ok) return parsed.money;
    ctx.addIssue({ code: "custom", message: "Unreadable amount" });
    return z.NEVER;
  });

export type PayPalAmount = { currency_code: string; value: string };

// Money in PayPal's wire format: 4800 USD minor units is "48.00". Only USD is sent to PayPal,
// so anything else, or an amount that doesn't read back to the same minor units, is null.
export function toPayPalAmount(money: Money): PayPalAmount | null {
  if (money.currency !== "USD" || !Number.isSafeInteger(money.minor) || money.minor <= 0) {
    return null;
  }
  const value = formatMoney(money).replace(/^\$/, "").replaceAll(",", "");
  const back = parseMoney(value, money.currency);
  if (!back.ok || back.money.minor !== money.minor) return null;
  return { currency_code: money.currency, value };
}

const captureSchema = z.object({ id: text, status: text, amount: moneySchema });

// A capture read on its own carries its order's ID in supplementary_data.
export const captureRecordSchema = captureSchema
  .extend({
    supplementary_data: z
      .object({ related_ids: z.object({ order_id: z.string().optional() }).optional() })
      .optional(),
  })
  .transform(
    (capture): PayPalCapture => ({
      id: capture.id,
      status: capture.status,
      amount: capture.amount,
      orderId: capture.supplementary_data?.related_ids?.order_id || null,
    }),
  );

const trackerSchema = z
  .object({ id: text, status: text })
  .transform((tracker, ctx): PayPalTracker => {
    const hyphen = tracker.id.indexOf("-");
    if (hyphen < 1 || hyphen === tracker.id.length - 1) {
      ctx.addIssue({
        code: "custom",
        message: "Tracker ID isn't a capture ID and tracking number",
        path: ["id"],
      });
      return z.NEVER;
    }
    return {
      id: tracker.id,
      captureId: tracker.id.slice(0, hyphen),
      trackingNumber: tracker.id.slice(hyphen + 1),
      status: tracker.status,
    };
  });

const purchaseUnitSchema = z.object({
  reference_id: text,
  custom_id: z.string().optional(),
  invoice_id: z.string().optional(),
  amount: moneySchema,
  payments: z.object({ captures: z.array(captureSchema).optional() }).optional(),
  shipping: z.object({ trackers: z.array(trackerSchema).optional() }).optional(),
});

export const orderSchema = z
  .object({
    id: text,
    status: text,
    payer: z
      .object({ email_address: z.string().optional(), payer_id: z.string().optional() })
      .optional(),
    purchase_units: z.array(purchaseUnitSchema).min(1),
  })
  .transform(
    (order): PayPalOrder => ({
      id: order.id,
      status: order.status,
      payerEmail: order.payer?.email_address || null,
      payerId: order.payer?.payer_id || null,
      purchaseUnits: order.purchase_units.map((unit) => ({
        referenceId: unit.reference_id,
        customId: unit.custom_id || null,
        invoiceId: unit.invoice_id || null,
        amount: unit.amount,
        captures: (unit.payments?.captures ?? []).map((capture) => ({
          ...capture,
          orderId: order.id,
        })),
        trackers: unit.shipping?.trackers ?? [],
      })),
    }),
  );

// The body of a PayPal error. Every field is optional: an unreadable body still yields an error.
export const errorBodySchema = z.object({
  name: z.string().optional(),
  message: z.string().optional(),
  debug_id: z.string().optional(),
  details: z.array(z.object({ issue: z.string().optional() })).optional(),
  // The OAuth endpoint uses its own shape.
  error: z.string().optional(),
  error_description: z.string().optional(),
});

export const tokenSchema = z.object({
  access_token: text,
  expires_in: z.number().int().positive(),
});

// "purchase_units[0].amount" from zod's issue path.
export function fieldPath(path: readonly PropertyKey[]): string {
  return path
    .map((key, index) =>
      typeof key === "number" ? `[${key}]` : `${index === 0 ? "" : "."}${String(key)}`,
    )
    .join("");
}
