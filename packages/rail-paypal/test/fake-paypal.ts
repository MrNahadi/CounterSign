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
  // A multipart/form-data body, parsed as a server would read it. Null for any other body.
  form: FormData | null;
  // A body sent as bytes, as it was sent. Null for a text body.
  bytes: Uint8Array | null;
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
      form: await parsedForm(headers["content-type"], init.body),
      bytes: init.body instanceof Uint8Array ? init.body : null,
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

// Reads a multipart body with the platform's own parser, so a malformed one fails the test.
async function parsedForm(
  contentType: string | undefined,
  body: string | Uint8Array<ArrayBuffer> | undefined,
): Promise<FormData | null> {
  if (!contentType?.startsWith("multipart/form-data") || body === undefined) return null;
  return new Response(body, { headers: { "content-type": contentType } }).formData();
}

// The provide-evidence route, checking the multipart parts as PayPal reads them: an `input` part
// sent as application/json holding `evidences`, then file1, file2, … each a named PDF. Anything
// else answers PayPal's 400, so a test can't pass with a body PayPal would refuse.
export function provideEvidenceReply(req: SeenRequest): Reply {
  const invalid = (issue: string) =>
    reply(400, {
      name: "INVALID_REQUEST",
      message: "Request is not well-formed.",
      details: [{ issue }],
    });
  if (!req.form || !req.bytes) return invalid("NOT_MULTIPART");
  const raw = Buffer.from(req.bytes).toString("latin1");
  if (!/name="input"\r\nContent-Type: application\/json\r\n/.test(raw)) {
    return invalid("INPUT_NOT_JSON_PART");
  }
  const input = req.form.get("input");
  if (typeof input !== "string") return invalid("MISSING_INPUT");
  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch {
    return invalid("INPUT_NOT_JSON");
  }
  const evidences = (parsed as { evidences?: unknown }).evidences;
  if (!Array.isArray(evidences) || evidences.length === 0) return invalid("MISSING_EVIDENCES");
  const names = [...req.form.keys()].filter((name) => name !== "input");
  for (const [index, name] of names.entries()) {
    const file = req.form.get(name);
    if (name !== `file${index + 1}`) return invalid("UNEXPECTED_PART");
    if (!(file instanceof File) || file.name === "" || file.type !== "application/pdf") {
      return invalid("INVALID_FILE");
    }
  }
  return reply(200, fixture("dispute-action"));
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
