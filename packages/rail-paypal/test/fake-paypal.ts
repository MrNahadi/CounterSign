import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { FetchLike } from "@countersign/rail-paypal";

// A fake PayPal sandbox for tests: no network, recorded fixtures, every request kept.

export const FAKE_CLIENT_ID = "fake-client-id-for-tests";
export const FAKE_SECRET = "fake-client-secret-do-not-leak";
export const FAKE_TOKEN = "A21AAFAKE-ACCESS-TOKEN-FOR-TESTS-ONLY";

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
