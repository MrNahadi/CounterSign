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

export const REFUND_STATUSES = ["COMPLETED", "PENDING", "FAILED", "CANCELLED"] as const;
export type PayPalRefundStatus = (typeof REFUND_STATUSES)[number];

// A refund of one capture (ADR 0025). Its capture ID comes from its `up` link, null when absent.
export type PayPalRefund = {
  id: string;
  status: PayPalRefundStatus;
  amount: Money;
  captureId: string | null;
};

export type PayPalPurchaseUnit = {
  referenceId: string;
  customId: string | null;
  invoiceId: string | null;
  amount: Money;
  captures: PayPalCapture[];
  trackers: PayPalTracker[];
  refunds: PayPalRefund[];
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

// The capture a refund's `up` link names: `.../v2/payments/captures/{id}`.
const CAPTURE_LINK = /\/v2\/payments\/captures\/([A-Za-z0-9-]{1,64})\/?$/;

function captureIdFromLinks(links: { rel?: string; href?: string }[] | undefined): string | null {
  for (const link of links ?? []) {
    if (link.rel !== "up" || !link.href) continue;
    let path: string;
    try {
      path = new URL(link.href).pathname;
    } catch {
      continue;
    }
    const match = CAPTURE_LINK.exec(path);
    if (match?.[1]) return match[1];
  }
  return null;
}

export const refundSchema = z
  .object({
    id: text,
    status: z.enum(REFUND_STATUSES),
    amount: moneySchema,
    links: z
      .array(z.object({ rel: z.string().optional(), href: z.string().optional() }))
      .optional(),
  })
  .transform(
    (refund): PayPalRefund => ({
      id: refund.id,
      status: refund.status,
      amount: refund.amount,
      captureId: captureIdFromLinks(refund.links),
    }),
  );

const purchaseUnitSchema = z.object({
  reference_id: text,
  custom_id: z.string().optional(),
  invoice_id: z.string().optional(),
  amount: moneySchema,
  payments: z
    .object({
      captures: z.array(captureSchema).optional(),
      refunds: z.array(refundSchema).optional(),
    })
    .optional(),
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
        refunds: unit.payments?.refunds ?? [],
      })),
    }),
  );

// Refunds that took or may still take money: PENDING counts, FAILED and CANCELLED don't.
const COUNTED_REFUNDS = new Set<PayPalRefundStatus>(["COMPLETED", "PENDING"]);

// The total already refunded from one of the order's captures, in minor units of the
// capture's currency (ADR 0025). Null when it can't be known: the capture isn't on the order,
// a counted refund is in another currency, or a counted refund with no capture link sits in a
// purchase unit with several captures.
export function refundedTotal(order: PayPalOrder, captureId: string): number | null {
  const unit = order.purchaseUnits.find((u) => u.captures.some((c) => c.id === captureId));
  const capture = unit?.captures.find((c) => c.id === captureId);
  if (!unit || !capture) return null;
  let total = 0;
  for (const refund of unit.refunds) {
    if (!COUNTED_REFUNDS.has(refund.status)) continue;
    if (refund.captureId === null && unit.captures.length > 1) return null;
    if (refund.captureId !== null && refund.captureId !== captureId) continue;
    if (refund.amount.currency !== capture.amount.currency) return null;
    total += refund.amount.minor;
    if (!Number.isSafeInteger(total)) return null;
  }
  return total;
}

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
