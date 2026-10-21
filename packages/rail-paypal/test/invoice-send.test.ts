import { type CreateDraftInvoiceInput, createPayPalClient } from "@countersign/rail-paypal";
import { describe, expect, it } from "vitest";
import {
  caught,
  expectNoSecrets,
  FAKE_TOKEN,
  fakePayPal,
  reply,
  sandboxEnv,
  testClient,
} from "./fake-paypal";

const INVOICE_ID = "INV2-ABCD-1234-WXYZ-5678";

function body(request: { body: string | null } | undefined): Record<string, unknown> {
  expect(request?.body).toBeTypeOf("string");
  return JSON.parse(request?.body ?? "null");
}

describe("send invoice", () => {
  it("posts only the fields given, with send_to_invoicer and no request ID", async () => {
    const fake = fakePayPal(() => reply(200, {}));
    await testClient(fake).sendInvoice({ invoiceId: INVOICE_ID, sendToRecipient: true });
    const [request] = fake.apiRequests();
    expect(request?.method).toBe("POST");
    expect(request?.path).toBe(`/v2/invoicing/invoices/${INVOICE_ID}/send`);
    expect(request?.headers["paypal-request-id"]).toBeUndefined();
    expect(body(request)).toEqual({ send_to_invoicer: true, send_to_recipient: true });
  });

  it("includes the note and additional recipients when given", async () => {
    const fake = fakePayPal(() => reply(200));
    await testClient(fake).sendInvoice({
      invoiceId: INVOICE_ID,
      sendToRecipient: false,
      note: "Thanks for your order.",
      additionalRecipients: ["ops@example.com"],
    });
    expect(body(fake.apiRequests()[0])).toEqual({
      send_to_invoicer: true,
      send_to_recipient: false,
      note: "Thanks for your order.",
      additional_recipients: ["ops@example.com"],
    });
  });

  it("returns SENT for 200 and SCHEDULED for 202", async () => {
    const input = { invoiceId: INVOICE_ID, sendToRecipient: true };
    const sent = fakePayPal(() => reply(200, { href: "https://x/y", rel: "self" }));
    expect(await testClient(sent).sendInvoice(input)).toBe("SENT");
    const scheduled = fakePayPal(() => reply(202, {}));
    expect(await testClient(scheduled).sendInvoice(input)).toBe("SCHEDULED");
  });

  it("throws a PayPalError with name and issues on a 4xx, without a retry", async () => {
    const fake = fakePayPal(() =>
      reply(422, {
        name: "UNPROCESSABLE_ENTITY",
        message: "The requested action could not be performed.",
        details: [{ issue: "INVALID_INVOICE_STATUS" }],
      }),
    );
    const error = await caught(
      testClient(fake).sendInvoice({ invoiceId: INVOICE_ID, sendToRecipient: true }),
    );
    expect(error.kind).toBe("http");
    expect(error.status).toBe(422);
    expect(error.paypalName).toBe("UNPROCESSABLE_ENTITY");
    expect(error.issues).toEqual(["INVALID_INVOICE_STATUS"]);
    expect(fake.apiRequests()).toHaveLength(1);
  });

  it("throws on a 5xx without a retry", async () => {
    const fake = fakePayPal(() => reply(503, { name: "SERVICE_UNAVAILABLE" }));
    const error = await caught(
      testClient(fake).sendInvoice({ invoiceId: INVOICE_ID, sendToRecipient: true }),
    );
    expect(error.status).toBe(503);
    expect(fake.apiRequests()).toHaveLength(1);
  });

  it("throws on a network failure without a retry", async () => {
    const fake = fakePayPal(() => reply(200));
    let calls = 0;
    const client = createPayPalClient({
      env: sandboxEnv,
      sleep: async () => {},
      fetch: async (url, init) => {
        if (new URL(url).pathname === "/v1/oauth2/token") return fake.fetch(url, init);
        calls += 1;
        throw new TypeError("fetch failed");
      },
    });
    const error = await caught(
      client.sendInvoice({ invoiceId: INVOICE_ID, sendToRecipient: true }),
    );
    expect(error.kind).toBe("network");
    expect(calls).toBe(1);
  });

  it("refuses a malformed invoice ID before calling PayPal", async () => {
    const fake = fakePayPal(() => reply(200));
    const error = await caught(
      testClient(fake).sendInvoice({ invoiceId: "../x", sendToRecipient: true }),
    );
    expect(error.kind).toBe("invalid_request");
    expect(fake.apiRequests()).toHaveLength(0);
  });

  it("refuses any other 2xx answer", async () => {
    const fake = fakePayPal(() => reply(204));
    const error = await caught(
      testClient(fake).sendInvoice({ invoiceId: INVOICE_ID, sendToRecipient: true }),
    );
    expect(error.kind).toBe("invalid_response");
  });

  it("never shows the token in an error", async () => {
    const fake = fakePayPal(() => reply(400, { name: "BAD", message: `echo ${FAKE_TOKEN}` }));
    const error = await caught(
      testClient(fake).sendInvoice({ invoiceId: INVOICE_ID, sendToRecipient: true }),
    );
    expectNoSecrets(error);
  });
});

describe("create draft invoice", () => {
  const input: CreateDraftInvoiceInput = {
    requestId: "countersign-seed-invoice-demo-draft",
    recipientEmail: "buyer@example.com",
    items: [{ name: "Backpack", quantity: 2, unitAmount: { minor: 12050, currency: "USD" } }],
  };

  it("posts minor units as PayPal amounts with the readable request ID", async () => {
    const fake = fakePayPal(() =>
      reply(201, {
        rel: "self",
        href: `https://api-m.sandbox.paypal.com/v2/invoicing/invoices/${INVOICE_ID}`,
        method: "GET",
      }),
    );
    const id = await testClient(fake).createDraftInvoice(input);
    expect(id).toBe(INVOICE_ID);
    const [request] = fake.apiRequests();
    expect(request?.path).toBe("/v2/invoicing/invoices");
    expect(request?.headers["paypal-request-id"]).toBe(input.requestId);
    expect(body(request)).toEqual({
      detail: { currency_code: "USD" },
      primary_recipients: [{ billing_info: { email_address: "buyer@example.com" } }],
      items: [
        { name: "Backpack", quantity: "2", unit_amount: { currency_code: "USD", value: "120.50" } },
      ],
    });
  });

  it("reads the ID from an invoice body too", async () => {
    const fake = fakePayPal(() => reply(201, { id: INVOICE_ID, status: "DRAFT" }));
    expect(await testClient(fake).createDraftInvoice(input)).toBe(INVOICE_ID);
  });

  it("throws on an answer without an ID, and on a 4xx", async () => {
    const junk = fakePayPal(() => reply(201, { hello: "x" }));
    expect((await caught(testClient(junk).createDraftInvoice(input))).kind).toBe(
      "invalid_response",
    );
    const refused = fakePayPal(() => reply(422, { name: "UNPROCESSABLE_ENTITY" }));
    expect((await caught(testClient(refused).createDraftInvoice(input))).status).toBe(422);
  });

  it("refuses a non-USD item", async () => {
    const fake = fakePayPal(() => reply(201, { id: INVOICE_ID }));
    const error = await caught(
      testClient(fake).createDraftInvoice({
        ...input,
        items: [{ name: "x", quantity: 1, unitAmount: { minor: 100, currency: "KES" } }],
      }),
    );
    expect(error.kind).toBe("invalid_request");
    expect(fake.apiRequests()).toHaveLength(0);
  });
});
