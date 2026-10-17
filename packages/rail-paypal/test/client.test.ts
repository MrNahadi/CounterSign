import {
  createPayPalClient,
  type PayPalClientOptions,
  PayPalConfigError,
  parsePayPalEnv,
} from "@countersign/rail-paypal";
import { describe, expect, it } from "vitest";
import {
  caught,
  testClient as client,
  expectNoSecrets,
  exposed,
  FAKE_CLIENT_ID,
  FAKE_SECRET,
  FAKE_TOKEN,
  fakePayPal,
  fixture,
  reply,
  sandboxEnv,
  tokenReply,
} from "./fake-paypal";

const ORDER_ID = "5O190127TN364715T";

describe("configuration", () => {
  it("accepts the sandbox base URL, with or without a trailing slash", () => {
    expect(parsePayPalEnv(sandboxEnv).ok).toBe(true);
    const slash = parsePayPalEnv({
      ...sandboxEnv,
      PAYPAL_BASE_URL: "https://api-m.sandbox.paypal.com/",
    });
    expect(slash.ok).toBe(true);
  });

  it("refuses any other base URL, naming the expected one and never the value", () => {
    for (const url of [
      "https://api-m.paypal.com",
      "https://api-m.sandbox.paypal.com.attacker.example.com",
      "http://api-m.sandbox.paypal.com",
      "https://api-m.sandbox.paypal.com/v2",
    ]) {
      const env = { ...sandboxEnv, PAYPAL_BASE_URL: url };
      const parsed = parsePayPalEnv(env);
      expect(parsed.ok).toBe(false);
      if (parsed.ok) continue;
      expect(parsed.problems).toEqual([
        "PAYPAL_BASE_URL must be https://api-m.sandbox.paypal.com. Only the PayPal sandbox is allowed.",
      ]);
      const fake = fakePayPal(() => reply(200, {}));
      let thrown: unknown;
      try {
        createPayPalClient({ env, fetch: fake.fetch });
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(PayPalConfigError);
      expect(exposed(thrown)).not.toContain(url);
      expectNoSecrets(thrown);
      expect(fake.requests).toEqual([]);
    }
  });

  it("names every missing variable and shows no value", () => {
    const parsed = parsePayPalEnv({ PAYPAL_CLIENT_SECRET: FAKE_SECRET });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.missing).toEqual(["PAYPAL_BASE_URL", "PAYPAL_CLIENT_ID"]);
    expect(parsed.problems).toEqual([
      "PAYPAL_BASE_URL is missing.",
      "PAYPAL_CLIENT_ID is missing.",
    ]);
    expectNoSecrets(parsed);

    let thrown: unknown;
    try {
      createPayPalClient({ env: { PAYPAL_CLIENT_SECRET: FAKE_SECRET, PAYPAL_CLIENT_ID: "" } });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(PayPalConfigError);
    expect((thrown as PayPalConfigError).message).toContain("PAYPAL_BASE_URL is missing.");
    expect((thrown as PayPalConfigError).message).toContain("PAYPAL_CLIENT_ID is missing.");
    expectNoSecrets(thrown);
  });
});

describe("the OAuth token", () => {
  it("is fetched with client credentials and sent as a bearer token", async () => {
    const fake = fakePayPal(() => reply(200, fixture("get-order-completed")));
    await client(fake).getOrder(ORDER_ID);

    const [tokenRequest] = fake.tokenRequests();
    expect(tokenRequest?.method).toBe("POST");
    expect(tokenRequest?.url).toBe("https://api-m.sandbox.paypal.com/v1/oauth2/token");
    expect(tokenRequest?.body).toBe("grant_type=client_credentials");
    expect(tokenRequest?.headers.authorization).toBe(
      `Basic ${Buffer.from(`${FAKE_CLIENT_ID}:${FAKE_SECRET}`).toString("base64")}`,
    );
    const [orderRequest] = fake.apiRequests();
    expect(orderRequest?.method).toBe("GET");
    expect(orderRequest?.url).toBe(
      `https://api-m.sandbox.paypal.com/v2/checkout/orders/${ORDER_ID}`,
    );
    expect(orderRequest?.headers.authorization).toBe(`Bearer ${FAKE_TOKEN}`);
  });

  it("is shared by many concurrent calls through one token request", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fake = fakePayPal(
      () => reply(200, fixture("get-order-completed")),
      async () => {
        await gate;
        return tokenReply();
      },
    );
    const paypal = client(fake);
    const calls = Array.from({ length: 8 }, () => paypal.getOrder(ORDER_ID));
    release();
    const orders = await Promise.all(calls);

    expect(orders).toHaveLength(8);
    expect(fake.tokenRequests()).toHaveLength(1);
    expect(fake.apiRequests()).toHaveLength(8);
    await paypal.getOrder(ORDER_ID);
    expect(fake.tokenRequests()).toHaveLength(1);
  });

  it("is replaced before a call once less than five minutes of expires_in remain", async () => {
    let now = 1_000_000;
    let issued = 0;
    const fake = fakePayPal(
      () => reply(200, fixture("get-order-completed")),
      () => tokenReply(`${FAKE_TOKEN}-${++issued}`, 900),
    );
    const paypal = client(fake, { now: () => now });

    await paypal.getOrder(ORDER_ID);
    now += 9 * 60_000; // six minutes left
    await paypal.getOrder(ORDER_ID);
    expect(fake.tokenRequests()).toHaveLength(1);

    now += 60_000 + 1; // just under five minutes left
    await paypal.getOrder(ORDER_ID);
    expect(fake.tokenRequests()).toHaveLength(2);
    expect(fake.apiRequests().map((r) => r.headers.authorization)).toEqual([
      `Bearer ${FAKE_TOKEN}-1`,
      `Bearer ${FAKE_TOKEN}-1`,
      `Bearer ${FAKE_TOKEN}-2`,
    ]);
  });

  it("gets one new token and one retry after a 401", async () => {
    let issued = 0;
    const fake = fakePayPal(
      (req) =>
        req.headers.authorization === `Bearer ${FAKE_TOKEN}-1`
          ? reply(401, {
              error: "invalid_token",
              error_description: "Token signature verification failed",
            })
          : reply(200, fixture("get-order-completed")),
      () => tokenReply(`${FAKE_TOKEN}-${++issued}`),
    );
    const order = await client(fake).getOrder(ORDER_ID);

    expect(order.id).toBe(ORDER_ID);
    expect(fake.tokenRequests()).toHaveLength(2);
    expect(fake.apiRequests()).toHaveLength(2);
    expectNoSecrets(order);
  });

  it("fails on a second 401", async () => {
    let issued = 0;
    const fake = fakePayPal(
      () =>
        reply(401, {
          error: "invalid_token",
          error_description: "Token signature verification failed",
        }),
      () => tokenReply(`${FAKE_TOKEN}-${++issued}`),
    );
    const error = await caught(client(fake).getOrder(ORDER_ID));

    expect(error.call).toBe("get-order");
    expect(error.status).toBe(401);
    expect(error.paypalName).toBe("invalid_token");
    expect(fake.tokenRequests()).toHaveLength(2);
    expect(fake.apiRequests()).toHaveLength(2);
  });

  it("reports a refused token request without the secret, and doesn't retry it", async () => {
    const fake = fakePayPal(
      () => reply(200, fixture("get-order-completed")),
      () =>
        reply(
          401,
          { error: "invalid_client", error_description: "Client Authentication failed" },
          {
            "paypal-debug-id": "5b2c9e1f0a3d7",
          },
        ),
    );
    const error = await caught(client(fake).getOrder(ORDER_ID));

    expect(error.call).toBe("oauth-token");
    expect(error.status).toBe(401);
    expect(error.paypalName).toBe("invalid_client");
    expect(error.paypalMessage).toBe("Client Authentication failed");
    expect(error.debugId).toBe("5b2c9e1f0a3d7");
    expect(fake.tokenRequests()).toHaveLength(1);
    expect(fake.apiRequests()).toHaveLength(0);
  });

  it("never lets the token or secret through, even when PayPal echoes them", async () => {
    const fake = fakePayPal(() =>
      reply(400, {
        name: "INVALID_REQUEST",
        message: `Bad header Bearer ${FAKE_TOKEN} for ${FAKE_SECRET}`,
        debug_id: "0d1e2f3a4b5c6",
        details: [{ issue: "MALFORMED_REQUEST_JSON" }],
      }),
    );
    const error = await caught(client(fake).getOrder(ORDER_ID));
    expect(error.paypalMessage).toContain("[redacted]");
  });
});

describe("get order", () => {
  it("parses a completed order into the client's record, money in minor units", async () => {
    const fake = fakePayPal(() => reply(200, fixture("get-order-completed")));
    const order = await client(fake).getOrder(ORDER_ID);

    expect(order).toEqual({
      id: ORDER_ID,
      status: "COMPLETED",
      payerEmail: "buyer-a@example.com",
      payerId: "QYR5Z8XDVJNXQ",
      purchaseUnits: [
        {
          referenceId: "KIK-2002",
          customId: "spike",
          invoiceId: "KIK-2002-spike",
          amount: { minor: 3600, currency: "USD" },
          captures: [
            {
              id: "3JM25846XW7943026",
              status: "COMPLETED",
              amount: { minor: 3600, currency: "USD" },
              orderId: ORDER_ID,
            },
          ],
          trackers: [
            {
              id: "3JM25846XW7943026-KIKSPIKE0002",
              captureId: "3JM25846XW7943026",
              trackingNumber: "KIKSPIKE0002",
              status: "SHIPPED",
            },
          ],
        },
      ],
    });
    expectNoSecrets(order);
  });

  it("reads absent payer, custom ID and invoice ID as null, and no captures or trackers as empty", async () => {
    const fake = fakePayPal(() => reply(200, fixture("get-order-payer-action-required")));
    const order = await client(fake).getOrder("7BN283777R9375221");

    expect(order).toEqual({
      id: "7BN283777R9375221",
      status: "PAYER_ACTION_REQUIRED",
      payerEmail: null,
      payerId: null,
      purchaseUnits: [
        {
          referenceId: "SHOP-Q4ZK7M",
          customId: "storefront:market-basket",
          invoiceId: null,
          amount: { minor: 4800, currency: "USD" },
          captures: [],
          trackers: [],
        },
      ],
    });
  });

  it("turns a 404 into an error with the call, status, name, message, debug ID and issues", async () => {
    const fake = fakePayPal(() => reply(404, fixture("error-404-resource-not-found")));
    const error = await caught(client(fake).getOrder("9XX00000000000000"));

    expect(error).toMatchObject({
      kind: "http",
      call: "get-order",
      status: 404,
      paypalName: "RESOURCE_NOT_FOUND",
      paypalMessage: "The specified resource does not exist.",
      debugId: "f2a6c1d93b7e4",
      issues: ["INVALID_RESOURCE_ID"],
    });
    expect(error.message).toContain("get-order");
    expect(error.message).toContain("RESOURCE_NOT_FOUND");
    expect(error.message).toContain("f2a6c1d93b7e4");
    expect(fake.apiRequests()).toHaveLength(1);
  });

  it("turns a 422 into an error with its issue codes, and doesn't retry it", async () => {
    const fake = fakePayPal(() => reply(422, fixture("error-422-unprocessable")));
    const error = await caught(client(fake).getOrder(ORDER_ID));

    expect(error).toMatchObject({
      kind: "http",
      call: "get-order",
      status: 422,
      paypalName: "UNPROCESSABLE_ENTITY",
      debugId: "9c3e5b0a71d28",
      issues: ["ORDER_NOT_APPROVED"],
    });
    expect(fake.apiRequests()).toHaveLength(1);
  });

  it("refuses a response missing a field it uses, naming the field", async () => {
    const order = fixture("get-order-completed");
    const units = order.purchase_units as Record<string, unknown>[];
    const unit = units[0] as Record<string, unknown>;
    const missingAmount = { ...order, purchase_units: [{ ...unit, amount: undefined }] };
    const fake = fakePayPal(() => reply(200, missingAmount));
    const error = await caught(client(fake).getOrder(ORDER_ID));

    expect(error.kind).toBe("invalid_response");
    expect(error.call).toBe("get-order");
    expect(error.field).toBe("purchase_units[0].amount");
    expect(error.message).toContain("purchase_units[0].amount");
  });

  it("refuses a capture amount that isn't a decimal string, naming the field", async () => {
    const order = fixture("get-order-completed");
    const text = JSON.stringify(order).replace(
      '"amount":{"currency_code":"USD","value":"36.00"},"final_capture"',
      '"amount":{"currency_code":"USD","value":"36.5.0"},"final_capture"',
    );
    const fake = fakePayPal(() => reply(200, JSON.parse(text)));
    const error = await caught(client(fake).getOrder(ORDER_ID));

    expect(error.field).toBe("purchase_units[0].payments.captures[0].amount");
  });

  it("refuses a response with no order ID", async () => {
    const { id: _id, ...noId } = fixture("get-order-completed");
    const fake = fakePayPal(() => reply(200, noId));
    const error = await caught(client(fake).getOrder(ORDER_ID));
    expect(error.field).toBe("id");
  });

  it("refuses a malformed order ID before any call", async () => {
    const fake = fakePayPal(() => reply(200, fixture("get-order-completed")));
    const error = await caught(client(fake).getOrder("../../v1/oauth2/token"));
    expect(error.kind).toBe("invalid_request");
    expect(fake.requests).toEqual([]);
  });
});

describe("retries", () => {
  function recordWaits() {
    const waits: number[] = [];
    return { waits, sleep: async (ms: number) => void waits.push(ms) };
  }

  it("retries a GET on 5xx at most twice, with a short backoff", async () => {
    let calls = 0;
    const fake = fakePayPal(() =>
      ++calls <= 2
        ? reply(503, { name: "SERVICE_UNAVAILABLE" })
        : reply(200, fixture("get-order-completed")),
    );
    const { waits, sleep } = recordWaits();
    const order = await client(fake, { sleep }).getOrder(ORDER_ID);

    expect(order.id).toBe(ORDER_ID);
    expect(fake.apiRequests()).toHaveLength(3);
    expect(waits).toHaveLength(2);
    for (const wait of waits) expect(wait).toBeGreaterThan(0);
    for (const wait of waits) expect(wait).toBeLessThanOrEqual(10_000);
  });

  it("gives up after two retries", async () => {
    const fake = fakePayPal(() =>
      reply(500, {
        name: "INTERNAL_SERVER_ERROR",
        message: "An internal server error occurred.",
        debug_id: "abc123",
      }),
    );
    const { waits, sleep } = recordWaits();
    const error = await caught(client(fake, { sleep }).getOrder(ORDER_ID));

    expect(error.status).toBe(500);
    expect(error.debugId).toBe("abc123");
    expect(fake.apiRequests()).toHaveLength(3);
    expect(waits).toHaveLength(2);
  });

  it("honours Retry-After on a 429, capped at 10 seconds", async () => {
    let calls = 0;
    const fake = fakePayPal(() => {
      calls += 1;
      if (calls === 1) return reply(429, { name: "RATE_LIMIT_REACHED" }, { "retry-after": "3" });
      if (calls === 2) return reply(429, { name: "RATE_LIMIT_REACHED" }, { "retry-after": "60" });
      return reply(200, fixture("get-order-completed"));
    });
    const { waits, sleep } = recordWaits();
    await client(fake, { sleep }).getOrder(ORDER_ID);

    expect(waits).toEqual([3_000, 10_000]);
  });

  it("reads a Retry-After date against the injected clock", async () => {
    const now = Date.parse("2026-10-17T12:00:00Z");
    let calls = 0;
    const fake = fakePayPal(() =>
      ++calls === 1
        ? reply(
            429,
            { name: "RATE_LIMIT_REACHED" },
            { "retry-after": "Sat, 17 Oct 2026 12:00:04 GMT" },
          )
        : reply(200, fixture("get-order-completed")),
    );
    const { waits, sleep } = recordWaits();
    await client(fake, { sleep, now: () => now }).getOrder(ORDER_ID);

    expect(waits).toEqual([4_000]);
  });

  it("doesn't retry a 4xx other than 429", async () => {
    const fake = fakePayPal(() => reply(400, { name: "INVALID_REQUEST" }));
    const { waits, sleep } = recordWaits();
    const error = await caught(client(fake, { sleep }).getOrder(ORDER_ID));

    expect(error.status).toBe(400);
    expect(fake.apiRequests()).toHaveLength(1);
    expect(waits).toEqual([]);
  });

  it("reports a network failure as an error without retrying", async () => {
    const fake = fakePayPal(() => reply(200, fixture("get-order-completed")));
    const failing: PayPalClientOptions["fetch"] = async (url, init) => {
      if (new URL(url).pathname === "/v1/oauth2/token") return fake.fetch(url, init);
      throw new TypeError("fetch failed");
    };
    const error = await caught(
      createPayPalClient({ env: sandboxEnv, fetch: failing, sleep: async () => {} }).getOrder(
        ORDER_ID,
      ),
    );
    expect(error.kind).toBe("network");
    expect(error.status).toBeNull();
  });
});
