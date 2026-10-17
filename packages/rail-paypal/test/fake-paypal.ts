import { readFileSync } from "node:fs";
import { join } from "node:path";
import { inspect } from "node:util";
import {
  createPayPalClient,
  type FetchLike,
  type PayPalClientOptions,
  PayPalError,
} from "@countersign/rail-paypal";
import { expect } from "vitest";

// A fake PayPal sandbox for tests: no network, recorded fixtures, every request kept.

export const FAKE_CLIENT_ID = "fake-client-id-for-tests";
export const FAKE_SECRET = "fake-client-secret-do-not-leak";
export const FAKE_TOKEN = "A21AAFAKE-ACCESS-TOKEN-FOR-TESTS-ONLY";
// The vault ID in `create-order-vault-completed.json`, so tests can check it never leaks.
export const FAKE_VAULT_TOKEN = "fake-vault-token-do-not-leak";

export const sandboxEnv = {
  PAYPAL_BASE_URL: "https://api-m.sandbox.paypal.com",
  PAYPAL_CLIENT_ID: FAKE_CLIENT_ID,
  PAYPAL_CLIENT_SECRET: FAKE_SECRET,
};

export function fixture(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(import.meta.dirname, "fixtures", `${name}.json`), "utf8"));
}

export type SeenRequest = {
  method: string;
  url: string;
  path: string;
  headers: Record<string, string>;
  body: string | null;
};

export type Reply = { status: number; body?: unknown; headers?: Record<string, string> };

export function reply(status: number, body?: unknown, headers?: Record<string, string>): Reply {
  return { status, body, headers };
}

export function tokenReply(token = FAKE_TOKEN, expiresIn = 32400): Reply {
  return reply(200, { ...fixture("oauth-token"), access_token: token, expires_in: expiresIn });
}

type Route = (req: SeenRequest) => Reply | Promise<Reply>;

// `api` answers every call but the token request; `token` answers the token request.
export function fakePayPal(api: Route, token: Route = () => tokenReply()) {
  const requests: SeenRequest[] = [];
  const fetch: FetchLike = async (url, init) => {
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((value, key) => {
      headers[key] = value;
    });
    const seen: SeenRequest = {
      method: init.method ?? "GET",
      url,
      path: new URL(url).pathname,
      headers,
      body: typeof init.body === "string" ? init.body : null,
    };
    requests.push(seen);
    const answer = await (seen.path === "/v1/oauth2/token" ? token(seen) : api(seen));
    const text = answer.body === undefined ? null : JSON.stringify(answer.body);
    return new Response(text, {
      status: answer.status,
      headers: { "content-type": "application/json", ...answer.headers },
    });
  };
  return {
    fetch,
    requests,
    tokenRequests: () => requests.filter((r) => r.path === "/v1/oauth2/token"),
    apiRequests: () => requests.filter((r) => r.path !== "/v1/oauth2/token"),
  };
}

// A client over the fake, with retries that don't wait.
export function testClient(
  fake: ReturnType<typeof fakePayPal>,
  options: Partial<PayPalClientOptions> = {},
) {
  return createPayPalClient({
    env: sandboxEnv,
    fetch: fake.fetch,
    sleep: async () => {},
    ...options,
  });
}

// Everything a test can see: return values, thrown values and their stacks.
export function exposed(value: unknown): string {
  if (value instanceof Error) {
    return [
      String(value),
      value.stack ?? "",
      inspect(value, { depth: 10 }),
      JSON.stringify(value),
    ].join("\n");
  }
  return `${JSON.stringify(value)}\n${inspect(value, { depth: 10 })}`;
}

export function expectNoSecrets(value: unknown) {
  const text = exposed(value);
  expect(text).not.toContain(FAKE_SECRET);
  expect(text).not.toContain(FAKE_TOKEN);
  expect(text).not.toContain(FAKE_VAULT_TOKEN);
  expect(text).not.toContain(Buffer.from(`${FAKE_CLIENT_ID}:${FAKE_SECRET}`).toString("base64"));
}

// The PayPalError a call fails with, checked for secrets.
export async function caught(promise: Promise<unknown>): Promise<PayPalError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(PayPalError);
    expectNoSecrets(error);
    return error as PayPalError;
  }
  throw new Error("Expected the call to fail");
}
