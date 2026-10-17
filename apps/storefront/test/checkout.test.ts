import { createPayPalClient, type FetchLike } from "@countersign/rail-paypal";
import { describe, expect, it } from "vitest";
import {
  CAPTURE_REQUEST_PREFIX,
  captureCheckoutOrder,
  checkoutPayPal,
  createCheckoutOrder,
} from "../src/checkout";

// The storefront's checkout functions over an injected PayPal client and a fake fetch: no network.

const SECRET = "fake-client-secret-do-not-leak";
const env = {
  PAYPAL_BASE_URL: "https://api-m.sandbox.paypal.com",
  PAYPAL_CLIENT_ID: "fake-client-id-for-tests",
  PAYPAL_CLIENT_SECRET: SECRET,
};

type Json = Record<string, unknown>;
type Answer = { status: number; body: unknown };
type Seen = { method: string; path: string; requestId: string | null; body: Json | null };

// A fake sandbox for buyer-approved orders. Orders are created CREATED and captured on request;
// `edit` may change an order's stored record or a capture's answer.
function fakeCheckout() {
  const orders = new Map<string, Json>();
  const seen: Seen[] = [];
  const replies = new Map<string, Answer>();
  let next = 1;
  const state: {
    fail?: (call: "create" | "get" | "capture") => Answer | undefined;
    captureStatus: string;
    captureValue?: string;
  } = { captureStatus: "COMPLETED" };

  const fetch: FetchLike = async (url, init) => {
    const path = new URL(url).pathname;
    const requestId = new Headers(init.headers).get("paypal-request-id");
    if (path === "/v1/oauth2/token") {
      return json({
        status: 200,
        body: { access_token: "FAKE-ACCESS-TOKEN", expires_in: 32400, token_type: "Bearer" },
      });
    }
    const body = init.body ? (JSON.parse(init.body) as Json) : null;
    seen.push({ method: init.method, path, requestId, body });
    const replay = requestId ? replies.get(requestId) : undefined;
    if (replay) return json(replay);
    const capturePath = /^\/v2\/checkout\/orders\/([^/]+)\/capture$/.exec(path);
    const orderPath = /^\/v2\/checkout\/orders\/([^/]+)$/.exec(path);
    let answer: Answer;
    if (init.method === "POST" && path === "/v2/checkout/orders") {
      answer = state.fail?.("create") ?? create(body ?? {});
    } else if (init.method === "GET" && orderPath) {
      const order = orders.get(orderPath[1] ?? "");
      answer =
        state.fail?.("get") ??
        (order
          ? { status: 200, body: structuredClone(order) }
          : { status: 404, body: { name: "RESOURCE_NOT_FOUND", debug_id: "dbg404" } });
    } else if (init.method === "POST" && capturePath) {
      answer = state.fail?.("capture") ?? capture(capturePath[1] ?? "");
    } else {
      answer = { status: 404, body: { name: "RESOURCE_NOT_FOUND" } };
    }
    if (requestId && answer.status < 400) replies.set(requestId, answer);
    return json(answer);
  };

  function create(body: Json): Answer {
    const [unit] = body.purchase_units as Json[];
    const id = `5O190127TN36471${String(next++).padStart(2, "0")}`;
    const order: Json = {
      id,
      intent: "CAPTURE",
      status: "CREATED",
      purchase_units: [
        {
          reference_id: unit?.reference_id,
          custom_id: unit?.custom_id,
          invoice_id: unit?.invoice_id,
          amount: unit?.amount,
          items: unit?.items,
        },
      ],
    };
    orders.set(id, order);
    return { status: 201, body: structuredClone(order) };
  }

  function capture(id: string): Answer {
    const order = orders.get(id);
    if (!order) return { status: 404, body: { name: "RESOURCE_NOT_FOUND" } };
    const [unit] = order.purchase_units as Json[];
    const amount = unit?.amount as { currency_code: string; value: string };
    order.status = state.captureStatus === "COMPLETED" ? "COMPLETED" : "APPROVED";
    order.payer = { email_address: "shopper@example.com", payer_id: "SHOPPER1234" };
    (unit as Json).payments = {
      captures: [
        {
          id: `CAP${id.slice(-8)}`,
          status: state.captureStatus,
          amount: {
            currency_code: amount.currency_code,
            value: state.captureValue ?? amount.value,
          },
        },
      ],
    };
    return { status: 201, body: structuredClone(order) };
  }

  // Adds an order to the fake as if someone else had created it.
  function plant(id: string, unit: Json) {
    orders.set(id, { id, intent: "CAPTURE", status: "APPROVED", purchase_units: [unit] });
  }

  return {
    fetch,
    seen,
    state,
    orders,
    plant,
    client: () => createPayPalClient({ env, fetch, sleep: async () => {}, now: () => 0 }),
    captures: () => seen.filter((call) => call.path.endsWith("/capture")),
  };
}

function json(answer: Answer): Response {
  return new Response(JSON.stringify(answer.body), {
    status: answer.status,
    headers: { "content-type": "application/json" },
  });
}

const paypalError = (status: number, name: string, debugId: string): Answer => ({
  status,
  body: { name, message: "The request failed.", debug_id: debugId, details: [{ issue: name }] },
});

let ids = 0;
const newId = () => `0000000${++ids}-aaaa-4bbb-8ccc-dddddddddddd`.slice(-36);

function expectNoSecret(value: unknown) {
  const text = JSON.stringify(value);
  expect(text).not.toContain(SECRET);
  expect(text).not.toContain("FAKE-ACCESS-TOKEN");
}

async function createdOrder(fake: ReturnType<typeof fakeCheckout>, productId: string) {
  const result = await createCheckoutOrder({ productId }, { paypal: fake.client(), newId });
  expect(result.status).toBe(200);
  return (result.body as { orderId: string }).orderId;
}

describe("create order", () => {
  it("prices the order from the catalog, whatever else the body holds", async () => {
    const fake = fakeCheckout();
    const result = await createCheckoutOrder(
      { productId: "floor-basket", price: "0.01", amount: { value: "0.01" }, quantity: 9 },
      { paypal: fake.client(), newId },
    );
    expect(result).toEqual({ status: 200, body: { orderId: expect.any(String) } });
    const [call] = fake.seen;
    const unit = ((call?.body?.purchase_units ?? []) as Json[])[0] as Json;
    expect(unit.custom_id).toBe("storefront:floor-basket");
    expect(unit.amount).toMatchObject({ currency_code: "USD", value: "240.00" });
    expect(unit.items).toEqual([
      expect.objectContaining({
        name: "Floor basket",
        quantity: "1",
        unit_amount: { currency_code: "USD", value: "240.00" },
      }),
    ]);
    expect(String(unit.reference_id)).toMatch(/^SHOP-[A-Z0-9]+$/);
    expect(call?.body?.payment_source).toBeUndefined();
    expect(fake.orders.has((result.body as { orderId: string }).orderId)).toBe(true);
  });

  it("uses a fresh request ID on every call", async () => {
    const fake = fakeCheckout();
    const paypal = fake.client();
    const first = await createCheckoutOrder({ productId: "coaster-set" }, { paypal, newId });
    const second = await createCheckoutOrder({ productId: "coaster-set" }, { paypal, newId });
    const [a, b] = fake.seen.map((call) => call.requestId);
    expect(a).toBeTruthy();
    expect(a).not.toBe(b);
    expect((first.body as { orderId: string }).orderId).not.toBe(
      (second.body as { orderId: string }).orderId,
    );
  });

  it.each([
    [{ productId: "golden-basket" }],
    [{ productId: "" }],
    [{}],
    [null],
    ["floor-basket"],
    [{ productId: 7 }],
  ])("refuses %j with a 400 and calls nothing", async (body) => {
    const fake = fakeCheckout();
    const result = await createCheckoutOrder(body, { paypal: fake.client(), newId });
    expect(result.status).toBe(400);
    expect((result.body as { error: string }).error).toMatch(/\.$/);
    expect(fake.seen).toHaveLength(0);
  });

  it("returns 502 with a plain message and the debug ID when PayPal fails", async () => {
    const fake = fakeCheckout();
    fake.state.fail = (call) =>
      call === "create" ? paypalError(500, "INTERNAL_SERVER_ERROR", "dbgcreate500") : undefined;
    const result = await createCheckoutOrder(
      { productId: "woven-tote" },
      { paypal: fake.client(), newId },
    );
    expect(result.status).toBe(502);
    expect(result.body).toEqual({ error: expect.any(String), debugId: "dbgcreate500" });
    expect((result.body as { error: string }).error).not.toMatch(/HTTP|INTERNAL_SERVER_ERROR/);
    expectNoSecret(result);
  });

  it("returns 503 when the PayPal variables are missing", async () => {
    const result = await createCheckoutOrder({ productId: "woven-tote" }, { paypal: undefined });
    expect(result.status).toBe(503);
    expect((result.body as { error: string }).error).toMatch(/\.$/);
  });
});

describe("capture order", () => {
  it("captures its own order and returns the real order ID, capture ID and amount", async () => {
    const fake = fakeCheckout();
    const orderId = await createdOrder(fake, "floor-basket");
    const result = await captureCheckoutOrder({ orderId }, { paypal: fake.client() });
    expect(result).toEqual({
      status: 200,
      body: {
        paid: true,
        orderId,
        captureId: `CAP${orderId.slice(-8)}`,
        amount: { minor: 24000, currency: "USD" },
      },
    });
    const calls = fake.seen.slice(1).map((call) => `${call.method} ${call.path}`);
    expect(calls).toEqual([
      `GET /v2/checkout/orders/${orderId}`,
      `POST /v2/checkout/orders/${orderId}/capture`,
    ]);
    expect(fake.captures()[0]?.requestId).toBe(`${CAPTURE_REQUEST_PREFIX}${orderId}`);
    expect(CAPTURE_REQUEST_PREFIX).toBe("countersign-storefront-capture-");
  });

  it("uses the same request ID for a double click, so PayPal replays one capture", async () => {
    const fake = fakeCheckout();
    const orderId = await createdOrder(fake, "coaster-set");
    const paypal = fake.client();
    const [first, second] = await Promise.all([
      captureCheckoutOrder({ orderId }, { paypal }),
      captureCheckoutOrder({ orderId }, { paypal }),
    ]);
    expect(first).toEqual(second);
    const requestIds = new Set(fake.captures().map((call) => call.requestId));
    expect(requestIds).toEqual(new Set([`countersign-storefront-capture-${orderId}`]));
  });

  it.each([
    ["too short", "ABC123"],
    ["lowercase", "5o190127tn364715t"],
    ["too long", "A".repeat(33)],
    ["a path", "5O190127TN364715T/../x"],
  ])("refuses an order ID that is %s with a 400 and calls nothing", async (_, orderId) => {
    const fake = fakeCheckout();
    const result = await captureCheckoutOrder({ orderId }, { paypal: fake.client() });
    expect(result.status).toBe(400);
    expect(fake.seen).toHaveLength(0);
  });

  it.each([
    [
      "a custom ID from the seed",
      { custom_id: "run1", amount: { currency_code: "USD", value: "48.00" } },
    ],
    [
      "an unknown product",
      { custom_id: "storefront:golden-basket", amount: { currency_code: "USD", value: "48.00" } },
    ],
    ["no custom ID", { amount: { currency_code: "USD", value: "48.00" } }],
    [
      "a lower amount than the product's price",
      {
        custom_id: "storefront:market-basket",
        amount: { currency_code: "USD", value: "0.01" },
      },
    ],
    [
      "a higher amount than the product's price",
      {
        custom_id: "storefront:coaster-set",
        amount: { currency_code: "USD", value: "48.00" },
      },
    ],
  ])("refuses an order with %s with a 400, capturing nothing", async (_, unit) => {
    const fake = fakeCheckout();
    fake.plant("8AB12345CD678901E", { reference_id: "default", ...unit });
    const result = await captureCheckoutOrder(
      { orderId: "8AB12345CD678901E" },
      { paypal: fake.client() },
    );
    expect(result.status).toBe(400);
    expect(fake.captures()).toHaveLength(0);
  });

  it("refuses an order with more than one purchase unit, capturing nothing", async () => {
    const fake = fakeCheckout();
    const unit = {
      custom_id: "storefront:market-basket",
      amount: { currency_code: "USD", value: "48.00" },
    };
    fake.plant("8AB12345CD678901E", { reference_id: "a", ...unit });
    const order = fake.orders.get("8AB12345CD678901E") as Json;
    (order.purchase_units as Json[]).push({ reference_id: "b", ...unit });
    const result = await captureCheckoutOrder(
      { orderId: "8AB12345CD678901E" },
      { paypal: fake.client() },
    );
    expect(result.status).toBe(400);
    expect(fake.captures()).toHaveLength(0);
  });

  it.each(["DECLINED", "PENDING"])("returns not paid with a %s capture", async (status) => {
    const fake = fakeCheckout();
    fake.state.captureStatus = status;
    const orderId = await createdOrder(fake, "clutch-bag");
    const result = await captureCheckoutOrder({ orderId }, { paypal: fake.client() });
    expect(result).toEqual({ status: 200, body: { paid: false, status } });
  });

  it("returns not paid when the completed capture is for the wrong amount", async () => {
    const fake = fakeCheckout();
    fake.state.captureValue = "1.00";
    const orderId = await createdOrder(fake, "wall-plate");
    const result = await captureCheckoutOrder({ orderId }, { paypal: fake.client() });
    expect(result).toEqual({ status: 200, body: { paid: false, status: "COMPLETED" } });
  });

  it.each(["get", "capture"] as const)(
    "returns 502 with the debug ID when the %s call fails",
    async (failing) => {
      const fake = fakeCheckout();
      const orderId = await createdOrder(fake, "bread-basket");
      fake.state.fail = (call) =>
        call === failing ? paypalError(422, "ORDER_NOT_APPROVED", `dbg${failing}`) : undefined;
      const result = await captureCheckoutOrder({ orderId }, { paypal: fake.client() });
      expect(result).toEqual({
        status: 502,
        body: { error: expect.any(String), debugId: `dbg${failing}` },
      });
      expectNoSecret(result);
      if (failing === "get") expect(fake.captures()).toHaveLength(0);
    },
  );

  it("returns 502 with a null debug ID when PayPal can't be reached", async () => {
    const paypal = createPayPalClient({
      env,
      fetch: async () => {
        throw new Error("connect ECONNREFUSED");
      },
      sleep: async () => {},
      now: () => 0,
    });
    const result = await captureCheckoutOrder({ orderId: "8AB12345CD678901E" }, { paypal });
    expect(result).toEqual({ status: 502, body: { error: expect.any(String), debugId: null } });
  });

  it("returns 503 when the PayPal variables are missing", async () => {
    const result = await captureCheckoutOrder(
      { orderId: "8AB12345CD678901E" },
      { paypal: undefined },
    );
    expect(result.status).toBe(503);
  });
});

describe("checkoutPayPal", () => {
  it("makes a client from complete sandbox variables", () => {
    expect(checkoutPayPal(env)).toBeDefined();
  });

  it.each([
    ["no variables", {}],
    ["no secret", { ...env, PAYPAL_CLIENT_SECRET: undefined }],
    ["a live base URL", { ...env, PAYPAL_BASE_URL: "https://api-m.paypal.com" }],
  ])("returns undefined with %s, so both routes answer 503", async (_, given) => {
    const paypal = checkoutPayPal(given);
    expect(paypal).toBeUndefined();
    const created = await createCheckoutOrder({ productId: "coaster-set" }, { paypal });
    const captured = await captureCheckoutOrder({ orderId: "8AB12345CD678901E" }, { paypal });
    expect([created.status, captured.status]).toEqual([503, 503]);
    expectNoSecret([created, captured]);
  });
});
