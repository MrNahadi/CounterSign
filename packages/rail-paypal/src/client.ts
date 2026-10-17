import { z } from "zod";
import { type PayPalConfig, PayPalConfigError, parsePayPalEnv } from "./config";
import { PayPalError } from "./errors";
import { errorBodySchema, fieldPath, orderSchema, type PayPalOrder, tokenSchema } from "./records";

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

export type PayPalClient = {
  getOrder(orderId: string): Promise<PayPalOrder>;
};

// A token with less than this left is replaced before the next call.
const TOKEN_MARGIN_MS = 5 * 60_000;
const MAX_RETRIES = 2;
const MAX_RETRY_WAIT_MS = 10_000;
const BACKOFF_MS = 250;

const resourceId = z.string().regex(/^[A-Za-z0-9-]{1,64}$/);

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

  function checkId(call: string, id: string): string {
    if (!resourceId.safeParse(id).success) {
      throw new PayPalError({
        kind: "invalid_request",
        call,
        status: null,
        reason: "the ID is malformed",
      });
    }
    return encodeURIComponent(id);
  }

  return {
    async getOrder(orderId) {
      const call = "get-order";
      const id = checkId(call, orderId);
      const answer = await send({ call, method: "GET", path: `/v2/checkout/orders/${id}` });
      return parse(call, answer, orderSchema);
    },
  };
}
