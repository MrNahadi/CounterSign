import { type Money, parseMoney } from "@countersign/mandate";
import { z } from "zod";

// PayPal's JSON, parsed with zod into the client's own records. Only the fields we use are
// required; everything else PayPal sends is ignored. Money becomes integer minor units.

export type PayPalCapture = {
  id: string;
  status: string;
  amount: Money;
  // The order the capture belongs to. Null when PayPal doesn't say.
  orderId: string | null;
  // When PayPal created the capture, as PayPal's date-time. Only a capture read on its own
  // carries it, and only when PayPal sends it.
  createTime?: string;
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
// `createTime` is PayPal's own `create_time` as text. A read always sets it, to null when PayPal
// gave none; a record built by hand may leave it out, which reads the same. It is only shown,
// never decided on.
export type PayPalRefund = {
  id: string;
  status: PayPalRefundStatus;
  amount: Money;
  captureId: string | null;
  createTime?: string | null;
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

// Money in PayPal's wire format, for showing a record: 4800 USD minor units is "48.00", and
// 450000 KES is "4500.00". Null for an amount that isn't a positive count of minor units.
export function toPayPalDisplayAmount(money: Money): PayPalAmount | null {
  if (!Number.isSafeInteger(money.minor) || money.minor <= 0) return null;
  const whole = Math.trunc(money.minor / 100);
  const cents = String(money.minor % 100).padStart(2, "0");
  const value = `${whole}.${cents}`;
  const back = parseMoney(value, money.currency);
  if (!back.ok || back.money.minor !== money.minor) return null;
  return { currency_code: money.currency, value };
}

// Money in PayPal's wire format, for sending: only USD is sent to PayPal, so anything else, or an
// amount that doesn't read back to the same minor units, is null.
export function toPayPalAmount(money: Money): PayPalAmount | null {
  if (money.currency !== "USD") return null;
  return toPayPalDisplayAmount(money);
}

const captureSchema = z.object({ id: text, status: text, amount: moneySchema });

// A capture read on its own carries its order's ID in supplementary_data.
export const captureRecordSchema = captureSchema
  .extend({
    // Only shown, never decided on, so a malformed one is dropped rather than failing the read.
    create_time: z.string().min(1).max(64).optional().catch(undefined),
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
      ...(capture.create_time ? { createTime: capture.create_time } : {}),
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
    // Only shown, so a malformed one is dropped rather than failing the read.
    create_time: z.string().min(1).max(64).optional().catch(undefined),
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
      createTime: refund.create_time ?? null,
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

// One dispute on a capture. Its status is PayPal's, kept as text: anything but RESOLVED is open.
export type PayPalDispute = { id: string; status: string };

// A capture's disputes. `complete` is false when the list had more pages than were read, so a
// caller can't mistake a partial list for the whole one (ADR 0025).
export type PayPalDisputeList = { disputes: PayPalDispute[]; complete: boolean };

const linkSchema = z.object({ rel: z.string().optional(), href: z.string().optional() });

// One page of `GET /v1/customer/disputes`. PayPal leaves `items` out of an empty page.
export const disputesPageSchema = z
  .object({
    items: z.array(z.object({ dispute_id: text, status: text })).optional(),
    links: z.array(linkSchema).optional(),
  })
  .transform((page) => ({
    disputes: (page.items ?? []).map(
      (item): PayPalDispute => ({ id: item.dispute_id, status: item.status }),
    ),
    next: page.links?.find((link) => link.rel === "next")?.href ?? null,
  }));

// One dispute read by its ID: its reason, life-cycle stage, amount, seller response due date,
// the captures it disputes (the seller-side transaction IDs) and the names of the links PayPal
// offers on it (such as `provide_evidence` or `accept_claim`). PayPal's values are kept as text,
// unknown ones included. A disputed transaction with no seller-side ID names no capture.
export type PayPalDisputeDetail = {
  id: string;
  status: string;
  reason: string;
  lifeCycleStage: string;
  amount: Money;
  // PayPal's date-time, or null when the dispute has none.
  sellerResponseDueDate: string | null;
  captureIds: string[];
  linkNames: string[];
};

export const disputeDetailSchema = z
  .object({
    dispute_id: text,
    status: text,
    reason: text,
    dispute_life_cycle_stage: text,
    dispute_amount: moneySchema,
    seller_response_due_date: z.string().nullable().optional(),
    disputed_transactions: z
      .array(z.object({ seller_transaction_id: z.string().optional() }))
      .optional(),
    links: z.array(linkSchema).optional(),
  })
  .transform(
    (dispute): PayPalDisputeDetail => ({
      id: dispute.dispute_id,
      status: dispute.status,
      reason: dispute.reason,
      lifeCycleStage: dispute.dispute_life_cycle_stage,
      amount: dispute.dispute_amount,
      sellerResponseDueDate: dispute.seller_response_due_date || null,
      captureIds: (dispute.disputed_transactions ?? []).flatMap((transaction) =>
        transaction.seller_transaction_id ? [transaction.seller_transaction_id] : [],
      ),
      linkNames: [
        ...new Set((dispute.links ?? []).flatMap((link) => (link.rel ? [link.rel] : []))),
      ],
    }),
  );

// One invoice: its total, number and every recipient's email, primary recipients first.
export type PayPalInvoice = {
  id: string;
  status: string;
  amount: Money;
  invoiceNumber: string | null;
  recipientEmails: string[];
};

// PayPal documents an additional recipient as an email address object; a bare string is read
// the same way.
const additionalRecipientSchema = z.union([
  z.string(),
  z.object({ email_address: z.string().optional() }),
]);

export const invoiceSchema = z
  .object({
    id: text,
    status: text,
    amount: moneySchema,
    detail: z.object({ invoice_number: z.string().optional() }).optional(),
    primary_recipients: z
      .array(
        z.object({
          billing_info: z.object({ email_address: z.string().optional() }).optional(),
        }),
      )
      .optional(),
    additional_recipients: z.array(additionalRecipientSchema).optional(),
  })
  .transform((invoice): PayPalInvoice => {
    const primary = (invoice.primary_recipients ?? []).map((r) => r.billing_info?.email_address);
    const additional = (invoice.additional_recipients ?? []).map((r) =>
      typeof r === "string" ? r : r.email_address,
    );
    return {
      id: invoice.id,
      status: invoice.status,
      amount: invoice.amount,
      invoiceNumber: invoice.detail?.invoice_number || null,
      recipientEmails: [...primary, ...additional].filter((email): email is string => !!email),
    };
  });

// One transaction from Transaction Search. Its status is PayPal's one-letter code (D, P, S, V).
// The amount is unsigned; a negative amount on PayPal's side (money out) is a debit.
export type PayPalTransaction = {
  id: string;
  status: string;
  amount: Money;
  direction: "credit" | "debit";
  // ISO 8601 in UTC.
  initiatedAt: string;
};

// A page of transactions. `complete` is false when PayPal has more pages than this one.
export type PayPalTransactionPage = { transactions: PayPalTransaction[]; complete: boolean };

const signedMoneySchema = z
  .object({ currency_code: text, value: text })
  .transform((amount, ctx): { money: Money; direction: "credit" | "debit" } => {
    const debit = amount.value.startsWith("-");
    const parsed = parseMoney(debit ? amount.value.slice(1) : amount.value, amount.currency_code);
    if (parsed.ok) return { money: parsed.money, direction: debit ? "debit" : "credit" };
    ctx.addIssue({ code: "custom", message: "Unreadable amount" });
    return z.NEVER;
  });

// PayPal writes "2026-10-12T14:20:01+0000"; the offset gains its colon before parsing.
const paypalTimeSchema = text.transform((time, ctx) => {
  const iso = time.replace(/([+-]\d{2})(\d{2})$/, "$1:$2");
  const parsed = z.iso.datetime({ offset: true }).safeParse(iso);
  const ms = parsed.success ? Date.parse(iso) : Number.NaN;
  if (Number.isNaN(ms)) {
    ctx.addIssue({ code: "custom", message: "Unreadable time" });
    return z.NEVER;
  }
  return new Date(ms).toISOString();
});

export const transactionPageSchema = z
  .object({
    transaction_details: z
      .array(
        z.object({
          transaction_info: z.object({
            transaction_id: text,
            transaction_status: text,
            transaction_amount: signedMoneySchema,
            transaction_initiation_date: paypalTimeSchema,
          }),
        }),
      )
      .optional(),
    page: z.number().int().optional(),
    total_pages: z.number().int().optional(),
    links: z.array(linkSchema).optional(),
  })
  .transform(
    (page): PayPalTransactionPage => ({
      transactions: (page.transaction_details ?? []).map(({ transaction_info: info }) => ({
        id: info.transaction_id,
        status: info.transaction_status,
        amount: info.transaction_amount.money,
        direction: info.transaction_amount.direction,
        initiatedAt: info.transaction_initiation_date,
      })),
      complete:
        (page.total_pages ?? 0) <= (page.page ?? 1) &&
        !page.links?.some((link) => link.rel === "next"),
    }),
  );

// What PayPal says of a webhook's signature. Only SUCCESS is a pass.
export type WebhookVerification = "pass" | "fail";

export const verificationSchema = z
  .object({ verification_status: text })
  .transform(
    (answer): WebhookVerification => (answer.verification_status === "SUCCESS" ? "pass" : "fail"),
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
