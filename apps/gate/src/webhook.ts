// The PayPal webhook (ADR 0025, ADR 0026). A verified PAYMENT.CAPTURE.REFUNDED event is
// reconciled in the audit log, once per event ID, from the refund as re-read from PayPal, never
// from the event body. No AI. Nothing here logs or answers with the body, a header or a secret.

import type { Database } from "@countersign/db";
import { withAuditLog } from "@countersign/ledger";
import { IdSchema } from "@countersign/mandate";
import {
  type PayPalClient,
  PayPalError,
  type PayPalRefund,
  parsePayPalWebhookId,
} from "@countersign/rail-paypal";
import { z } from "zod";
import { readReconciliationState, reconciliationEntry } from "./execution-log";

export const WEBHOOK_BODY_LIMIT = "64kb";
export const REFUNDED_EVENT = "PAYMENT.CAPTURE.REFUNDED";

export type WebhookAnswer = { status: 200 | 400 | 413 | 503; message: string };

// Short fixed answers. Nothing from the request or from PayPal goes into one.
export const ANSWERS = {
  reconciled: { status: 200, message: "Reconciled." },
  duplicate: { status: 200, message: "Already reconciled." },
  ignored: { status: 200, message: "Event type not handled." },
  badRequest: { status: 400, message: "Bad request." },
  badSignature: { status: 400, message: "Signature not verified." },
  tooLarge: { status: 413, message: "Body too large." },
  unavailable: { status: 503, message: "Try again later." },
} as const satisfies Record<string, WebhookAnswer>;

const Header = z.string().min(1).max(2048);
const TransmissionHeadersSchema = z.object({
  "paypal-transmission-id": Header,
  "paypal-transmission-time": Header,
  "paypal-cert-url": z.url({ protocol: /^https$/ }).max(2048),
  "paypal-auth-algo": Header,
  "paypal-transmission-sig": Header,
});

// Only the fields the gate uses. The refund itself is always re-read.
const EventSchema = z.object({
  id: IdSchema,
  event_type: IdSchema,
  resource: z.unknown().optional(),
});
const RefundResourceSchema = z.object({ id: IdSchema });

export type WebhookDeps = {
  db?: Database;
  // Throws when the rail client can't be built, such as with PayPal's variables missing.
  rail?: () => PayPalClient;
  env: Readonly<Record<string, string | undefined>>;
  // The time a reconciliation is logged at. Not part of any decision.
  clock: () => Date;
};

export type WebhookRequest = {
  headers: Readonly<Record<string, string | string[] | undefined>>;
  // The body exactly as it arrived, or undefined when there was none.
  body: unknown;
};

const strictUtf8 = new TextDecoder("utf-8", { fatal: true });

function rawText(body: unknown): string | null {
  if (!Buffer.isBuffer(body) || body.length === 0) return null;
  try {
    return strictUtf8.decode(body);
  } catch {
    return null;
  }
}

function eventOf(rawBody: string) {
  let value: unknown;
  try {
    value = JSON.parse(rawBody);
  } catch {
    return null;
  }
  const parsed = EventSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export async function handlePayPalWebhook(
  request: WebhookRequest,
  deps: WebhookDeps,
): Promise<WebhookAnswer> {
  // 1. The transmission headers and the raw body.
  const headers = TransmissionHeadersSchema.safeParse(request.headers);
  const rawBody = rawText(request.body);
  if (!headers.success || rawBody === null) return ANSWERS.badRequest;

  // 2. The signature, over the exact raw body.
  const webhookId = parsePayPalWebhookId(deps.env);
  if (!webhookId.ok || !deps.rail || !deps.db) return ANSWERS.unavailable;
  const { db } = deps;
  let rail: PayPalClient;
  try {
    rail = deps.rail();
  } catch {
    return ANSWERS.unavailable;
  }
  const h = headers.data;
  let verification: "pass" | "fail";
  try {
    verification = await rail.verifyWebhookSignature({
      webhookId: webhookId.webhookId,
      transmission: {
        transmissionId: h["paypal-transmission-id"],
        transmissionTime: h["paypal-transmission-time"],
        certUrl: h["paypal-cert-url"],
        authAlgo: h["paypal-auth-algo"],
        transmissionSig: h["paypal-transmission-sig"],
      },
      rawBody,
    });
  } catch (error) {
    // A body the client refuses to send is the sender's fault; anything else can be retried.
    if (error instanceof PayPalError && error.kind === "invalid_request") {
      return ANSWERS.badRequest;
    }
    return ANSWERS.unavailable;
  }
  if (verification !== "pass") return ANSWERS.badSignature;

  // 3. The event.
  const event = eventOf(rawBody);
  if (event === null) return ANSWERS.badRequest;
  if (event.event_type !== REFUNDED_EVENT) return ANSWERS.ignored;
  const resource = RefundResourceSchema.safeParse(event.resource);
  if (!resource.success) return ANSWERS.badRequest;

  try {
    // 4. A redelivered event writes nothing. Checked again under the lock below.
    const before = await readReconciliationState(db);
    if (!before.known) return ANSWERS.unavailable;
    if (before.state.events.has(event.id)) return ANSWERS.duplicate;

    // 5. The refund as PayPal has it now, read outside the ledger's lock.
    let refund: PayPalRefund;
    try {
      refund = await rail.getRefund(resource.data.id);
    } catch {
      return ANSWERS.unavailable;
    }

    return await withAuditLog(db, async (log) => {
      const read = await readReconciliationState(log.tx);
      if (!read.known) return ANSWERS.unavailable;
      if (read.state.events.has(event.id)) return ANSWERS.duplicate;
      const matched = read.state.results.get(refund.id) ?? null;
      await log.append(
        reconciliationEntry({
          at: deps.clock().toISOString(),
          intentId: matched?.intentId ?? null,
          source: "webhook",
          event: { id: event.id, type: event.event_type },
          refund: {
            id: refund.id,
            captureId: refund.captureId,
            status: refund.status,
            amount: refund.amount,
          },
          resultSeq: matched?.seq ?? null,
        }),
      );
      return ANSWERS.reconciled;
    });
  } catch {
    // The log couldn't be read or written, or the refund can't be recorded as it is.
    return ANSWERS.unavailable;
  }
}
