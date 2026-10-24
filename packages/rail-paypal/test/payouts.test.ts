import { type CreatePayoutInput, isDuplicateBatch, PayPalError } from "@countersign/rail-paypal";
import { describe, expect, it } from "vitest";
import { caught, fakePayPal, fixture, reply, testClient } from "./fake-paypal";

const BATCH_ID = "5UXD2E8A7EBQJ";
const ITEM_ID = "8AELMXH8UB2P8";
const INTENT_ID = "int_01JB7Q3M5N6P7R8S9T0V1W2X3Y";
const SUBJECT = "You have a payment from Kikapu Studio (illustrative)";

const payout: CreatePayoutInput = {
  requestId: "3f1c9a7e5b2d4f6a8c0e1b3d5f7a9c2e4b6d8f0a1c3e5b7d9f1a3c5e7b9d1f3a",
  senderBatchId: INTENT_ID,
  emailSubject: SUBJECT,
  receiver: "dyeworks@example.com",
  amount: { minor: 4500, currency: "USD" },
  note: "April dye order",
  senderItemId: "KDW-2026-0412",
};

function body(request: { body: string | null } | undefined): Record<string, unknown> {
  expect(request?.body).toBeTypeOf("string");
  return JSON.parse(request?.body ?? "null");
}

describe("create payout", () => {
  it("posts one item with the request ID, batch header and PayPal's amount string", async () => {
    const fake = fakePayPal(() => reply(201, fixture("create-payout-pending")));
    const created = await testClient(fake).createPayout(payout);
    expect(created).toEqual({ batchId: BATCH_ID, batchStatus: "PENDING" });
    const [request] = fake.apiRequests();
    expect(request?.method).toBe("POST");
    expect(request?.path).toBe("/v1/payments/payouts");
    expect(request?.headers["paypal-request-id"]).toBe(payout.requestId);
    expect(body(request)).toEqual({
      sender_batch_header: {
        sender_batch_id: INTENT_ID,
        recipient_type: "EMAIL",
        email_subject: SUBJECT,
      },
      items: [
        {
          recipient_type: "EMAIL",
          amount: { value: "45.00", currency: "USD" },
          receiver: "dyeworks@example.com",
          note: "April dye order",
          sender_item_id: "KDW-2026-0412",
        },
      ],
    });
  });

  it("leaves the note out when there is none", async () => {
    const fake = fakePayPal(() => reply(201, fixture("create-payout-pending")));
    const { note: _note, ...withoutNote } = payout;
    await testClient(fake).createPayout(withoutNote);
    const [item] = body(fake.apiRequests()[0]).items as Record<string, unknown>[];
    expect(item).not.toHaveProperty("note");
  });

  it("retries a 5xx with the same request ID, as other POSTs with one do", async () => {
    let calls = 0;
    const fake = fakePayPal(() => {
      calls += 1;
      return calls === 1
        ? reply(503, { name: "SERVICE_UNAVAILABLE" })
        : reply(201, fixture("create-payout-pending"));
    });
    const created = await testClient(fake).createPayout(payout);
    expect(created.batchId).toBe(BATCH_ID);
    const requests = fake.apiRequests();
    expect(requests).toHaveLength(2);
    expect(requests.map((r) => r.headers["paypal-request-id"])).toEqual([
      payout.requestId,
      payout.requestId,
    ]);
    expect(body(requests[1])).toEqual(body(requests[0]));
  });

  it("answers a 4xx with PayPal's error and no retry", async () => {
    const fake = fakePayPal(() => reply(400, fixture("error-400-duplicate-batch")));
    const error = await caught(testClient(fake).createPayout(payout));
    expect(error.kind).toBe("http");
    expect(error.status).toBe(400);
    expect(fake.apiRequests()).toHaveLength(1);
  });

  it("reads a 201 without a batch ID as an unreadable answer", async () => {
    const fake = fakePayPal(() => reply(201, { batch_header: { batch_status: "PENDING" } }));
    const error = await caught(testClient(fake).createPayout(payout));
    expect(error.kind).toBe("invalid_response");
    expect(error.field).toBe("batch_header.payout_batch_id");
  });

  const refusals: [string, Partial<Record<keyof CreatePayoutInput, unknown>>][] = [
    ["a currency other than USD", { amount: { minor: 4500, currency: "KES" } }],
    ["a zero amount", { amount: { minor: 0, currency: "USD" } }],
    ["a fractional amount", { amount: { minor: 45.5, currency: "USD" } }],
    ["a receiver that isn't an email", { receiver: "Kisumu Dye Works" }],
    ["an empty note", { note: "" }],
    ["a note over 4000 characters", { note: "n".repeat(4001) }],
    ["a sender_item_id that starts with a symbol", { senderItemId: "-KDW-0412" }],
    ["a sender_item_id with a space", { senderItemId: "KDW 0412" }],
    ["a sender_item_id over 63 characters", { senderItemId: "K".repeat(64) }],
    ["an empty sender_batch_id", { senderBatchId: "" }],
    ["a sender_batch_id over 256 characters", { senderBatchId: "b".repeat(257) }],
    ["an empty email subject", { emailSubject: "" }],
    ["no request ID", { requestId: undefined }],
    ["an empty request ID", { requestId: "" }],
  ];

  it.each(refusals)("refuses %s before calling PayPal", async (_name, change) => {
    const fake = fakePayPal(() => reply(201, fixture("create-payout-pending")));
    const error = await caught(
      testClient(fake).createPayout({ ...payout, ...change } as CreatePayoutInput),
    );
    expect(error.kind).toBe("invalid_request");
    expect(fake.requests).toHaveLength(0);
  });

  it("accepts the longest note and sender_item_id", async () => {
    const fake = fakePayPal(() => reply(201, fixture("create-payout-pending")));
    const senderItemId = `K${"0._/-".repeat(12)}12`;
    expect(senderItemId).toHaveLength(63);
    await testClient(fake).createPayout({ ...payout, note: "n".repeat(4000), senderItemId });
    expect(fake.apiRequests()).toHaveLength(1);
  });
});

describe("get payout batch", () => {
  it("reads the batch and its items in minor units, statuses as text", async () => {
    const fake = fakePayPal(() => reply(200, fixture("get-payout-batch")));
    const batch = await testClient(fake).getPayoutBatch(BATCH_ID);
    expect(fake.apiRequests()[0]?.method).toBe("GET");
    expect(fake.apiRequests()[0]?.path).toBe(`/v1/payments/payouts/${BATCH_ID}`);
    expect(batch).toEqual({
      batchId: BATCH_ID,
      batchStatus: "SUCCESS",
      senderBatchId: INTENT_ID,
      items: [
        {
          itemId: ITEM_ID,
          status: "UNCLAIMED",
          amount: { minor: 4500, currency: "USD" },
          receiver: "dyeworks@example.com",
          senderItemId: "KDW-2026-0412",
          errorName: "RECEIVER_UNREGISTERED",
        },
      ],
    });
  });

  it("keeps a status it doesn't know, and reads a batch with no items", async () => {
    const recorded = fixture("get-payout-batch");
    const header = recorded.batch_header as Record<string, unknown>;
    const fake = fakePayPal(() =>
      reply(200, { batch_header: { ...header, batch_status: "RECONCILING" } }),
    );
    const batch = await testClient(fake).getPayoutBatch(BATCH_ID);
    expect(batch.batchStatus).toBe("RECONCILING");
    expect(batch.items).toEqual([]);
  });

  it("refuses a malformed batch ID before calling PayPal", async () => {
    const fake = fakePayPal(() => reply(200, fixture("get-payout-batch")));
    const error = await caught(testClient(fake).getPayoutBatch("../payouts-item/x"));
    expect(error.kind).toBe("invalid_request");
    expect(fake.requests).toHaveLength(0);
  });
});

describe("get payout item", () => {
  it("reads an unclaimed item", async () => {
    const fake = fakePayPal(() => reply(200, fixture("get-payout-item-unclaimed")));
    const item = await testClient(fake).getPayoutItem(ITEM_ID);
    expect(fake.apiRequests()[0]?.method).toBe("GET");
    expect(fake.apiRequests()[0]?.path).toBe(`/v1/payments/payouts-item/${ITEM_ID}`);
    expect(item).toEqual({
      itemId: ITEM_ID,
      batchId: BATCH_ID,
      senderBatchId: INTENT_ID,
      status: "UNCLAIMED",
      amount: { minor: 4500, currency: "USD" },
      receiver: "dyeworks@example.com",
      senderItemId: "KDW-2026-0412",
      errorName: "RECEIVER_UNREGISTERED",
      timeProcessed: "2026-10-23T09:14:05Z",
    });
  });

  it("reads a succeeded item with no error", async () => {
    const fake = fakePayPal(() => reply(200, fixture("get-payout-item-succeeded")));
    const item = await testClient(fake).getPayoutItem(ITEM_ID);
    expect(item.status).toBe("SUCCESS");
    expect(item.errorName).toBeNull();
    expect(item.timeProcessed).toBe("2026-10-24T07:40:11Z");
  });

  it("keeps a status it doesn't know", async () => {
    const fake = fakePayPal(() =>
      reply(200, { ...fixture("get-payout-item-succeeded"), transaction_status: "ESCHEATED" }),
    );
    expect((await testClient(fake).getPayoutItem(ITEM_ID)).status).toBe("ESCHEATED");
  });

  it("reads an amount in a currency it can't hold as a read error", async () => {
    const recorded = fixture("get-payout-item-succeeded");
    const item = recorded.payout_item as Record<string, unknown>;
    const fake = fakePayPal(() =>
      reply(200, {
        ...recorded,
        payout_item: { ...item, amount: { currency: "EUR", value: "45.00" } },
      }),
    );
    const error = await caught(testClient(fake).getPayoutItem(ITEM_ID));
    expect(error.kind).toBe("invalid_response");
    expect(error.field).toBe("payout_item.amount");
  });

  it("reads an item without a status as a read error", async () => {
    const { transaction_status: _status, ...recorded } = fixture("get-payout-item-succeeded");
    const fake = fakePayPal(() => reply(200, recorded));
    const error = await caught(testClient(fake).getPayoutItem(ITEM_ID));
    expect(error.kind).toBe("invalid_response");
    expect(error.field).toBe("transaction_status");
  });
});

describe("isDuplicateBatch", () => {
  async function refusal(status: number, name: string): Promise<PayPalError> {
    const fake = fakePayPal(() => reply(status, fixture(name)));
    return caught(testClient(fake).createPayout(payout));
  }

  it("is true for PayPal's refusal of a reused sender_batch_id", async () => {
    expect(isDuplicateBatch(await refusal(400, "error-400-duplicate-batch"))).toBe(true);
  });

  it("is true for a 4xx whose name says DUPLICATE", () => {
    const error = new PayPalError({
      kind: "http",
      call: "create-payout",
      status: 422,
      paypalName: "DUPLICATE_REQUEST_ID",
    });
    expect(isDuplicateBatch(error)).toBe(true);
  });

  it.each([
    [403, "error-403-not-authorized"],
    [404, "error-404-resource-not-found"],
    [422, "error-422-capture-fully-refunded"],
    [422, "error-422-unprocessable"],
  ])("is false for the %i fixture %s", async (status, name) => {
    expect(isDuplicateBatch(await refusal(status, name))).toBe(false);
  });

  it("is false for a 5xx, a refusal before sending and anything that isn't a PayPalError", () => {
    const serverError = new PayPalError({
      kind: "http",
      call: "create-payout",
      status: 500,
      paypalName: "DUPLICATE_BATCH",
    });
    const refused = new PayPalError({
      kind: "invalid_request",
      call: "create-payout",
      status: null,
      reason: "senderBatchId is missing or invalid",
    });
    expect(isDuplicateBatch(serverError)).toBe(false);
    expect(isDuplicateBatch(refused)).toBe(false);
    expect(isDuplicateBatch(new Error("DUPLICATE"))).toBe(false);
    expect(isDuplicateBatch(null)).toBe(false);
  });
});
