import type { CreateOrderInput } from "@countersign/rail-paypal";
import { describe, expect, it } from "vitest";
import {
  caught,
  expectNoSecrets,
  FAKE_VAULT_TOKEN,
  fakePayPal,
  fixture,
  reply,
  testClient,
} from "./fake-paypal";

const VAULT_ORDER_ID = "2KT41359XA4728316";
const CAPTURE_ID = "8RH70421MV5531947";
const SHOP_ORDER_ID = "4UX98204FL1736522";

function body(request: { body: string | null } | undefined): Record<string, unknown> {
  expect(request?.body).toBeTypeOf("string");
  return JSON.parse(request?.body ?? "null");
}

const vaultOrder: CreateOrderInput = {
  requestId: "countersign-seed-demo01-KIK-1013-create",
  referenceId: "KIK-1013",
  customId: "demo01",
  invoiceId: "KIK-1013-demo01",
  items: [
    {
      name: "Market basket",
      sku: "market-basket",
      quantity: 1,
      unitAmount: { minor: 4800, currency: "USD" },
    },
  ],
  vaultId: FAKE_VAULT_TOKEN,
};

const approvalOrder: CreateOrderInput = {
  requestId: "countersign-storefront-create-H7WQ2D",
  referenceId: "SHOP-H7WQ2D",
  customId: "storefront:floor-basket",
  invoiceId: "SHOP-H7WQ2D",
  items: [
    {
      name: "Floor basket",
      sku: "floor-basket",
      quantity: 1,
      unitAmount: { minor: 24000, currency: "USD" },
    },
  ],
};

describe("create order", () => {
  it("sends one CAPTURE purchase unit paid by the vault token, with a matching breakdown", async () => {
    const fake = fakePayPal(() => reply(201, fixture("create-order-vault-completed")));
    await testClient(fake).createOrder(vaultOrder);

    const [request] = fake.apiRequests();
    expect(request?.method).toBe("POST");
    expect(request?.path).toBe("/v2/checkout/orders");
    expect(body(request)).toEqual({
      intent: "CAPTURE",
      purchase_units: [
        {
          reference_id: "KIK-1013",
          custom_id: "demo01",
          invoice_id: "KIK-1013-demo01",
          items: [
            {
              name: "Market basket",
              sku: "market-basket",
              quantity: "1",
              unit_amount: { currency_code: "USD", value: "48.00" },
            },
          ],
          amount: {
            currency_code: "USD",
            value: "48.00",
            breakdown: { item_total: { currency_code: "USD", value: "48.00" } },
          },
        },
      ],
      payment_source: { paypal: { vault_id: FAKE_VAULT_TOKEN } },
    });
  });

  it("totals several items and quantities into the amount and its breakdown", async () => {
    const fake = fakePayPal(() => reply(201, fixture("create-order-created")));
    await testClient(fake).createOrder({
      ...approvalOrder,
      items: [
        { name: "Coaster set", quantity: 2, unitAmount: { minor: 1800, currency: "USD" } },
        { name: "Bread basket", quantity: 1, unitAmount: { minor: 2400, currency: "USD" } },
      ],
    });
    const [unit] = body(fake.apiRequests()[0]).purchase_units as Record<string, unknown>[];
    expect(unit?.amount).toEqual({
      currency_code: "USD",
      value: "60.00",
      breakdown: { item_total: { currency_code: "USD", value: "60.00" } },
    });
  });

  it("sends no payment source for buyer approval", async () => {
    const fake = fakePayPal(() => reply(201, fixture("create-order-created")));
    await testClient(fake).createOrder(approvalOrder);
    expect(body(fake.apiRequests()[0])).not.toHaveProperty("payment_source");
  });

  it("parses a completed vault order with its capture and payer, and no vault token", async () => {
    const fake = fakePayPal(() => reply(201, fixture("create-order-vault-completed")));
    const order = await testClient(fake).createOrder(vaultOrder);
    expect(order).toEqual({
      id: VAULT_ORDER_ID,
      status: "COMPLETED",
      payerEmail: "buyer-a@example.com",
      payerId: "QYR5Z8XDVJNXQ",
      purchaseUnits: [
        {
          referenceId: "KIK-1013",
          customId: "demo01",
          invoiceId: "KIK-1013-demo01",
          amount: { minor: 4800, currency: "USD" },
          captures: [
            {
              id: CAPTURE_ID,
              status: "COMPLETED",
              amount: { minor: 4800, currency: "USD" },
              orderId: VAULT_ORDER_ID,
            },
          ],
          trackers: [],
          refunds: [],
        },
      ],
    });
    expectNoSecrets(order);
  });

  it("parses an order awaiting buyer approval with its status, amount in minor units", async () => {
    const fake = fakePayPal(() => reply(201, fixture("create-order-created")));
    const order = await testClient(fake).createOrder(approvalOrder);
    expect(order.id).toBe(SHOP_ORDER_ID);
    expect(order.status).toBe("CREATED");
    expect(order.payerEmail).toBeNull();
    expect(order.purchaseUnits[0]?.amount).toEqual({ minor: 24000, currency: "USD" });
    expect(order.purchaseUnits[0]?.captures).toEqual([]);
  });

  it("refuses a non-USD amount before any call", async () => {
    const fake = fakePayPal(() => reply(201, fixture("create-order-created")));
    const error = await caught(
      testClient(fake).createOrder({
        ...approvalOrder,
        items: [
          { name: "Floor basket", quantity: 1, unitAmount: { minor: 24000, currency: "KES" } },
        ],
      }),
    );
    expect(error.kind).toBe("invalid_request");
    expect(error.call).toBe("create-order");
    expect(error.message).toContain("USD");
    expect(fake.requests).toHaveLength(0);
  });

  it("refuses an order with no items, or a zero amount, before any call", async () => {
    const fake = fakePayPal(() => reply(201, fixture("create-order-created")));
    const paypal = testClient(fake);
    expect((await caught(paypal.createOrder({ ...approvalOrder, items: [] }))).kind).toBe(
      "invalid_request",
    );
    const zero = await caught(
      paypal.createOrder({
        ...approvalOrder,
        items: [{ name: "Free", quantity: 1, unitAmount: { minor: 0, currency: "USD" } }],
      }),
    );
    expect(zero.kind).toBe("invalid_request");
    expect(fake.requests).toHaveLength(0);
  });

  it("keeps the vault token out of a PayPal error that echoes it", async () => {
    const fake = fakePayPal(() =>
      reply(422, {
        name: "UNPROCESSABLE_ENTITY",
        message: `Vault ${FAKE_VAULT_TOKEN} is not usable`,
        debug_id: "f00dfeed12345",
        details: [{ issue: "PAYMENT_SOURCE_DECLINED_BY_PROCESSOR" }],
      }),
    );
    const error = await caught(testClient(fake).createOrder(vaultOrder));
    expect(error.status).toBe(422);
    expect(error.issues).toEqual(["PAYMENT_SOURCE_DECLINED_BY_PROCESSOR"]);
    expect(error.debugId).toBe("f00dfeed12345");
  });
});

describe("every POST", () => {
  const calls = {
    "create-order": {
      fixture: "create-order-vault-completed",
      run: (paypal: ReturnType<typeof testClient>) => paypal.createOrder(vaultOrder),
      requestId: vaultOrder.requestId,
    },
    "capture-order": {
      fixture: "capture-order-completed",
      run: (paypal: ReturnType<typeof testClient>) =>
        paypal.captureOrder(SHOP_ORDER_ID, { requestId: "countersign-storefront-capture-x" }),
      requestId: "countersign-storefront-capture-x",
    },
    "add-tracker": {
      fixture: "add-tracker",
      run: (paypal: ReturnType<typeof testClient>) =>
        paypal.addTracker(VAULT_ORDER_ID, {
          requestId: "countersign-seed-demo01-KIK-1013-track",
          captureId: CAPTURE_ID,
          trackingNumber: "KC-demo01-1013",
          carrierName: "Kisumu Couriers (simulated)",
        }),
      requestId: "countersign-seed-demo01-KIK-1013-track",
    },
  } as const;

  for (const [call, spec] of Object.entries(calls)) {
    it(`${call} sends the caller's request ID and Prefer: return=representation`, async () => {
      const fake = fakePayPal(() => reply(201, fixture(spec.fixture)));
      await spec.run(testClient(fake));
      const [request] = fake.apiRequests();
      expect(request?.method).toBe("POST");
      expect(request?.headers["paypal-request-id"]).toBe(spec.requestId);
      expect(request?.headers.prefer).toBe("return=representation");
      expect(request?.headers["content-type"]).toBe("application/json");
    });

    it(`${call} is retried on 429 and 5xx at most twice, with the same request ID`, async () => {
      const statuses = [503, 429, 500];
      const fake = fakePayPal(() => reply(statuses.shift() ?? 201, { name: "INTERNAL_ERROR" }));
      const error = await caught(spec.run(testClient(fake)));
      expect(error.status).toBe(500);
      expect(error.call).toBe(call);
      const requests = fake.apiRequests();
      expect(requests).toHaveLength(3);
      expect(new Set(requests.map((r) => r.headers["paypal-request-id"]))).toEqual(
        new Set([spec.requestId]),
      );
    });

    it(`${call} succeeds when a retry gets through`, async () => {
      let first = true;
      const fake = fakePayPal(() => {
        if (first) {
          first = false;
          return reply(503);
        }
        return reply(201, fixture(spec.fixture));
      });
      await spec.run(testClient(fake));
      expect(fake.apiRequests()).toHaveLength(2);
    });
  }

  it("refuses a POST without a request ID, at compile time and before any call", async () => {
    const fake = fakePayPal(() => reply(201, fixture("capture-order-completed")));
    const paypal = testClient(fake);
    // @ts-expect-error A POST must carry a PayPal-Request-Id.
    const missing = await caught(paypal.captureOrder(SHOP_ORDER_ID, {}));
    expect(missing.kind).toBe("invalid_request");
    const { requestId: _dropped, ...noRequestId } = vaultOrder;
    // @ts-expect-error A POST must carry a PayPal-Request-Id.
    const create = await caught(paypal.createOrder(noRequestId));
    expect(create.kind).toBe("invalid_request");
    const blank = await caught(paypal.captureOrder(SHOP_ORDER_ID, { requestId: "" }));
    expect(blank.kind).toBe("invalid_request");
    expect(fake.requests).toHaveLength(0);
  });
});

describe("capture order", () => {
  it("posts to the order's capture endpoint and parses the completed capture and payer", async () => {
    const fake = fakePayPal(() => reply(201, fixture("capture-order-completed")));
    const order = await testClient(fake).captureOrder(SHOP_ORDER_ID, {
      requestId: `countersign-storefront-capture-${SHOP_ORDER_ID}`,
    });
    expect(fake.apiRequests()[0]?.path).toBe(`/v2/checkout/orders/${SHOP_ORDER_ID}/capture`);
    expect(order.status).toBe("COMPLETED");
    expect(order.payerEmail).toBe("buyer-b@example.com");
    expect(order.purchaseUnits[0]?.customId).toBe("storefront:floor-basket");
    expect(order.purchaseUnits[0]?.captures).toEqual([
      {
        id: "6CW19580PB3374512",
        status: "COMPLETED",
        amount: { minor: 24000, currency: "USD" },
        orderId: SHOP_ORDER_ID,
      },
    ]);
  });

  it("refuses a malformed order ID before any call", async () => {
    const fake = fakePayPal(() => reply(201, fixture("capture-order-completed")));
    const error = await caught(
      testClient(fake).captureOrder("../payments", { requestId: "countersign-x" }),
    );
    expect(error.kind).toBe("invalid_request");
    expect(fake.requests).toHaveLength(0);
  });

  it("turns a 422 ORDER_NOT_APPROVED into an error with its issue code", async () => {
    const fake = fakePayPal(() => reply(422, fixture("error-422-unprocessable")));
    const error = await caught(
      testClient(fake).captureOrder(SHOP_ORDER_ID, { requestId: "countersign-x" }),
    );
    expect(error.call).toBe("capture-order");
    expect(error.status).toBe(422);
    expect(fake.apiRequests()).toHaveLength(1);
  });
});

describe("add tracker", () => {
  const tracker = {
    requestId: "countersign-seed-demo01-KIK-1013-track",
    captureId: CAPTURE_ID,
    trackingNumber: "KC-demo01-1013",
    carrierName: "Kisumu Couriers (simulated)",
  };

  it("sends the capture ID, tracking number, carrier OTHER with its name, and no payer notice", async () => {
    const fake = fakePayPal(() => reply(201, fixture("add-tracker")));
    await testClient(fake).addTracker(VAULT_ORDER_ID, tracker);
    const [request] = fake.apiRequests();
    expect(request?.path).toBe(`/v2/checkout/orders/${VAULT_ORDER_ID}/track`);
    expect(body(request)).toEqual({
      capture_id: CAPTURE_ID,
      tracking_number: "KC-demo01-1013",
      carrier: "OTHER",
      carrier_name_other: "Kisumu Couriers (simulated)",
      notify_payer: false,
    });
  });

  it("accepts PayPal's response, the order with its new tracker", async () => {
    const fake = fakePayPal(() => reply(201, fixture("add-tracker")));
    const order = await testClient(fake).addTracker(VAULT_ORDER_ID, tracker);
    expect(order.purchaseUnits[0]?.trackers).toEqual([
      {
        id: `${CAPTURE_ID}-KC-demo01-1013`,
        captureId: CAPTURE_ID,
        trackingNumber: "KC-demo01-1013",
        status: "SHIPPED",
      },
    ]);
  });

  it("refuses a malformed capture ID, tracking number or carrier name before any call", async () => {
    const fake = fakePayPal(() => reply(201, fixture("add-tracker")));
    const paypal = testClient(fake);
    for (const bad of [
      { ...tracker, captureId: "not a capture" },
      { ...tracker, trackingNumber: "" },
      { ...tracker, trackingNumber: "KC 1013" },
      { ...tracker, trackingNumber: "K".repeat(65) },
      { ...tracker, carrierName: "" },
    ]) {
      const error = await caught(paypal.addTracker(VAULT_ORDER_ID, bad));
      expect(error.kind).toBe("invalid_request");
      expect(error.call).toBe("add-tracker");
    }
    expect(fake.requests).toHaveLength(0);
  });
});

describe("get capture", () => {
  it("parses a capture with its order ID from supplementary_data.related_ids", async () => {
    const fake = fakePayPal(() => reply(200, fixture("get-capture")));
    const capture = await testClient(fake).getCapture(CAPTURE_ID);
    const [request] = fake.apiRequests();
    expect(request?.method).toBe("GET");
    expect(request?.path).toBe(`/v2/payments/captures/${CAPTURE_ID}`);
    expect(capture).toEqual({
      id: CAPTURE_ID,
      status: "COMPLETED",
      amount: { minor: 4800, currency: "USD" },
      orderId: VAULT_ORDER_ID,
    });
  });

  it("reads a missing order ID as null", async () => {
    const { supplementary_data: _gone, ...rest } = fixture("get-capture");
    const fake = fakePayPal(() => reply(200, rest));
    expect((await testClient(fake).getCapture(CAPTURE_ID)).orderId).toBeNull();
  });

  it("refuses a capture with no amount, naming the field", async () => {
    const { amount: _gone, ...rest } = fixture("get-capture");
    const fake = fakePayPal(() => reply(200, rest));
    const error = await caught(testClient(fake).getCapture(CAPTURE_ID));
    expect(error.kind).toBe("invalid_response");
    expect(error.call).toBe("get-capture");
    expect(error.field).toBe("amount");
  });

  it("is retried on 5xx like any GET", async () => {
    let first = true;
    const fake = fakePayPal(() => {
      if (first) {
        first = false;
        return reply(502);
      }
      return reply(200, fixture("get-capture"));
    });
    await testClient(fake).getCapture(CAPTURE_ID);
    expect(fake.apiRequests()).toHaveLength(2);
  });
});
