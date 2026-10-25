import { randomBytes } from "node:crypto";
import type { Money } from "@countersign/mandate";
import { z } from "zod";
import {
  type PayPalConfig,
  PayPalConfigError,
  parsePayPalEnv,
  SANDBOX_BASE_URL,
  webhookIdSchema,
} from "./config";
import { PayPalError } from "./errors";
import {
  captureRecordSchema,
  disputeDetailSchema,
  disputesPageSchema,
  errorBodySchema,
  fieldPath,
  invoiceSchema,
  orderSchema,
  type PayPalCapture,
  type PayPalDispute,
  type PayPalDisputeDetail,
  type PayPalDisputeList,
  type PayPalInvoice,
  type PayPalOrder,
  type PayPalPayoutBatch,
  type PayPalPayoutCreated,
  type PayPalPayoutItem,
  type PayPalRefund,
  type PayPalTransactionPage,
  payoutBatchSchema,
  payoutCreatedSchema,
  payoutItemSchema,
  refundSchema,
  tokenSchema,
  toPayPalAmount,
  transactionPageSchema,
  verificationSchema,
  type WebhookVerification,
} from "./records";

// The only code that calls PayPal REST (ADR 0024). Sandbox only, one cached OAuth token per
// client, retries only where a repeat can't act twice, and zod-checked records out.

export type FetchLike = (
  url: string,
  // A multipart body (provide evidence) is sent as bytes; every other body is text.
  init: {
    method: string;
    headers: Record<string, string>;
    body?: string | Uint8Array<ArrayBuffer>;
  },
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

export type SendInvoiceInput = {
  invoiceId: string;
  sendToRecipient: boolean;
  note?: string;
  additionalRecipients?: string[];
};

// What PayPal did with a send: `SENT` for HTTP 200, `SCHEDULED` for HTTP 202.
export type InvoiceSendStatus = "SENT" | "SCHEDULED";

export type DraftInvoiceItem = {
  name: string;
  quantity: number;
  // Only USD is sent to PayPal.
  unitAmount: Money;
};

export type CreateDraftInvoiceInput = PostOptions & {
  recipientEmail: string;
  items: DraftInvoiceItem[];
};

// The five `PAYPAL-*` headers PayPal sends with a webhook.
// One payout to one email (ADR 0039). The gate sets the request ID to the intent hash, the batch
// ID to the intent ID and the item ID to the bill reference.
export type CreatePayoutInput = PostOptions & {
  senderBatchId: string;
  emailSubject: string;
  receiver: string;
  amount: Money;
  note?: string;
  senderItemId: string;
};

export type WebhookTransmission = {
  transmissionId: string;
  transmissionTime: string;
  certUrl: string;
  authAlgo: string;
  transmissionSig: string;
};

export type VerifyWebhookInput = {
  webhookId: string;
  transmission: WebhookTransmission;
  // The event exactly as it arrived. It's spliced into the request unchanged, because
  // re-serializing it would change the bytes PayPal signed (ADR 0025).
  rawBody: string;
};

// A Transaction Search range: ISO 8601 dates or date-times, at most 31 days apart.
export type TransactionSearchInput = {
  startDate: string;
  endDate: string;
  transactionId?: string;
};

// PayPal's dispute states, for filtering the merchant's disputes.
export const DISPUTE_STATES = [
  "REQUIRED_ACTION",
  "REQUIRED_OTHER_PARTY_ACTION",
  "UNDER_PAYPAL_REVIEW",
  "RESOLVED",
  "OPEN_INQUIRIES",
  "APPEALABLE",
] as const;
export type DisputeState = (typeof DISPUTE_STATES)[number];

// One page of the merchant's disputes: at most `pageSize` (1 to 50), optionally in one state.
export type MerchantDisputesInput = { pageSize: number; disputeState?: DisputeState };

// What a dispute action is sent with. Notes and names are checked against PayPal's limits
// before anything is sent.
export type AcceptClaimInput = { disputeId: string; note: string };

export const OFFER_TYPES = [
  "REFUND",
  "REFUND_WITH_RETURN",
  "REFUND_WITH_REPLACEMENT",
  "REPLACEMENT_WITHOUT_REFUND",
] as const;
export type OfferType = (typeof OFFER_TYPES)[number];

export type MakeOfferInput = {
  disputeId: string;
  note: string;
  offerType: OfferType;
  // Only USD is sent to PayPal.
  offerAmount?: Money;
};

export type DisputeTrackingInfo = {
  // PayPal's carrier code, such as OTHER.
  carrierName: string;
  carrierNameOther?: string;
  trackingNumber: string;
};

export type DisputeEvidence = {
  // PayPal's evidence type, such as PROOF_OF_FULFILLMENT.
  evidenceType: string;
  // 1 to 2000 characters.
  notes: string;
  trackingInfo?: DisputeTrackingInfo[];
  refundIds?: string[];
};

// A document sent as one file part: a PDF of at most 1 MB, named as PayPal allows.
export type EvidenceDocument = {
  name: string;
  contentType: "application/pdf";
  bytes: Uint8Array;
};

export type ProvideEvidenceInput = {
  disputeId: string;
  evidences: DisputeEvidence[];
  // At most 5, sent as file1, file2, … in this order.
  documents: EvidenceDocument[];
};

// Sandbox only: asks for the seller's or the buyer's evidence on a dispute under review.
export type RequireEvidenceInput = {
  disputeId: string;
  action: "SELLER_EVIDENCE" | "BUYER_EVIDENCE";
};

// Sandbox only: settles a dispute under review.
export type AdjudicateInput = {
  disputeId: string;
  outcome: "SELLER_FAVOR" | "BUYER_FAVOR";
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
  // Every dispute on the capture, reading up to five pages.
  listDisputes(captureId: string): Promise<PayPalDisputeList>;
  // The first page of the merchant's disputes. `complete` is false when PayPal has more.
  listMerchantDisputes(input: MerchantDisputesInput): Promise<PayPalDisputeList>;
  getDispute(disputeId: string): Promise<PayPalDisputeDetail>;
  // The dispute actions. PayPal documents no request ID for them, so each carries none and is
  // sent once, never retried, not even after a 5xx or a network failure (ADR 0035). Each
  // answers PayPal's HTTP status; an error status throws.
  acceptClaim(input: AcceptClaimInput): Promise<number>;
  makeOffer(input: MakeOfferInput): Promise<number>;
  // Sent as multipart/form-data: an `input` JSON part and one file part per document.
  provideEvidence(input: ProvideEvidenceInput): Promise<number>;
  // Sandbox-only helpers that move a test dispute along (spike S3).
  requireEvidence(input: RequireEvidenceInput): Promise<number>;
  adjudicate(input: AdjudicateInput): Promise<number>;
  getInvoice(invoiceId: string): Promise<PayPalInvoice>;
  // Sends a draft invoice. PayPal's send call takes no request ID, so this carries none and is
  // never retried, not even after a 5xx or a network failure (ADR 0033). A 4xx throws.
  sendInvoice(input: SendInvoiceInput): Promise<InvoiceSendStatus>;
  // Creates a draft invoice and answers with its ID. For live checks and demos.
  createDraftInvoice(input: CreateDraftInvoiceInput): Promise<string>;
  // Creates a batch of one payout. Retried after a 5xx or network failure like any POST with a
  // request ID, since the batch ID makes a repeat a reused-batch refusal rather than pay twice
  // (the sandbox doesn't replay payouts by request ID; see `isDuplicateBatch`).
  createPayout(input: CreatePayoutInput): Promise<PayPalPayoutCreated>;
  getPayoutBatch(batchId: string): Promise<PayPalPayoutBatch>;
  getPayoutItem(itemId: string): Promise<PayPalPayoutItem>;
  // One page of up to 100 transactions in the range.
  searchTransactions(input: TransactionSearchInput): Promise<PayPalTransactionPage>;
  // Never retried. Throws when the check can't complete, so it's never mistaken for a pass.
  verifyWebhookSignature(input: VerifyWebhookInput): Promise<WebhookVerification>;
  // A sandbox token minted by its own OAuth call, never the cached one and never cached itself.
  // For baseline mode's child process only. `expiresAt` is milliseconds since the epoch.
  issueAccessToken(): Promise<{ accessToken: string; expiresAt: number }>;
};

// A token with less than this left is replaced before the next call.
const TOKEN_MARGIN_MS = 5 * 60_000;
const MAX_RETRIES = 2;
const MAX_RETRY_WAIT_MS = 10_000;
const BACKOFF_MS = 250;
const MAX_DISPUTE_PAGES = 5;
const DISPUTES_PATH = "/v1/customer/disputes";
const TRANSACTION_PAGE_SIZE = 100;
const MAX_TRANSACTION_RANGE_MS = 31 * 24 * 60 * 60_000;
// Hosts PayPal's sandbox links name. A next link anywhere else is not followed.
const SANDBOX_LINK_HOSTS = new Set([new URL(SANDBOX_BASE_URL).host, "api.sandbox.paypal.com"]);

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

// A date-time with an offset, or a plain date read as midnight UTC.
const searchDate = z
  .union([z.iso.datetime({ offset: true }), z.iso.date()])
  .transform((value, ctx) => {
    const ms = Date.parse(value);
    if (Number.isNaN(ms)) {
      ctx.addIssue({ code: "custom", message: "Unreadable date" });
      return z.NEVER;
    }
    return ms;
  });

const transactionSearchSchema = z
  .object({ startDate: searchDate, endDate: searchDate, transactionId: resourceId.optional() })
  .superRefine((search, ctx) => {
    const span = search.endDate - search.startDate;
    if (span < 0 || span > MAX_TRANSACTION_RANGE_MS) {
      ctx.addIssue({ code: "custom", message: "Range over 31 days", path: ["endDate"] });
    }
  });

const merchantDisputesSchema = z.object({
  pageSize: z.number().int().min(1).max(50),
  disputeState: z.enum(DISPUTE_STATES).optional(),
});

const emailSchema = z.string().min(3).max(254).includes("@");

// PayPal's dispute notes: 1 to 2000 characters.
const disputeNote = z.string().min(1).max(2000);
const moneyInput = z.object({ minor: z.number().int().positive(), currency: z.string() });
const MAX_DOCUMENTS = 5;
const MAX_DOCUMENT_BYTES = 1024 * 1024;
// PayPal's document name pattern, `^[A-Za-z0-9-_,\s]+[.]{1}[A-Za-z]+$`, with plain spaces only
// for whitespace, so a name can't break the part's headers.
const documentName = z
  .string()
  .max(255)
  .regex(/^[A-Za-z0-9\-_, ]+\.[A-Za-z]+$/);

const acceptClaimSchema = z.object({ disputeId: resourceId, note: disputeNote });

const makeOfferSchema = z.object({
  disputeId: resourceId,
  note: disputeNote,
  offerType: z.enum(OFFER_TYPES),
  offerAmount: moneyInput.optional(),
});

const provideEvidenceSchema = z.object({
  disputeId: resourceId,
  evidences: z
    .array(
      z.object({
        evidenceType: z.string().regex(/^[A-Z_]{1,64}$/),
        notes: disputeNote,
        trackingInfo: z
          .array(
            z.object({
              carrierName: z.string().regex(/^[A-Z0-9_]{1,64}$/),
              carrierNameOther: z.string().min(1).max(64).optional(),
              trackingNumber: resourceId,
            }),
          )
          .min(1)
          .max(100)
          .optional(),
        refundIds: z.array(resourceId).min(1).max(20).optional(),
      }),
    )
    .min(1)
    .max(100),
  documents: z
    .array(
      z.object({
        name: documentName,
        contentType: z.literal("application/pdf"),
        bytes: z
          .instanceof(Uint8Array)
          .refine((bytes) => bytes.byteLength > 0 && bytes.byteLength <= MAX_DOCUMENT_BYTES, {
            message: "Must be 1 byte to 1 MB",
          }),
      }),
    )
    .max(MAX_DOCUMENTS),
});

const requireEvidenceSchema = z.object({
  disputeId: resourceId,
  action: z.enum(["SELLER_EVIDENCE", "BUYER_EVIDENCE"]),
});

const adjudicateSchema = z.object({
  disputeId: resourceId,
  outcome: z.enum(["SELLER_FAVOR", "BUYER_FAVOR"]),
});

const sendInvoiceSchema = z.object({
  invoiceId: resourceId,
  sendToRecipient: z.boolean(),
  note: z.string().min(1).max(4000).optional(),
  additionalRecipients: z.array(emailSchema).min(1).max(100).optional(),
});

const createDraftInvoiceSchema = z.object({
  requestId: requestIdSchema,
  recipientEmail: emailSchema,
  items: z
    .array(
      z.object({
        name: z.string().min(1).max(200),
        quantity: z.number().int().min(1).max(1000),
        unitAmount: z.object({ minor: z.number().int().positive(), currency: z.string() }),
      }),
    )
    .min(1)
    .max(100),
});

// PayPal answers a new draft with its link, or with the invoice itself.
const draftInvoiceAnswerSchema = z.union([
  z.object({ id: resourceId }).transform((answer) => answer.id),
  z
    .object({ href: z.string() })
    .transform((answer) => answer.href.split("?")[0]?.split("/").pop() ?? "")
    .pipe(resourceId),
]);

// A payout's `sender_item_id` is the bill reference: PayPal holds 63 characters (ADR 0039).
const createPayoutSchema = z.object({
  requestId: requestIdSchema,
  senderBatchId: z.string().min(1).max(256),
  emailSubject: z.string().min(1).max(255),
  receiver: z.email(),
  amount: moneyInput,
  note: z.string().min(1).max(4000).optional(),
  senderItemId: z
    .string()
    .max(63)
    .regex(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/),
});

const header = z.string().min(1).max(4096);
const verifyWebhookSchema = z.object({
  webhookId: webhookIdSchema,
  transmission: z.object({
    transmissionId: header,
    transmissionTime: header,
    certUrl: header,
    authAlgo: header,
    transmissionSig: header,
  }),
  rawBody: z.string(),
});

type CallSpec = {
  call: string;
  method: "GET" | "POST";
  path: string;
  body?: unknown;
  // A body already serialized, sent as it is.
  rawBody?: string;
  // A multipart/form-data body, sent as it is with its own content type.
  multipart?: Multipart;
  // POSTs that carry a PayPal-Request-Id replay rather than repeat, so they may be retried.
  requestId?: string;
};

type Answer = { status: number; body: unknown; debugId: string | null };

type Multipart = { contentType: string; bytes: Uint8Array<ArrayBuffer> };

type FormPart = { name: string; fileName?: string; contentType: string; bytes: Uint8Array };

// A multipart/form-data body. Part names and file names are checked by the caller's schema, so
// none holds a quote or a line break.
function multipartBody(parts: FormPart[]): Multipart {
  const boundary = `countersign-${randomBytes(16).toString("hex")}`;
  const chunks: Uint8Array[] = [];
  for (const part of parts) {
    const fileName = part.fileName === undefined ? "" : `; filename="${part.fileName}"`;
    chunks.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${part.name}"${fileName}\r\n` +
          `Content-Type: ${part.contentType}\r\n\r\n`,
      ),
      part.bytes,
      Buffer.from("\r\n"),
    );
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return {
    contentType: `multipart/form-data; boundary=${boundary}`,
    bytes: new Uint8Array(Buffer.concat(chunks)),
  };
}

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

  async function requestToken(): Promise<{ token: string; expiresAt: number }> {
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
    return { token: token.data.access_token, expiresAt: now() + token.data.expires_in * 1000 };
  }

  async function fetchToken(): Promise<string> {
    cached = await requestToken();
    return cached.token;
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
        headers["Content-Type"] = spec.multipart?.contentType ?? "application/json";
        headers.Prefer = "return=representation";
        if (spec.requestId !== undefined) headers["PayPal-Request-Id"] = spec.requestId;
      }
      const response = await reach(spec.call, `${config.baseUrl}${spec.path}`, {
        method: spec.method,
        headers,
        body:
          spec.multipart?.bytes ??
          spec.rawBody ??
          (spec.body === undefined ? undefined : JSON.stringify(spec.body)),
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

  // A next link is followed only to the sandbox's disputes endpoint, and always sent to the
  // client's own base URL.
  function nextDisputesPath(call: string, answer: Answer, href: string): string {
    let url: URL | null = null;
    try {
      url = new URL(href);
    } catch {}
    if (
      url?.protocol !== "https:" ||
      !SANDBOX_LINK_HOSTS.has(url.host) ||
      url.pathname !== DISPUTES_PATH
    ) {
      throw new PayPalError({
        kind: "invalid_response",
        call,
        status: answer.status,
        debugId: answer.debugId,
        field: "links.next",
      });
    }
    return `${url.pathname}${url.search}`;
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

    async listDisputes(captureId) {
      const call = "list-disputes";
      const id = checkId(call, captureId);
      const disputes: PayPalDispute[] = [];
      let path: string | null = `${DISPUTES_PATH}?disputed_transaction_id=${id}`;
      for (let pages = 0; path !== null; pages += 1) {
        if (pages === MAX_DISPUTE_PAGES) return { disputes, complete: false };
        const answer = await send({ call, method: "GET", path });
        const page = parse(call, answer, disputesPageSchema);
        disputes.push(...page.disputes);
        path = page.next === null ? null : nextDisputesPath(call, answer, page.next);
      }
      return { disputes, complete: true };
    },

    async listMerchantDisputes(input) {
      const call = "list-merchant-disputes";
      const search = checkInput(call, merchantDisputesSchema, input);
      const query = new URLSearchParams({ page_size: String(search.pageSize) });
      if (search.disputeState !== undefined) query.set("dispute_state", search.disputeState);
      const answer = await send({ call, method: "GET", path: `${DISPUTES_PATH}?${query}` });
      const page = parse(call, answer, disputesPageSchema);
      return { disputes: page.disputes, complete: page.next === null };
    },

    async getDispute(disputeId) {
      const call = "get-dispute";
      const id = checkId(call, disputeId);
      const answer = await send({ call, method: "GET", path: `${DISPUTES_PATH}/${id}` });
      return parse(call, answer, disputeDetailSchema);
    },

    async acceptClaim(input) {
      const call = "accept-claim";
      const claim = checkInput(call, acceptClaimSchema, input);
      // No request ID, so `send` never retries it.
      const answer = await send({
        call,
        method: "POST",
        path: `${DISPUTES_PATH}/${encodeURIComponent(claim.disputeId)}/accept-claim`,
        body: { note: claim.note },
      });
      return answer.status;
    },

    async makeOffer(input) {
      const call = "make-offer";
      const offer = checkInput(call, makeOfferSchema, input);
      let offerAmount: ReturnType<typeof toPayPalAmount> = null;
      if (offer.offerAmount !== undefined) {
        if (offer.offerAmount.currency !== "USD") throw refuse(call, "only USD is sent to PayPal");
        offerAmount = toPayPalAmount({ minor: offer.offerAmount.minor, currency: "USD" });
        if (!offerAmount) throw refuse(call, "offerAmount is invalid");
      }
      // No request ID, so `send` never retries it.
      const answer = await send({
        call,
        method: "POST",
        path: `${DISPUTES_PATH}/${encodeURIComponent(offer.disputeId)}/make-offer`,
        body: {
          note: offer.note,
          offer_type: offer.offerType,
          ...(offerAmount === null ? {} : { offer_amount: offerAmount }),
        },
      });
      return answer.status;
    },

    async provideEvidence(input) {
      const call = "provide-evidence";
      const evidence = checkInput(call, provideEvidenceSchema, input);
      const evidences = evidence.evidences.map((item) => {
        const info = {
          ...(item.trackingInfo === undefined
            ? {}
            : {
                tracking_info: item.trackingInfo.map((tracker) => ({
                  carrier_name: tracker.carrierName,
                  ...(tracker.carrierNameOther === undefined
                    ? {}
                    : { carrier_name_other: tracker.carrierNameOther }),
                  tracking_number: tracker.trackingNumber,
                })),
              }),
          ...(item.refundIds === undefined ? {} : { refund_ids: item.refundIds }),
        };
        return {
          evidence_type: item.evidenceType,
          ...(Object.keys(info).length === 0 ? {} : { evidence_info: info }),
          notes: item.notes,
        };
      });
      const multipart = multipartBody([
        {
          name: "input",
          contentType: "application/json",
          bytes: Buffer.from(JSON.stringify({ evidences })),
        },
        ...evidence.documents.map((document, index) => ({
          name: `file${index + 1}`,
          fileName: document.name,
          contentType: document.contentType,
          bytes: document.bytes,
        })),
      ]);
      // No request ID, so `send` never retries it.
      const answer = await send({
        call,
        method: "POST",
        path: `${DISPUTES_PATH}/${encodeURIComponent(evidence.disputeId)}/provide-evidence`,
        multipart,
      });
      return answer.status;
    },

    async requireEvidence(input) {
      const call = "require-evidence";
      const request = checkInput(call, requireEvidenceSchema, input);
      // No request ID, so `send` never retries it.
      const answer = await send({
        call,
        method: "POST",
        path: `${DISPUTES_PATH}/${encodeURIComponent(request.disputeId)}/require-evidence`,
        body: { action: request.action },
      });
      return answer.status;
    },

    async adjudicate(input) {
      const call = "adjudicate";
      const request = checkInput(call, adjudicateSchema, input);
      // No request ID, so `send` never retries it.
      const answer = await send({
        call,
        method: "POST",
        path: `${DISPUTES_PATH}/${encodeURIComponent(request.disputeId)}/adjudicate`,
        body: { adjudication_outcome: request.outcome },
      });
      return answer.status;
    },

    async getInvoice(invoiceId) {
      const call = "get-invoice";
      const id = checkId(call, invoiceId);
      const answer = await send({ call, method: "GET", path: `/v2/invoicing/invoices/${id}` });
      return parse(call, answer, invoiceSchema);
    },

    async sendInvoice(input) {
      const call = "send-invoice";
      const invoice = checkInput(call, sendInvoiceSchema, input);
      // No request ID, so `send` never retries it.
      const answer = await send({
        call,
        method: "POST",
        path: `/v2/invoicing/invoices/${encodeURIComponent(invoice.invoiceId)}/send`,
        body: {
          send_to_invoicer: true,
          send_to_recipient: invoice.sendToRecipient,
          ...(invoice.note === undefined ? {} : { note: invoice.note }),
          ...(invoice.additionalRecipients === undefined
            ? {}
            : { additional_recipients: invoice.additionalRecipients }),
        },
      });
      if (answer.status === 200) return "SENT";
      if (answer.status === 202) return "SCHEDULED";
      throw new PayPalError({
        kind: "invalid_response",
        call,
        status: answer.status,
        debugId: answer.debugId,
        field: "status",
      });
    },

    async createDraftInvoice(input) {
      const call = "create-draft-invoice";
      const draft = checkInput(call, createDraftInvoiceSchema, input);
      const items = draft.items.map((item, index) => {
        if (item.unitAmount.currency !== "USD") throw refuse(call, "only USD is sent to PayPal");
        const unitAmount = toPayPalAmount({ minor: item.unitAmount.minor, currency: "USD" });
        if (!unitAmount) throw refuse(call, `items[${index}].unitAmount is invalid`);
        return { name: item.name, quantity: String(item.quantity), unit_amount: unitAmount };
      });
      const answer = await send({
        call,
        method: "POST",
        path: "/v2/invoicing/invoices",
        requestId: draft.requestId,
        body: {
          detail: { currency_code: "USD" },
          primary_recipients: [{ billing_info: { email_address: draft.recipientEmail } }],
          items,
        },
      });
      return parse(call, answer, draftInvoiceAnswerSchema);
    },

    async createPayout(input) {
      const call = "create-payout";
      const payout = checkInput(call, createPayoutSchema, input);
      if (payout.amount.currency !== "USD") throw refuse(call, "only USD is sent to PayPal");
      const amount = toPayPalAmount({ minor: payout.amount.minor, currency: "USD" });
      if (!amount) throw refuse(call, "amount is invalid");
      const answer = await send({
        call,
        method: "POST",
        path: "/v1/payments/payouts",
        requestId: payout.requestId,
        body: {
          sender_batch_header: {
            sender_batch_id: payout.senderBatchId,
            recipient_type: "EMAIL",
            email_subject: payout.emailSubject,
          },
          items: [
            {
              recipient_type: "EMAIL",
              amount: { value: amount.value, currency: amount.currency_code },
              receiver: payout.receiver,
              ...(payout.note === undefined ? {} : { note: payout.note }),
              sender_item_id: payout.senderItemId,
            },
          ],
        },
      });
      return parse(call, answer, payoutCreatedSchema);
    },

    async getPayoutBatch(batchId) {
      const call = "get-payout-batch";
      const id = checkId(call, batchId);
      const answer = await send({ call, method: "GET", path: `/v1/payments/payouts/${id}` });
      return parse(call, answer, payoutBatchSchema);
    },

    async getPayoutItem(itemId) {
      const call = "get-payout-item";
      const id = checkId(call, itemId);
      const answer = await send({ call, method: "GET", path: `/v1/payments/payouts-item/${id}` });
      return parse(call, answer, payoutItemSchema);
    },

    async searchTransactions(input) {
      const call = "search-transactions";
      const search = checkInput(call, transactionSearchSchema, input);
      const query = new URLSearchParams({
        start_date: new Date(search.startDate).toISOString(),
        end_date: new Date(search.endDate).toISOString(),
        fields: "transaction_info",
        page_size: String(TRANSACTION_PAGE_SIZE),
        page: "1",
      });
      if (search.transactionId !== undefined) query.set("transaction_id", search.transactionId);
      const answer = await send({
        call,
        method: "GET",
        path: `/v1/reporting/transactions?${query}`,
      });
      return parse(call, answer, transactionPageSchema);
    },

    async issueAccessToken() {
      const { token, expiresAt } = await requestToken();
      return { accessToken: token, expiresAt };
    },

    async verifyWebhookSignature(input) {
      const call = "verify-webhook-signature";
      const check = checkInput(call, verifyWebhookSchema, input);
      if (!isJsonObject(check.rawBody)) throw refuse(call, "the event body isn't a JSON object");
      const fields = JSON.stringify({
        transmission_id: check.transmission.transmissionId,
        transmission_time: check.transmission.transmissionTime,
        cert_url: check.transmission.certUrl,
        auth_algo: check.transmission.authAlgo,
        transmission_sig: check.transmission.transmissionSig,
        webhook_id: check.webhookId,
      });
      // No request ID, so `send` never retries it.
      const answer = await send({
        call,
        method: "POST",
        path: "/v1/notifications/verify-webhook-signature",
        rawBody: `${fields.slice(0, -1)},"webhook_event":${check.rawBody}}`,
      });
      return parse(call, answer, verificationSchema);
    },

    async getOrder(orderId) {
      const call = "get-order";
      const id = checkId(call, orderId);
      const answer = await send({ call, method: "GET", path: `/v2/checkout/orders/${id}` });
      return parse(call, answer, orderSchema);
    },
  };
}

function isJsonObject(text: string): boolean {
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === "object" && value !== null && !Array.isArray(value);
  } catch {
    return false;
  }
}
