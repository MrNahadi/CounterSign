import type { Money } from "@countersign/mandate";
import { z } from "zod";
import { type PayPalConfig, PayPalConfigError, parsePayPalEnv } from "./config";
import { PayPalError } from "./errors";
import {
  captureRecordSchema,
  errorBodySchema,
  fieldPath,
  orderSchema,
  type PayPalCapture,
  type PayPalOrder,
  type PayPalRefund,
  refundSchema,
  tokenSchema,
  toPayPalAmount,
} from "./records";

// The only code that calls PayPal REST (ADR 0024). Sandbox only, one cached OAuth token per
// client, retries only where a repeat can't act twice, and zod-checked records out.

export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string },
) => Promise<Response>;

export type PayPalClientOptions = {
  env: Readonly<Record<string, string | undefined>>;
  fetch?: FetchLike;
  // Waits between retries. Tests inject one that returns at once.
  sleep?: (ms: number) => Promise<void>;
  // Milliseconds since the epoch, for token expiry and Retry-After dates.
  now?: () => number;
};

// Every POST carries the caller's PayPal-Request-Id, so a repeat replays PayPal's first answer
// instead of acting twice. Seed and storefront IDs read `countersign-<area>-<id>-<step>`.
export type PostOptions = { requestId: string };

export type OrderItem = {
  name: string;
  sku?: string;
  quantity: number;
  // Only USD is sent to PayPal.
  unitAmount: Money;
};

export type CreateOrderInput = PostOptions & {
  referenceId: string;
  customId: string;
  invoiceId: string;
  items: OrderItem[];
  // A vault payment token: PayPal creates and captures the order in one call. Without one,
  // the order waits for the buyer's approval.
  vaultId?: string;
};

export type AddTrackerInput = PostOptions & {
  captureId: string;
  trackingNumber: string;
  // Sent as carrier OTHER with this name.
  carrierName: string;
};

export type RefundCaptureInput = PostOptions & {
  captureId: string;
  // Only USD is sent to PayPal.
  amount: Money;
  // Set to the intent ID, so the refund can be found from PayPal's side.
  customId: string;
};

export type PayPalClient = {
  createOrder(input: CreateOrderInput): Promise<PayPalOrder>;
  captureOrder(orderId: string, options: PostOptions): Promise<PayPalOrder>;
  getOrder(orderId: string): Promise<PayPalOrder>;
  // Answers with the order, carrying its trackers.
  addTracker(orderId: string, tracker: AddTrackerInput): Promise<PayPalOrder>;
  getCapture(captureId: string): Promise<PayPalCapture>;
  // A replayed request ID answers with the first refund, not a second one.
  refundCapture(input: RefundCaptureInput): Promise<PayPalRefund>;
  getRefund(refundId: string): Promise<PayPalRefund>;
};

// A token with less than this left is replaced before the next call.
const TOKEN_MARGIN_MS = 5 * 60_000;
const MAX_RETRIES = 2;
const MAX_RETRY_WAIT_MS = 10_000;
const BACKOFF_MS = 250;

const resourceId = z.string().regex(/^[A-Za-z0-9-]{1,64}$/);
// PayPal accepts request IDs of up to 108 characters.
const requestIdSchema = z.string().min(1).max(108);
const postOptionsSchema = z.object({ requestId: requestIdSchema });

const createOrderSchema = z.object({
  requestId: requestIdSchema,
  referenceId: z.string().min(1).max(256),
  customId: z.string().min(1).max(127),
  invoiceId: z.string().min(1).max(127),
  items: z
    .array(
      z.object({
        name: z.string().min(1).max(127),
        sku: z.string().min(1).max(127).optional(),
        quantity: z.number().int().min(1).max(1000),
        unitAmount: z.object({ minor: z.number().int().positive(), currency: z.string() }),
      }),
    )
    .min(1)
    .max(100),
  vaultId: z.string().min(1).max(255).optional(),
});

const addTrackerSchema = z.object({
  requestId: requestIdSchema,
  captureId: resourceId,
  trackingNumber: resourceId,
  carrierName: z.string().min(1).max(64),
});

const refundCaptureSchema = z.object({
  requestId: requestIdSchema,
  captureId: resourceId,
  amount: z.object({ minor: z.number().int().positive(), currency: z.string() }),
  customId: z.string().min(1).max(127),
});

type CallSpec = {
  call: string;
  method: "GET" | "POST";
  path: string;
  body?: unknown;
  // POSTs that carry a PayPal-Request-Id replay rather than repeat, so they may be retried.
  requestId?: string;
};

type Answer = { status: number; body: unknown; debugId: string | null };

export function createPayPalClient(options: PayPalClientOptions): PayPalClient {
  const parsed = parsePayPalEnv(options.env);
  if (!parsed.ok) throw new PayPalConfigError(parsed.missing, parsed.problems);
  const config: PayPalConfig = parsed.config;
  const fetchFn: FetchLike = options.fetch ?? ((url, init) => globalThis.fetch(url, init));
  const sleep = options.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = options.now ?? (() => Date.now());
  const basic = Buffer.from(`${config.clientId}:${config.clientSecret}`).toString("base64");

  // Every credential this client has held, so nothing PayPal echoes back can carry one out.
  const credentials = new Set([config.clientSecret, basic]);
  const scrub = (value: string | undefined): string | null => {
    if (!value) return null;
    let clean = value;
    for (const credential of credentials) clean = clean.split(credential).join("[redacted]");
    return clean;
  };

  let cached: { token: string; expiresAt: number } | undefined;
  let pending: Promise<string> | undefined;

  async function fetchToken(): Promise<string> {
    const call = "oauth-token";
    const response = await reach(call, `${config.baseUrl}/v1/oauth2/token`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${basic}`,
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: "grant_type=client_credentials",
    });
    const answer = await read(call, response);
    if (answer.status !== 200) throw httpError(call, answer);
    const token = tokenSchema.safeParse(answer.body);
    if (!token.success) throw unreadable(call, answer, token.error);
    credentials.add(token.data.access_token);
    cached = { token: token.data.access_token, expiresAt: now() + token.data.expires_in * 1000 };
    return token.data.access_token;
  }

  // Concurrent callers share one token request.
  function accessToken(): Promise<string> {
    if (cached && cached.expiresAt - now() >= TOKEN_MARGIN_MS) return Promise.resolve(cached.token);
    pending ??= fetchToken().finally(() => {
      pending = undefined;
    });
    return pending;
  }

  // After a 401: drop the token that failed, unless another call already replaced it.
  function replaceToken(failed: string): Promise<string> {
    if (cached?.token === failed) cached = undefined;
    return accessToken();
  }

  async function reach(
    call: string,
    url: string,
    init: Parameters<FetchLike>[1],
  ): Promise<Response> {
    try {
      return await fetchFn(url, init);
    } catch (error) {
      const reason = error instanceof Error ? error.name : "the request failed";
      throw new PayPalError({
        kind: "network",
        call,
        status: null,
        reason: scrub(reason) ?? undefined,
      });
    }
  }

  async function read(call: string, response: Response): Promise<Answer> {
    const debugId = response.headers.get("paypal-debug-id");
    const raw = await response.text();
    if (raw.trim() === "") return { status: response.status, body: undefined, debugId };
    try {
      return { status: response.status, body: JSON.parse(raw), debugId };
    } catch {
      if (response.ok) {
        throw new PayPalError({
          kind: "invalid_response",
          call,
          status: response.status,
          debugId,
          reason: "it isn't JSON",
        });
      }
      return { status: response.status, body: undefined, debugId };
    }
  }

  function httpError(call: string, answer: Answer): PayPalError {
    const parsedBody = errorBodySchema.safeParse(answer.body ?? {});
    const body = parsedBody.success ? parsedBody.data : {};
    return new PayPalError({
      kind: "http",
      call,
      status: answer.status,
      paypalName: scrub(body.name ?? body.error),
      paypalMessage: scrub(body.message ?? body.error_description),
      debugId: scrub(body.debug_id) ?? scrub(answer.debugId ?? undefined),
      issues: (body.details ?? []).flatMap((detail) =>
        detail.issue ? [scrub(detail.issue) ?? ""] : [],
      ),
    });
  }

  function unreadable(call: string, answer: Answer, error: z.ZodError): PayPalError {
    const [issue] = error.issues;
    return new PayPalError({
      kind: "invalid_response",
      call,
      status: answer.status,
      debugId: answer.debugId,
      field: issue && issue.path.length > 0 ? fieldPath(issue.path) : "body",
    });
  }

  function retryWait(response: Response, retry: number): number {
    const header = response.headers.get("retry-after")?.trim();
    let wait = BACKOFF_MS * 2 ** retry;
    if (header && /^\d+$/.test(header)) wait = Number(header) * 1000;
    else if (header && !Number.isNaN(Date.parse(header)))
      wait = Math.max(0, Date.parse(header) - now());
    return Math.min(wait, MAX_RETRY_WAIT_MS);
  }

  async function send(spec: CallSpec): Promise<Answer> {
    const retryable = spec.method === "GET" || spec.requestId !== undefined;
    let token = await accessToken();
    let reauthorized = false;
    let retries = 0;
    for (;;) {
      const headers: Record<string, string> = {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
      };
      if (spec.method === "POST") {
        headers["Content-Type"] = "application/json";
        headers.Prefer = "return=representation";
        if (spec.requestId !== undefined) headers["PayPal-Request-Id"] = spec.requestId;
      }
      const response = await reach(spec.call, `${config.baseUrl}${spec.path}`, {
        method: spec.method,
        headers,
        body: spec.body === undefined ? undefined : JSON.stringify(spec.body),
      });
      if (response.status === 401 && !reauthorized) {
        reauthorized = true;
        await response.body?.cancel();
        token = await replaceToken(token);
        continue;
      }
      if (
        retryable &&
        (response.status === 429 || response.status >= 500) &&
        retries < MAX_RETRIES
      ) {
        const wait = retryWait(response, retries);
        retries += 1;
        await response.body?.cancel();
        await sleep(wait);
        continue;
      }
      const answer = await read(spec.call, response);
      if (!response.ok) throw httpError(spec.call, answer);
      return answer;
    }
  }

  function parse<T>(call: string, answer: Answer, schema: z.ZodType<T>): T {
    const parsed = schema.safeParse(answer.body);
    if (!parsed.success) throw unreadable(call, answer, parsed.error);
    return parsed.data;
  }

  function refuse(call: string, reason: string): PayPalError {
    return new PayPalError({ kind: "invalid_request", call, status: null, reason });
  }

  function checkId(call: string, id: string): string {
    if (!resourceId.safeParse(id).success) throw refuse(call, "the ID is malformed");
    return encodeURIComponent(id);
  }

  // Validates a caller's input, naming the field that's wrong and never its value.
  function checkInput<T>(call: string, schema: z.ZodType<T>, input: unknown): T {
    const parsed = schema.safeParse(input);
    if (parsed.success) return parsed.data;
    const [issue] = parsed.error.issues;
    const field = issue && issue.path.length > 0 ? fieldPath(issue.path) : "the request";
    throw refuse(call, `${field} is missing or invalid`);
  }

  return {
    async createOrder(input) {
      const call = "create-order";
      const order = checkInput(call, createOrderSchema, input);
      let total = 0;
      const items = order.items.map((item, index) => {
        if (item.unitAmount.currency !== "USD") throw refuse(call, "only USD is sent to PayPal");
        const unitAmount = toPayPalAmount({ minor: item.unitAmount.minor, currency: "USD" });
        if (!unitAmount) throw refuse(call, `items[${index}].unitAmount is invalid`);
        total += item.unitAmount.minor * item.quantity;
        return {
          name: item.name,
          ...(item.sku === undefined ? {} : { sku: item.sku }),
          quantity: String(item.quantity),
          unit_amount: unitAmount,
        };
      });
      const amount = toPayPalAmount({ minor: total, currency: "USD" });
      if (!amount) throw refuse(call, "the order total is invalid");
      if (order.vaultId !== undefined) credentials.add(order.vaultId);
      const answer = await send({
        call,
        method: "POST",
        path: "/v2/checkout/orders",
        requestId: order.requestId,
        body: {
          intent: "CAPTURE",
          purchase_units: [
            {
              reference_id: order.referenceId,
              custom_id: order.customId,
              invoice_id: order.invoiceId,
              items,
              amount: { ...amount, breakdown: { item_total: amount } },
            },
          ],
          ...(order.vaultId === undefined
            ? {}
            : { payment_source: { paypal: { vault_id: order.vaultId } } }),
        },
      });
      return parse(call, answer, orderSchema);
    },

    async captureOrder(orderId, options) {
      const call = "capture-order";
      const id = checkId(call, orderId);
      const { requestId } = checkInput(call, postOptionsSchema, options);
      const answer = await send({
        call,
        method: "POST",
        path: `/v2/checkout/orders/${id}/capture`,
        requestId,
      });
      return parse(call, answer, orderSchema);
    },

    async addTracker(orderId, input) {
      const call = "add-tracker";
      const id = checkId(call, orderId);
      const tracker = checkInput(call, addTrackerSchema, input);
      const answer = await send({
        call,
        method: "POST",
        path: `/v2/checkout/orders/${id}/track`,
        requestId: tracker.requestId,
        body: {
          capture_id: tracker.captureId,
          tracking_number: tracker.trackingNumber,
          carrier: "OTHER",
          carrier_name_other: tracker.carrierName,
          notify_payer: false,
        },
      });
      return parse(call, answer, orderSchema);
    },

    async getCapture(captureId) {
      const call = "get-capture";
      const id = checkId(call, captureId);
      const answer = await send({ call, method: "GET", path: `/v2/payments/captures/${id}` });
      return parse(call, answer, captureRecordSchema);
    },

    async refundCapture(input) {
      const call = "refund-capture";
      const refund = checkInput(call, refundCaptureSchema, input);
      if (refund.amount.currency !== "USD") throw refuse(call, "only USD is sent to PayPal");
      const amount = toPayPalAmount({ minor: refund.amount.minor, currency: "USD" });
      if (!amount) throw refuse(call, "amount is invalid");
      const answer = await send({
        call,
        method: "POST",
        path: `/v2/payments/captures/${encodeURIComponent(refund.captureId)}/refund`,
        requestId: refund.requestId,
        body: { amount, custom_id: refund.customId },
      });
      return parse(call, answer, refundSchema);
    },

    async getRefund(refundId) {
      const call = "get-refund";
      const id = checkId(call, refundId);
      const answer = await send({ call, method: "GET", path: `/v2/payments/refunds/${id}` });
      return parse(call, answer, refundSchema);
    },

    async getOrder(orderId) {
      const call = "get-order";
      const id = checkId(call, orderId);
      const answer = await send({ call, method: "GET", path: `/v2/checkout/orders/${id}` });
      return parse(call, answer, orderSchema);
    },
  };
}
