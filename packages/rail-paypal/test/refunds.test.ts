import { type PayPalOrder, type RefundCaptureInput, refundedTotal } from "@countersign/rail-paypal";
import { describe, expect, it } from "vitest";
import {
  caught,
  expectNoSecrets,
  FAKE_SECRET,
  FAKE_TOKEN,
  fakePayPal,
  fixture,
  reply,
  testClient,
} from "./fake-paypal";

const ORDER_ID = "2KT41359XA4728316";
const CAPTURE_ID = "8RH70421MV5531947";
const REFUND_ID = "1JU08902781691411";
const INTENT_HASH = "9f2c6a1e0b7d43a58c1f6e2d9b0a7c4e3f5d8a1b2c3e4f5a6b7c8d9e0f1a2b3c";

const refund: RefundCaptureInput = {
  captureId: CAPTURE_ID,
  amount: { minor: 1800, currency: "USD" },
  customId: "intent-kik-1013-demo",
  requestId: INTENT_HASH,
};

const completedRefund = {
  id: REFUND_ID,
  status: "COMPLETED",
  amount: { minor: 1800, currency: "USD" },
  captureId: CAPTURE_ID,
};

function body(request: { body: string | null } | undefined): Record<string, unknown> {
  expect(request?.body).toBeTypeOf("string");
  return JSON.parse(request?.body ?? "null");
}

describe("refund capture", () => {
  it("sends the amount in PayPal's format, custom_id and the caller's request ID", async () => {
    const fake = fakePayPal(() => reply(201, fixture("refund-capture-completed")));
    await testClient(fake).refundCapture(refund);
    const [request] = fake.apiRequests();
    expect(request?.method).toBe("POST");
    expect(request?.path).toBe(`/v2/payments/captures/${CAPTURE_ID}/refund`);
    expect(request?.headers["paypal-request-id"]).toBe(INTENT_HASH);
    expect(request?.headers.prefer).toBe("return=representation");
    expect(body(request)).toEqual({
      amount: { currency_code: "USD", value: "18.00" },
      custom_id: "intent-kik-1013-demo",
    });
  });

  it("returns the refund's ID, status, amount in minor units and capture from its up link", async () => {
    const fake = fakePayPal(() => reply(201, fixture("refund-capture-completed")));
    const record = await testClient(fake).refundCapture(refund);
    expect(record).toEqual(completedRefund);
    expectNoSecrets(record);
  });

  it("returns the same record when PayPal answers a replayed request ID with HTTP 200", async () => {
    let replays = 0;
    const fake = fakePayPal(() => {
      replays += 1;
      return reply(replays === 1 ? 201 : 200, fixture("refund-capture-completed"));
    });
    const paypal = testClient(fake);
    const first = await paypal.refundCapture(refund);
    const again = await paypal.refundCapture(refund);
    expect(again).toEqual(first);
    const ids = fake.apiRequests().map((r) => r.headers["paypal-request-id"]);
    expect(ids).toEqual([INTENT_HASH, INTENT_HASH]);
  });

  it("reads a refund with no up link as having no capture", async () => {
    const { links: _gone, ...rest } = fixture("refund-capture-completed");
    const fake = fakePayPal(() => reply(201, rest));
    expect((await testClient(fake).refundCapture(refund)).captureId).toBeNull();
  });

  it("is retried on 5xx with the same request ID", async () => {
    const statuses = [503, 201];
    const fake = fakePayPal(() =>
      reply(statuses.shift() ?? 201, fixture("refund-capture-completed")),
    );
    await testClient(fake).refundCapture(refund);
    const requests = fake.apiRequests();
    expect(requests).toHaveLength(2);
    expect(requests.map((r) => r.headers["paypal-request-id"])).toEqual([INTENT_HASH, INTENT_HASH]);
  });

  it.each<[string, RefundCaptureInput]>([
    ["a non-USD amount", { ...refund, amount: { minor: 1800, currency: "KES" } }],
    ["a zero amount", { ...refund, amount: { minor: 0, currency: "USD" } }],
    ["a fractional amount", { ...refund, amount: { minor: 18.5, currency: "USD" } }],
    ["a malformed capture ID", { ...refund, captureId: "../captures/x" }],
    ["an empty capture ID", { ...refund, captureId: "" }],
    ["a missing custom ID", { ...refund, customId: "" }],
    ["an empty request ID", { ...refund, requestId: "" }],
  ])("refuses %s as invalid_request before any call", async (_name, input) => {
    const fake = fakePayPal(() => reply(201, fixture("refund-capture-completed")));
    const error = await caught(testClient(fake).refundCapture(input));
    expect(error.kind).toBe("invalid_request");
    expect(error.call).toBe("refund-capture");
    expect(fake.requests).toHaveLength(0);
  });

  it("refuses a missing request ID, at compile time and before any call", async () => {
    const fake = fakePayPal(() => reply(201, fixture("refund-capture-completed")));
    const { requestId: _dropped, ...noRequestId } = refund;
    // @ts-expect-error A refund must carry a PayPal-Request-Id.
    const error = await caught(testClient(fake).refundCapture(noRequestId));
    expect(error.kind).toBe("invalid_request");
    expect(fake.requests).toHaveLength(0);
  });

  it("names a KES refund's problem as USD only", async () => {
    const fake = fakePayPal(() => reply(201, fixture("refund-capture-completed")));
    const error = await caught(
      testClient(fake).refundCapture({ ...refund, amount: { minor: 1800, currency: "KES" } }),
    );
    expect(error.message).toContain("USD");
  });

  it("turns a 422 refusal into an error with PayPal's name, issue and debug ID", async () => {
    const fake = fakePayPal(() => reply(422, fixture("error-422-capture-fully-refunded")));
    const error = await caught(testClient(fake).refundCapture(refund));
    expect(error.kind).toBe("http");
    expect(error.call).toBe("refund-capture");
    expect(error.status).toBe(422);
    expect(error.paypalName).toBe("UNPROCESSABLE_ENTITY");
    expect(error.issues).toEqual(["CAPTURE_FULLY_REFUNDED"]);
    expect(error.debugId).toBe("b81d4e07c2a95");
    expect(fake.apiRequests()).toHaveLength(1);
  });

  it("refuses a response with an unknown refund status", async () => {
    const fake = fakePayPal(() =>
      reply(201, { ...fixture("refund-capture-completed"), status: "REVERSED" }),
    );
    const error = await caught(testClient(fake).refundCapture(refund));
    expect(error.kind).toBe("invalid_response");
    expect(error.field).toBe("status");
  });
});

describe("get refund", () => {
  it("reads the refund by ID", async () => {
    const fake = fakePayPal(() => reply(200, fixture("refund-capture-completed")));
    const record = await testClient(fake).getRefund(REFUND_ID);
    const [request] = fake.apiRequests();
    expect(request?.method).toBe("GET");
    expect(request?.path).toBe(`/v2/payments/refunds/${REFUND_ID}`);
    expect(record).toEqual(completedRefund);
  });

  it("parses a PENDING refund", async () => {
    const fake = fakePayPal(() => reply(200, fixture("get-refund-pending")));
    expect(await testClient(fake).getRefund(REFUND_ID)).toEqual({
      ...completedRefund,
      status: "PENDING",
    });
  });

  it.each(["FAILED", "CANCELLED"])("parses a %s refund", async (status) => {
    const fake = fakePayPal(() => reply(200, { ...fixture("refund-capture-completed"), status }));
    expect((await testClient(fake).getRefund(REFUND_ID)).status).toBe(status);
  });

  it("turns a 404 into an error with PayPal's name, issue and debug ID", async () => {
    const fake = fakePayPal(() => reply(404, fixture("error-404-resource-not-found")));
    const error = await caught(testClient(fake).getRefund(REFUND_ID));
    expect(error.kind).toBe("http");
    expect(error.call).toBe("get-refund");
    expect(error.status).toBe(404);
    expect(error.paypalName).toBe("RESOURCE_NOT_FOUND");
    expect(error.issues).toEqual(["INVALID_RESOURCE_ID"]);
    expect(error.debugId).toBe("f2a6c1d93b7e4");
  });

  it("turns a 422 into an error with PayPal's name, issue and debug ID", async () => {
    const fake = fakePayPal(() => reply(422, fixture("error-422-unprocessable")));
    const error = await caught(testClient(fake).getRefund(REFUND_ID));
    expect(error.status).toBe(422);
    expect(error.paypalName).toBe("UNPROCESSABLE_ENTITY");
    expect(error.issues).toEqual(["ORDER_NOT_APPROVED"]);
    expect(error.debugId).toBe("9c3e5b0a71d28");
  });

  it("refuses a malformed refund ID before any call", async () => {
    const fake = fakePayPal(() => reply(200, fixture("refund-capture-completed")));
    const error = await caught(testClient(fake).getRefund("../refunds"));
    expect(error.kind).toBe("invalid_request");
    expect(fake.requests).toHaveLength(0);
  });

  it("refuses a refund with no amount, naming the field", async () => {
    const { amount: _gone, ...rest } = fixture("refund-capture-completed");
    const fake = fakePayPal(() => reply(200, rest));
    const error = await caught(testClient(fake).getRefund(REFUND_ID));
    expect(error.kind).toBe("invalid_response");
    expect(error.field).toBe("amount");
  });
});

type RefundJson = Record<string, unknown>;

function refundJson(id: string, value: string, status: string, captureId?: string): RefundJson {
  return {
    id,
    amount: { currency_code: "USD", value },
    status,
    links: [
      { href: `https://api.sandbox.paypal.com/v2/payments/refunds/${id}`, rel: "self" },
      ...(captureId
        ? [{ href: `https://api.sandbox.paypal.com/v2/payments/captures/${captureId}`, rel: "up" }]
        : []),
    ],
  };
}

function captureJson(id: string, value: string): Record<string, unknown> {
  return { id, status: "COMPLETED", amount: { currency_code: "USD", value } };
}

// The order fixture with its one purchase unit's payments replaced.
function orderWith(payments: Record<string, unknown>): Record<string, unknown> {
  const order = fixture("get-order-refunded");
  const [unit] = order.purchase_units as Record<string, unknown>[];
  return { ...order, purchase_units: [{ ...unit, payments }] };
}

async function readOrder(json: Record<string, unknown>): Promise<PayPalOrder> {
  const fake = fakePayPal(() => reply(200, json));
  return testClient(fake).getOrder(ORDER_ID);
}

describe("refunds on orders", () => {
  it("carries each purchase unit's refunds as refund records", async () => {
    const order = await readOrder(fixture("get-order-refunded"));
    expect(order.purchaseUnits[0]?.refunds).toEqual([
      completedRefund,
      {
        id: "5LH23991AC0148805",
        status: "PENDING",
        amount: { minor: 600, currency: "USD" },
        captureId: CAPTURE_ID,
      },
      {
        id: "9TB61470DK2290043",
        status: "FAILED",
        amount: { minor: 1000, currency: "USD" },
        captureId: CAPTURE_ID,
      },
    ]);
  });

  it("counts COMPLETED and PENDING refunds in a capture's refunded total, not FAILED", async () => {
    const order = await readOrder(fixture("get-order-refunded"));
    expect(refundedTotal(order, CAPTURE_ID)).toBe(2400);
  });

  it("doesn't count a CANCELLED refund", async () => {
    const order = await readOrder(
      orderWith({
        captures: [captureJson(CAPTURE_ID, "48.00")],
        refunds: [refundJson("R1", "18.00", "CANCELLED", CAPTURE_ID)],
      }),
    );
    expect(refundedTotal(order, CAPTURE_ID)).toBe(0);
  });

  it("gives an order with no refunds an empty list and a zero total", async () => {
    const order = await readOrder(fixture("get-order-completed"));
    expect(order.purchaseUnits[0]?.refunds).toEqual([]);
    expect(refundedTotal(order, "3JM25846XW7943026")).toBe(0);
  });

  it("counts an unattributable refund against a unit's only capture", async () => {
    const order = await readOrder(
      orderWith({
        captures: [captureJson(CAPTURE_ID, "48.00")],
        refunds: [refundJson("R1", "18.00", "COMPLETED")],
      }),
    );
    expect(order.purchaseUnits[0]?.refunds[0]?.captureId).toBeNull();
    expect(refundedTotal(order, CAPTURE_ID)).toBe(1800);
  });

  it("counts attributed refunds only against their own capture when a unit has several", async () => {
    const order = await readOrder(
      orderWith({
        captures: [captureJson(CAPTURE_ID, "48.00"), captureJson("CAP2", "20.00")],
        refunds: [
          refundJson("R1", "18.00", "COMPLETED", CAPTURE_ID),
          refundJson("R2", "5.00", "PENDING", "CAP2"),
        ],
      }),
    );
    expect(refundedTotal(order, CAPTURE_ID)).toBe(1800);
    expect(refundedTotal(order, "CAP2")).toBe(500);
  });

  it("makes every capture's total unknown when an unattributable refund sits among several", async () => {
    const order = await readOrder(
      orderWith({
        captures: [captureJson(CAPTURE_ID, "48.00"), captureJson("CAP2", "20.00")],
        refunds: [
          refundJson("R1", "18.00", "COMPLETED", CAPTURE_ID),
          refundJson("R2", "5.00", "COMPLETED"),
        ],
      }),
    );
    expect(refundedTotal(order, CAPTURE_ID)).toBeNull();
    expect(refundedTotal(order, "CAP2")).toBeNull();
  });

  it("ignores an unattributable refund that doesn't count, even among several captures", async () => {
    const order = await readOrder(
      orderWith({
        captures: [captureJson(CAPTURE_ID, "48.00"), captureJson("CAP2", "20.00")],
        refunds: [refundJson("R2", "5.00", "FAILED")],
      }),
    );
    expect(refundedTotal(order, CAPTURE_ID)).toBe(0);
  });

  it("makes the total unknown for a capture that isn't on the order", async () => {
    const order = await readOrder(fixture("get-order-refunded"));
    expect(refundedTotal(order, "9ZZ00000000000000")).toBeNull();
  });

  it("makes the total unknown when a counted refund is in another currency", async () => {
    const kes = { ...refundJson("R1", "18.00", "COMPLETED", CAPTURE_ID) };
    kes.amount = { currency_code: "KES", value: "18.00" };
    const order = await readOrder(
      orderWith({ captures: [captureJson(CAPTURE_ID, "48.00")], refunds: [kes] }),
    );
    expect(refundedTotal(order, CAPTURE_ID)).toBeNull();
  });

  it("refuses an order whose refund has an unknown status, naming the field", async () => {
    const fake = fakePayPal(() =>
      reply(
        200,
        orderWith({
          captures: [captureJson(CAPTURE_ID, "48.00")],
          refunds: [refundJson("R1", "18.00", "REVERSED", CAPTURE_ID)],
        }),
      ),
    );
    const error = await caught(testClient(fake).getOrder(ORDER_ID));
    expect(error.kind).toBe("invalid_response");
    expect(error.field).toBe("purchase_units[0].payments.refunds[0].status");
  });
});

describe("refund calls and secrets", () => {
  it("keep the secret and access token out of every request, error and return value", async () => {
    const fake = fakePayPal((req) => {
      if (req.path.endsWith("/refund")) {
        return reply(422, {
          ...fixture("error-422-capture-fully-refunded"),
          message: `Token ${FAKE_TOKEN} and ${FAKE_SECRET} rejected`,
        });
      }
      if (req.path.startsWith("/v2/payments/refunds/")) {
        return reply(200, fixture("get-refund-pending"));
      }
      return reply(200, fixture("get-order-refunded"));
    });
    const paypal = testClient(fake);
    const error = await caught(paypal.refundCapture(refund));
    expect(error.paypalMessage).toContain("[redacted]");
    expectNoSecrets(await paypal.getRefund(REFUND_ID));
    expectNoSecrets(await paypal.getOrder(ORDER_ID));
    for (const request of fake.apiRequests()) {
      expect(request.body ?? "").not.toContain(FAKE_SECRET);
      expect(request.body ?? "").not.toContain(FAKE_TOKEN);
      expect(request.url).not.toContain(FAKE_TOKEN);
    }
  });
});
