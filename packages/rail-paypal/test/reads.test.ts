import {
  type TransactionSearchInput,
  toPayPalAmount,
  toPayPalDisplayAmount,
} from "@countersign/rail-paypal";
import { describe, expect, it } from "vitest";
import {
  caught,
  expectNoSecrets,
  FAKE_SECRET,
  FAKE_TOKEN,
  fakePayPal,
  fixture,
  reply,
  type SeenRequest,
  testClient,
} from "./fake-paypal";

// Phase 7's reads: get dispute, get invoice, transaction search (ADR 0028) and the merchant's
// disputes, for the read-only list_disputes tool.

const DISPUTE_ID = "PP-R-NKG-10049671";
const INVOICE_ID = "INV2-Z56S-5LLA-Q52L-CPZ5";
const CAPTURE_ID = "8RH70421MV5531947";

function query(request: SeenRequest | undefined): URLSearchParams {
  return new URL(request?.url ?? "https://invalid.example").searchParams;
}

const failures = [
  { status: 404, file: "error-404-resource-not-found", name: "RESOURCE_NOT_FOUND" },
  { status: 403, file: "error-403-not-authorized", name: "NOT_AUTHORIZED" },
] as const;

const range: TransactionSearchInput = {
  startDate: "2026-10-01T00:00:00Z",
  endDate: "2026-10-18T00:00:00Z",
};

// Each new call, so the shared failure cases run against all three.
const calls = [
  {
    call: "list-merchant-disputes",
    ok: () => reply(200, fixture("list-disputes-page-2")),
    run: (client: ReturnType<typeof testClient>) => client.listMerchantDisputes({ pageSize: 10 }),
  },
  {
    call: "get-dispute",
    ok: () => reply(200, fixture("get-dispute")),
    run: (client: ReturnType<typeof testClient>) => client.getDispute(DISPUTE_ID),
  },
  {
    call: "get-invoice",
    ok: () => reply(200, fixture("get-invoice")),
    run: (client: ReturnType<typeof testClient>) => client.getInvoice(INVOICE_ID),
  },
  {
    call: "search-transactions",
    ok: () => reply(200, fixture("search-transactions")),
    run: (client: ReturnType<typeof testClient>) => client.searchTransactions(range),
  },
] as const;

describe("get dispute", () => {
  it("reads the dispute by ID: status, amount in minor units and disputed captures", async () => {
    const fake = fakePayPal(() => reply(200, fixture("get-dispute")));
    const record = await testClient(fake).getDispute(DISPUTE_ID);
    const [request] = fake.apiRequests();
    expect(request?.method).toBe("GET");
    expect(request?.path).toBe(`/v1/customer/disputes/${DISPUTE_ID}`);
    expect(record).toEqual({
      id: DISPUTE_ID,
      status: "WAITING_FOR_SELLER_RESPONSE",
      reason: "MERCHANDISE_OR_SERVICE_NOT_RECEIVED",
      lifeCycleStage: "INQUIRY",
      amount: { minor: 1800, currency: "USD" },
      sellerResponseDueDate: "2026-10-26T09:12:44.000Z",
      captureIds: [CAPTURE_ID],
      linkNames: ["self", "accept_claim"],
    });
    expectNoSecrets(record);
  });

  it("reads a dispute under review: no due date, every link PayPal offers by name", async () => {
    const fake = fakePayPal(() => reply(200, fixture("get-dispute-under-review")));
    const record = await testClient(fake).getDispute("PP-D-27803");
    expect(record).toMatchObject({
      status: "UNDER_REVIEW",
      lifeCycleStage: "CHARGEBACK",
      amount: { minor: 24000, currency: "USD" },
      sellerResponseDueDate: null,
      captureIds: ["3C679366HH908993F"],
      linkNames: [
        "self",
        "provide_evidence",
        "accept_claim",
        "make_offer",
        "require_evidence",
        "adjudicate",
      ],
    });
  });

  it("keeps unknown reasons, stages and link names as text, and reads no links as none", async () => {
    const { links: _gone, seller_response_due_date: _due, ...rest } = fixture("get-dispute");
    const fake = fakePayPal(() =>
      reply(200, { ...rest, reason: "SOME_NEW_REASON", dispute_life_cycle_stage: "NEW_STAGE" }),
    );
    const record = await testClient(fake).getDispute(DISPUTE_ID);
    expect(record).toMatchObject({
      reason: "SOME_NEW_REASON",
      lifeCycleStage: "NEW_STAGE",
      sellerResponseDueDate: null,
      linkNames: [],
    });
  });

  it("refuses a dispute with no reason or life-cycle stage, naming the field", async () => {
    for (const field of ["reason", "dispute_life_cycle_stage"]) {
      const { [field]: _gone, ...rest } = fixture("get-dispute");
      const fake = fakePayPal(() => reply(200, rest));
      const error = await caught(testClient(fake).getDispute(DISPUTE_ID));
      expect(error.kind).toBe("invalid_response");
      expect(error.field).toBe(field);
    }
  });

  it("reads a dispute with no disputed transactions as naming no captures", async () => {
    const { disputed_transactions: _gone, ...rest } = fixture("get-dispute");
    const fake = fakePayPal(() => reply(200, rest));
    expect((await testClient(fake).getDispute(DISPUTE_ID)).captureIds).toEqual([]);
  });

  it("refuses a dispute with no amount, naming the field", async () => {
    const { dispute_amount: _gone, ...rest } = fixture("get-dispute");
    const fake = fakePayPal(() => reply(200, rest));
    const error = await caught(testClient(fake).getDispute(DISPUTE_ID));
    expect(error.kind).toBe("invalid_response");
    expect(error.field).toBe("dispute_amount");
  });

  it("refuses a malformed dispute ID before any call", async () => {
    const fake = fakePayPal(() => reply(200, fixture("get-dispute")));
    const error = await caught(testClient(fake).getDispute("PP-D/../1"));
    expect(error.kind).toBe("invalid_request");
    expect(fake.requests).toHaveLength(0);
  });
});

describe("the merchant's disputes", () => {
  it("reads one page with the page size and state, and says when more pages exist", async () => {
    const fake = fakePayPal(() => reply(200, fixture("list-disputes-page-1")));
    const list = await testClient(fake).listMerchantDisputes({
      pageSize: 5,
      disputeState: "REQUIRED_ACTION",
    });
    const [request] = fake.apiRequests();
    expect(request?.method).toBe("GET");
    expect(request?.path).toBe("/v1/customer/disputes");
    expect(query(request).get("page_size")).toBe("5");
    expect(query(request).get("dispute_state")).toBe("REQUIRED_ACTION");
    expect(query(request).has("disputed_transaction_id")).toBe(false);
    expect(list).toEqual({
      disputes: [{ id: DISPUTE_ID, status: "WAITING_FOR_SELLER_RESPONSE" }],
      complete: false,
    });
    expect(fake.apiRequests()).toHaveLength(1);
  });

  it("reads a last page as complete, and sends no state when none is asked for", async () => {
    const fake = fakePayPal(() => reply(200, fixture("list-disputes-page-2")));
    const list = await testClient(fake).listMerchantDisputes({ pageSize: 10 });
    expect(query(fake.apiRequests()[0]).has("dispute_state")).toBe(false);
    expect(list.complete).toBe(true);
  });

  it.each([
    ["a page size of 0", { pageSize: 0 }],
    ["a page size over 50", { pageSize: 51 }],
    ["an unknown state", { pageSize: 10, disputeState: "OPEN" }],
  ])("refuses %s before any call", async (_label, input) => {
    const fake = fakePayPal(() => reply(200, fixture("list-disputes-page-2")));
    const error = await caught(
      testClient(fake).listMerchantDisputes(
        input as Parameters<ReturnType<typeof testClient>["listMerchantDisputes"]>[0],
      ),
    );
    expect(error.kind).toBe("invalid_request");
    expect(fake.requests).toHaveLength(0);
  });
});

describe("PayPal amounts", () => {
  it("shows USD and KES with two decimals, and sends only USD", () => {
    expect(toPayPalDisplayAmount({ minor: 4800, currency: "USD" })).toEqual({
      currency_code: "USD",
      value: "48.00",
    });
    expect(toPayPalDisplayAmount({ minor: 450005, currency: "KES" })).toEqual({
      currency_code: "KES",
      value: "4500.05",
    });
    expect(toPayPalAmount({ minor: 450000, currency: "KES" })).toBeNull();
    expect(toPayPalAmount({ minor: 123456789, currency: "USD" })).toEqual({
      currency_code: "USD",
      value: "1234567.89",
    });
    expect(toPayPalDisplayAmount({ minor: 0, currency: "USD" })).toBeNull();
    expect(toPayPalDisplayAmount({ minor: 1.5, currency: "USD" })).toBeNull();
  });
});

describe("get invoice", () => {
  it("reads the invoice by ID: status, amount, invoice number and recipient emails", async () => {
    const fake = fakePayPal(() => reply(200, fixture("get-invoice")));
    const record = await testClient(fake).getInvoice(INVOICE_ID);
    const [request] = fake.apiRequests();
    expect(request?.method).toBe("GET");
    expect(request?.path).toBe(`/v2/invoicing/invoices/${INVOICE_ID}`);
    expect(record).toEqual({
      id: INVOICE_ID,
      status: "SENT",
      amount: { minor: 4800, currency: "USD" },
      invoiceNumber: "KIK-INV-0042",
      recipientEmails: ["amina.buyer@example.com", "accounts@example.com"],
    });
    expectNoSecrets(record);
  });

  it("reads an invoice with no number and no recipients", async () => {
    const invoice = fixture("get-invoice");
    const { primary_recipients: _p, additional_recipients: _a, ...rest } = invoice;
    const detail = { ...(invoice.detail as Record<string, unknown>), invoice_number: undefined };
    const fake = fakePayPal(() => reply(200, { ...rest, detail }));
    const record = await testClient(fake).getInvoice(INVOICE_ID);
    expect(record.invoiceNumber).toBeNull();
    expect(record.recipientEmails).toEqual([]);
  });

  it("refuses an invoice with no amount, naming the field", async () => {
    const { amount: _gone, ...rest } = fixture("get-invoice");
    const fake = fakePayPal(() => reply(200, rest));
    const error = await caught(testClient(fake).getInvoice(INVOICE_ID));
    expect(error.kind).toBe("invalid_response");
    expect(error.field).toBe("amount");
  });

  it("refuses a malformed invoice ID before any call", async () => {
    const fake = fakePayPal(() => reply(200, fixture("get-invoice")));
    const error = await caught(testClient(fake).getInvoice("INV2 Z56S"));
    expect(error.kind).toBe("invalid_request");
    expect(fake.requests).toHaveLength(0);
  });
});

describe("transaction search", () => {
  it("sends the range and returns each transaction's ID, status, amount and time", async () => {
    const fake = fakePayPal(() => reply(200, fixture("search-transactions")));
    const page = await testClient(fake).searchTransactions(range);
    const [request] = fake.apiRequests();
    expect(request?.method).toBe("GET");
    expect(request?.path).toBe("/v1/reporting/transactions");
    expect(query(request).get("start_date")).toBe("2026-10-01T00:00:00.000Z");
    expect(query(request).get("end_date")).toBe("2026-10-18T00:00:00.000Z");
    expect(query(request).get("fields")).toBe("transaction_info");
    expect(query(request).has("transaction_id")).toBe(false);
    expect(page).toEqual({
      transactions: [
        {
          id: CAPTURE_ID,
          status: "S",
          amount: { minor: 1800, currency: "USD" },
          direction: "credit",
          initiatedAt: "2026-10-12T14:20:01.000Z",
        },
        {
          id: "1JU08902781691411",
          status: "S",
          amount: { minor: 1800, currency: "USD" },
          direction: "debit",
          initiatedAt: "2026-10-14T10:02:33.000Z",
        },
      ],
      complete: true,
    });
    expectNoSecrets(page);
  });

  it("filters by transaction ID and reads a range given with offsets", async () => {
    const fake = fakePayPal(() => reply(200, fixture("search-transactions")));
    await testClient(fake).searchTransactions({
      startDate: "2026-10-01T03:00:00+03:00",
      endDate: "2026-11-01T03:00:00+03:00",
      transactionId: CAPTURE_ID,
    });
    const [request] = fake.apiRequests();
    expect(query(request).get("transaction_id")).toBe(CAPTURE_ID);
    expect(query(request).get("start_date")).toBe("2026-10-01T00:00:00.000Z");
    expect(query(request).get("end_date")).toBe("2026-11-01T00:00:00.000Z");
  });

  it("reads an empty page as complete with no transactions", async () => {
    const { transaction_details: _gone, ...rest } = fixture("search-transactions");
    const fake = fakePayPal(() => reply(200, { ...rest, total_items: 0, total_pages: 0 }));
    expect(await testClient(fake).searchTransactions(range)).toEqual({
      transactions: [],
      complete: true,
    });
  });

  it("marks a page incomplete when more pages exist", async () => {
    const fake = fakePayPal(() =>
      reply(200, { ...fixture("search-transactions"), total_items: 250, total_pages: 3 }),
    );
    expect((await testClient(fake).searchTransactions(range)).complete).toBe(false);
  });

  it.each([
    [
      "a range over 31 days",
      { startDate: "2026-09-01T00:00:00Z", endDate: "2026-10-02T00:00:01Z" },
    ],
    [
      "an end before the start",
      { startDate: "2026-10-18T00:00:00Z", endDate: "2026-10-01T00:00:00Z" },
    ],
    ["an unreadable start date", { startDate: "last week", endDate: "2026-10-18T00:00:00Z" }],
    [
      "an impossible end date",
      { startDate: "2026-10-01T00:00:00Z", endDate: "2026-10-32T00:00:00Z" },
    ],
    ["a malformed transaction ID", { ...range, transactionId: "8RH7/../x" }],
  ])("refuses %s before any call", async (_label, input) => {
    const fake = fakePayPal(() => reply(200, fixture("search-transactions")));
    const error = await caught(testClient(fake).searchTransactions(input));
    expect(error.kind).toBe("invalid_request");
    expect(error.call).toBe("search-transactions");
    expect(fake.requests).toHaveLength(0);
  });

  it("accepts a range of exactly 31 days", async () => {
    const fake = fakePayPal(() => reply(200, fixture("search-transactions")));
    await testClient(fake).searchTransactions({
      startDate: "2026-09-17T00:00:00Z",
      endDate: "2026-10-18T00:00:00Z",
    });
    expect(fake.apiRequests()).toHaveLength(1);
  });

  it("refuses a transaction with an unreadable initiation time, naming the field", async () => {
    const page = fixture("search-transactions");
    const [first] = page.transaction_details as { transaction_info: Record<string, unknown> }[];
    const broken = {
      transaction_info: { ...first?.transaction_info, transaction_initiation_date: "yesterday" },
    };
    const fake = fakePayPal(() => reply(200, { ...page, transaction_details: [broken] }));
    const error = await caught(testClient(fake).searchTransactions(range));
    expect(error.kind).toBe("invalid_response");
    expect(error.field).toBe("transaction_details[0].transaction_info.transaction_initiation_date");
  });
});

describe("unsupported currencies", () => {
  const eur = { currency_code: "EUR", value: "18.00" };

  it("make a dispute unreadable", async () => {
    const fake = fakePayPal(() => reply(200, { ...fixture("get-dispute"), dispute_amount: eur }));
    const error = await caught(testClient(fake).getDispute(DISPUTE_ID));
    expect(error.kind).toBe("invalid_response");
    expect(error.field).toBe("dispute_amount");
  });

  it("make an invoice unreadable", async () => {
    const fake = fakePayPal(() => reply(200, { ...fixture("get-invoice"), amount: eur }));
    const error = await caught(testClient(fake).getInvoice(INVOICE_ID));
    expect(error.kind).toBe("invalid_response");
    expect(error.field).toBe("amount");
  });

  it("make a transaction page unreadable", async () => {
    const page = fixture("search-transactions");
    const [first] = page.transaction_details as { transaction_info: Record<string, unknown> }[];
    const foreign = { transaction_info: { ...first?.transaction_info, transaction_amount: eur } };
    const fake = fakePayPal(() => reply(200, { ...page, transaction_details: [foreign] }));
    const error = await caught(testClient(fake).searchTransactions(range));
    expect(error.kind).toBe("invalid_response");
    expect(error.field).toBe("transaction_details[0].transaction_info.transaction_amount");
  });

  it("allow KES", async () => {
    const kes = { currency_code: "KES", value: "4500.00" };
    const fake = fakePayPal(() => reply(200, { ...fixture("get-invoice"), amount: kes }));
    expect((await testClient(fake).getInvoice(INVOICE_ID)).amount).toEqual({
      minor: 450000,
      currency: "KES",
    });
  });
});

describe.each(calls)("$call failures", ({ call, ok, run }) => {
  it.each(failures)(
    "turns a $status into an error with PayPal's name, issues and debug ID",
    async (failure) => {
      const fake = fakePayPal(() => reply(failure.status, fixture(failure.file)));
      const error = await caught(run(testClient(fake)));
      expect(error.kind).toBe("http");
      expect(error.call).toBe(call);
      expect(error.status).toBe(failure.status);
      expect(error.paypalName).toBe(failure.name);
      expect(error.issues.length).toBeGreaterThan(0);
      expect(error.debugId).toMatch(/^[0-9a-f]+$/);
      expect(fake.apiRequests()).toHaveLength(1);
    },
  );

  it("is retried on 5xx at most twice, then fails with PayPal's name and debug ID", async () => {
    const fake = fakePayPal(() =>
      reply(503, { name: "SERVICE_UNAVAILABLE", debug_id: "5e1a0c3f9b2d7", details: [] }),
    );
    const error = await caught(run(testClient(fake)));
    expect(fake.apiRequests()).toHaveLength(3);
    expect(error.status).toBe(503);
    expect(error.paypalName).toBe("SERVICE_UNAVAILABLE");
    expect(error.debugId).toBe("5e1a0c3f9b2d7");
  });

  it("succeeds when a retry gets through", async () => {
    let n = 0;
    const fake = fakePayPal(() => {
      n += 1;
      return n === 1 ? reply(500, {}) : ok();
    });
    expectNoSecrets(await run(testClient(fake)));
    expect(fake.apiRequests()).toHaveLength(2);
  });

  it("keeps the secret and access token out of requests, errors and return values", async () => {
    const leaky = fakePayPal(() =>
      reply(404, {
        ...fixture("error-404-resource-not-found"),
        message: `Token ${FAKE_TOKEN} and ${FAKE_SECRET} rejected`,
      }),
    );
    const error = await caught(run(testClient(leaky)));
    expect(error.paypalMessage).toContain("[redacted]");
    const fake = fakePayPal(ok);
    expectNoSecrets(await run(testClient(fake)));
    for (const request of [...leaky.apiRequests(), ...fake.apiRequests()]) {
      expect(request.body ?? "").not.toContain(FAKE_SECRET);
      expect(request.body ?? "").not.toContain(FAKE_TOKEN);
      expect(request.url).not.toContain(FAKE_TOKEN);
      expect(request.url).not.toContain(FAKE_SECRET);
    }
  });
});
