import {
  createPayPalClient,
  type FetchLike,
  MAX_RETRIES,
  MAX_RETRY_WAIT_MS,
  type PayPalError,
  RAIL_REQUEST_TIMEOUT_MS,
  RAIL_WORST_CALL_MS,
} from "@countersign/rail-paypal";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { caught, fixture, sandboxEnv, tokenReply } from "./fake-paypal";

// Every request the client makes is bounded, body included: a server that hangs ends in a
// `network` PayPalError once RAIL_REQUEST_TIMEOUT_MS has passed, and it isn't retried.

const CAPTURE_ID = "8RH70421MV5531947";

type Hang = "before-answer" | "mid-body" | "none";

// A fake PayPal that behaves as a real fetch does on abort: a pending request rejects, and a body
// being read errors, with the signal's reason.
function hangingPayPal(behaviour: { token: Hang; api: Hang }) {
  const seen: { path: string; signal: AbortSignal | undefined }[] = [];
  const fetch: FetchLike = async (url, init) => {
    const path = new URL(url).pathname;
    const signal = init.signal;
    seen.push({ path, signal });
    const hang = path === "/v1/oauth2/token" ? behaviour.token : behaviour.api;
    if (hang === "before-answer") {
      return new Promise<Response>((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    }
    if (hang === "mid-body") {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"id":"'));
          signal?.addEventListener("abort", () => controller.error(signal.reason), { once: true });
        },
      });
      return new Response(stream, { status: 200, headers: { "content-type": "application/json" } });
    }
    const body = path === "/v1/oauth2/token" ? tokenReply().body : fixture("get-capture");
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  return { fetch, seen };
}

function client(fake: ReturnType<typeof hangingPayPal>) {
  return createPayPalClient({ env: sandboxEnv, fetch: fake.fetch, sleep: async () => {} });
}

// Settles once the timers have run exactly RAIL_REQUEST_TIMEOUT_MS, and not a millisecond before.
async function failsAtTimeout(promise: Promise<unknown>): Promise<PayPalError> {
  let settled = false;
  const error = caught(promise).finally(() => {
    settled = true;
  });
  await vi.advanceTimersByTimeAsync(RAIL_REQUEST_TIMEOUT_MS - 1);
  expect(settled).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  return error;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("rail request timeouts", () => {
  it("ends a request whose server never answers in a network error, without retrying", async () => {
    const fake = hangingPayPal({ token: "none", api: "before-answer" });
    const error = await failsAtTimeout(client(fake).getCapture(CAPTURE_ID));
    expect(error.kind).toBe("network");
    expect(error.call).toBe("get-capture");
    expect(error.status).toBeNull();
    expect(fake.seen.filter((r) => r.path !== "/v1/oauth2/token")).toHaveLength(1);
  });

  it("ends a request whose body stops arriving in a network error, without retrying", async () => {
    const fake = hangingPayPal({ token: "none", api: "mid-body" });
    const error = await failsAtTimeout(client(fake).getCapture(CAPTURE_ID));
    expect(error.kind).toBe("network");
    expect(error.call).toBe("get-capture");
    expect(error.status).toBeNull();
    expect(fake.seen.filter((r) => r.path !== "/v1/oauth2/token")).toHaveLength(1);
  });

  it("bounds a token request that never answers the same way", async () => {
    const fake = hangingPayPal({ token: "before-answer", api: "none" });
    const error = await failsAtTimeout(client(fake).getCapture(CAPTURE_ID));
    expect(error.kind).toBe("network");
    expect(error.call).toBe("oauth-token");
    expect(fake.seen.map((r) => r.path)).toEqual(["/v1/oauth2/token"]);
  });

  it("bounds a token request whose body stops arriving the same way", async () => {
    const fake = hangingPayPal({ token: "mid-body", api: "none" });
    const error = await failsAtTimeout(client(fake).issueAccessToken());
    expect(error.kind).toBe("network");
    expect(error.call).toBe("oauth-token");
  });

  it("gives every request its own signal, and a prompt answer still succeeds", async () => {
    const fake = hangingPayPal({ token: "none", api: "none" });
    const capture = await client(fake).getCapture(CAPTURE_ID);
    expect(capture.id).toBe(CAPTURE_ID);
    expect(fake.seen).toHaveLength(2);
    for (const request of fake.seen) expect(request.signal).toBeInstanceOf(AbortSignal);
    expect(fake.seen[0]?.signal).not.toBe(fake.seen[1]?.signal);
  });

  it("states one call's worst case from today's constants", () => {
    expect(RAIL_REQUEST_TIMEOUT_MS).toBe(30_000);
    expect(MAX_RETRIES).toBe(2);
    expect(MAX_RETRY_WAIT_MS).toBe(10_000);
    expect(RAIL_WORST_CALL_MS).toBe(200_000);
  });
});
