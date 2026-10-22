import {
  createPayPalClient,
  type EvidenceDocument,
  type PayPalClient,
  type ProvideEvidenceInput,
} from "@countersign/rail-paypal";
import { describe, expect, it } from "vitest";
import {
  caught,
  fakePayPal,
  fixture,
  provideEvidenceReply,
  reply,
  type SeenRequest,
  sandboxEnv,
  testClient,
} from "./fake-paypal";

// Phase 11's dispute actions (ADR 0035): accept claim, make offer, provide evidence with PDF
// documents, and the sandbox-only require evidence and adjudicate. None carries a request ID
// and none is ever retried.

const DISPUTE_ID = "PP-D-27803";
const BASE = `/v1/customer/disputes/${DISPUTE_ID}`;

function body(request: SeenRequest | undefined): Record<string, unknown> {
  expect(request?.body).toBeTypeOf("string");
  return JSON.parse(request?.body ?? "null");
}

function pdf(name = "countersign-evidence-PP-D-27803.pdf", size = 64): EvidenceDocument {
  const bytes = new Uint8Array(size);
  bytes.set(Buffer.from("%PDF-1.7\n").subarray(0, size));
  return { name, contentType: "application/pdf", bytes };
}

const evidenceInput = (overrides: Partial<ProvideEvidenceInput> = {}): ProvideEvidenceInput => ({
  disputeId: DISPUTE_ID,
  evidences: [
    {
      evidenceType: "PROOF_OF_FULFILLMENT",
      notes:
        "Shipped with Kikapu Express under tracking KX123; delivered (simulated carrier data).",
      trackingInfo: [
        { carrierName: "OTHER", carrierNameOther: "Kikapu Express", trackingNumber: "KX123" },
      ],
    },
    {
      evidenceType: "PROOF_OF_REFUND",
      notes: "Refunded $18.00.",
      refundIds: ["1JU08902781691411"],
    },
  ],
  documents: [pdf()],
  ...overrides,
});

type Call = {
  name: string;
  path: string;
  run: (client: PayPalClient, disputeId?: string) => Promise<number>;
};

const calls: Call[] = [
  {
    name: "accept claim",
    path: `${BASE}/accept-claim`,
    run: (client, disputeId = DISPUTE_ID) =>
      client.acceptClaim({ disputeId, note: "We accept the claim." }),
  },
  {
    name: "make offer",
    path: `${BASE}/make-offer`,
    run: (client, disputeId = DISPUTE_ID) =>
      client.makeOffer({
        disputeId,
        note: "A partial refund.",
        offerType: "REFUND",
        offerAmount: { minor: 1200, currency: "USD" },
      }),
  },
  {
    name: "provide evidence",
    path: `${BASE}/provide-evidence`,
    run: (client, disputeId = DISPUTE_ID) => client.provideEvidence(evidenceInput({ disputeId })),
  },
  {
    name: "require evidence",
    path: `${BASE}/require-evidence`,
    run: (client, disputeId = DISPUTE_ID) =>
      client.requireEvidence({ disputeId, action: "SELLER_EVIDENCE" }),
  },
  {
    name: "adjudicate",
    path: `${BASE}/adjudicate`,
    run: (client, disputeId = DISPUTE_ID) =>
      client.adjudicate({ disputeId, outcome: "SELLER_FAVOR" }),
  },
];

describe("accept claim", () => {
  it("posts the note to accept-claim and answers PayPal's status", async () => {
    const fake = fakePayPal(() => reply(200, fixture("dispute-action")));
    const status = await testClient(fake).acceptClaim({
      disputeId: DISPUTE_ID,
      note: "We accept the claim.",
    });
    expect(status).toBe(200);
    const [request] = fake.apiRequests();
    expect(request?.method).toBe("POST");
    expect(request?.path).toBe(`${BASE}/accept-claim`);
    expect(body(request)).toEqual({ note: "We accept the claim." });
  });
});

describe("make offer", () => {
  it("converts the offer amount from minor units inside the client", async () => {
    const fake = fakePayPal(() => reply(200, fixture("dispute-action")));
    await testClient(fake).makeOffer({
      disputeId: DISPUTE_ID,
      note: "A partial refund.",
      offerType: "REFUND",
      offerAmount: { minor: 1205, currency: "USD" },
    });
    const [request] = fake.apiRequests();
    expect(request?.path).toBe(`${BASE}/make-offer`);
    expect(body(request)).toEqual({
      note: "A partial refund.",
      offer_type: "REFUND",
      offer_amount: { currency_code: "USD", value: "12.05" },
    });
  });

  it("leaves the amount out when none is given", async () => {
    const fake = fakePayPal(() => reply(200, fixture("dispute-action")));
    await testClient(fake).makeOffer({
      disputeId: DISPUTE_ID,
      note: "A replacement.",
      offerType: "REPLACEMENT_WITHOUT_REFUND",
    });
    expect(body(fake.apiRequests()[0])).toEqual({
      note: "A replacement.",
      offer_type: "REPLACEMENT_WITHOUT_REFUND",
    });
  });

  it("refuses a non-USD or fractional amount before sending", async () => {
    const fake = fakePayPal(() => reply(200, fixture("dispute-action")));
    const client = testClient(fake);
    for (const offerAmount of [
      { minor: 1200, currency: "KES" },
      { minor: 12.5, currency: "USD" },
      { minor: 0, currency: "USD" },
    ] as const) {
      const error = await caught(
        client.makeOffer({ disputeId: DISPUTE_ID, note: "x", offerType: "REFUND", offerAmount }),
      );
      expect(error.kind).toBe("invalid_request");
    }
    expect(fake.requests).toHaveLength(0);
  });
});

describe("provide evidence", () => {
  it("sends an input JSON part and one named PDF part per document, which the fake accepts", async () => {
    const fake = fakePayPal(provideEvidenceReply);
    const second = pdf("countersign-evidence-capture-3C679366HH908993F.pdf", 32);
    const status = await testClient(fake).provideEvidence(
      evidenceInput({ documents: [pdf(), second] }),
    );
    expect(status).toBe(200);
    const [request] = fake.apiRequests();
    expect(request?.method).toBe("POST");
    expect(request?.path).toBe(`${BASE}/provide-evidence`);
    expect(request?.headers["content-type"]).toMatch(/^multipart\/form-data; boundary=/);
    const form = request?.form;
    expect([...(form?.keys() ?? [])]).toEqual(["input", "file1", "file2"]);
    expect(JSON.parse(String(form?.get("input")))).toEqual({
      evidences: [
        {
          evidence_type: "PROOF_OF_FULFILLMENT",
          evidence_info: {
            tracking_info: [
              {
                carrier_name: "OTHER",
                carrier_name_other: "Kikapu Express",
                tracking_number: "KX123",
              },
            ],
          },
          notes:
            "Shipped with Kikapu Express under tracking KX123; delivered (simulated carrier data).",
        },
        {
          evidence_type: "PROOF_OF_REFUND",
          evidence_info: { refund_ids: ["1JU08902781691411"] },
          notes: "Refunded $18.00.",
        },
      ],
    });
    const file1 = form?.get("file1");
    const file2 = form?.get("file2");
    expect(file1).toBeInstanceOf(File);
    expect((file1 as File).name).toBe("countersign-evidence-PP-D-27803.pdf");
    expect((file1 as File).type).toBe("application/pdf");
    expect(new Uint8Array(await (file1 as File).arrayBuffer())).toEqual(pdf().bytes);
    expect((file2 as File).name).toBe(second.name);
    expect((file2 as File).size).toBe(32);
  });

  it("leaves evidence_info out of an item with no tracking or refunds", async () => {
    const fake = fakePayPal(provideEvidenceReply);
    await testClient(fake).provideEvidence(
      evidenceInput({ evidences: [{ evidenceType: "OTHER", notes: "Records attached." }] }),
    );
    const input = JSON.parse(String(fake.apiRequests()[0]?.form?.get("input")));
    expect(input).toEqual({ evidences: [{ evidence_type: "OTHER", notes: "Records attached." }] });
  });

  it("checks the parts in the fake: a body without the JSON input part is refused", async () => {
    const form = new FormData();
    form.append("input", "{}");
    const encoded = new Response(form);
    const bytes = new Uint8Array(await encoded.arrayBuffer());
    const contentType = encoded.headers.get("content-type") ?? "";
    const seen: SeenRequest = {
      method: "POST",
      url: `https://api-m.sandbox.paypal.com${BASE}/provide-evidence`,
      path: `${BASE}/provide-evidence`,
      headers: { "content-type": contentType },
      body: null,
      form: await new Response(bytes, { headers: { "content-type": contentType } }).formData(),
      bytes,
    };
    expect(provideEvidenceReply(seen).status).toBe(400);
  });

  it("refuses more than 5 documents, one over 1 MB, an empty one, or a name outside PayPal's pattern", async () => {
    const fake = fakePayPal(provideEvidenceReply);
    const client = testClient(fake);
    const refused: ProvideEvidenceInput[] = [
      evidenceInput({ documents: Array.from({ length: 6 }, () => pdf()) }),
      evidenceInput({ documents: [pdf("big.pdf", 1024 * 1024 + 1)] }),
      evidenceInput({ documents: [pdf("empty.pdf", 0)] }),
      evidenceInput({ documents: [pdf("no-extension")] }),
      evidenceInput({ documents: [pdf('evil".pdf')] }),
      evidenceInput({ documents: [pdf("line\r\nbreak.pdf")] }),
      evidenceInput({ documents: [pdf("../up.pdf")] }),
      evidenceInput({
        documents: [{ ...pdf(), contentType: "text/html" as "application/pdf" }],
      }),
    ];
    for (const input of refused) {
      const error = await caught(client.provideEvidence(input));
      expect(error.kind).toBe("invalid_request");
      expect(error.message).not.toContain("evil");
    }
    expect(fake.requests).toHaveLength(0);
  });

  it("accepts exactly 5 documents of exactly 1 MB", async () => {
    const fake = fakePayPal(provideEvidenceReply);
    const documents = Array.from({ length: 5 }, (_, i) => pdf(`doc-${i + 1}.pdf`, 1024 * 1024));
    expect(await testClient(fake).provideEvidence(evidenceInput({ documents }))).toBe(200);
  });

  it("refuses notes outside 1 to 2000 characters, and no evidence items", async () => {
    const fake = fakePayPal(provideEvidenceReply);
    const client = testClient(fake);
    for (const notes of ["", "x".repeat(2001)]) {
      const error = await caught(
        client.provideEvidence(evidenceInput({ evidences: [{ evidenceType: "OTHER", notes }] })),
      );
      expect(error.kind).toBe("invalid_request");
    }
    const none = await caught(client.provideEvidence(evidenceInput({ evidences: [] })));
    expect(none.kind).toBe("invalid_request");
    expect(fake.requests).toHaveLength(0);
    expect(
      await client.provideEvidence(
        evidenceInput({ evidences: [{ evidenceType: "OTHER", notes: "x".repeat(2000) }] }),
      ),
    ).toBe(200);
  });
});

describe("sandbox-only helpers", () => {
  it("require evidence posts the action", async () => {
    const fake = fakePayPal(() => reply(200, fixture("dispute-action")));
    await testClient(fake).requireEvidence({ disputeId: DISPUTE_ID, action: "BUYER_EVIDENCE" });
    const [request] = fake.apiRequests();
    expect(request?.path).toBe(`${BASE}/require-evidence`);
    expect(body(request)).toEqual({ action: "BUYER_EVIDENCE" });
  });

  it("adjudicate posts the outcome", async () => {
    const fake = fakePayPal(() => reply(200, fixture("dispute-action")));
    await testClient(fake).adjudicate({ disputeId: DISPUTE_ID, outcome: "BUYER_FAVOR" });
    const [request] = fake.apiRequests();
    expect(request?.path).toBe(`${BASE}/adjudicate`);
    expect(body(request)).toEqual({ adjudication_outcome: "BUYER_FAVOR" });
  });

  it("refuses an unknown action or outcome before sending", async () => {
    const fake = fakePayPal(() => reply(200, fixture("dispute-action")));
    const client = testClient(fake);
    const bad = await caught(
      client.requireEvidence({ disputeId: DISPUTE_ID, action: "BOTH" as "SELLER_EVIDENCE" }),
    );
    expect(bad.kind).toBe("invalid_request");
    const worse = await caught(
      client.adjudicate({ disputeId: DISPUTE_ID, outcome: "DRAW" as "SELLER_FAVOR" }),
    );
    expect(worse.kind).toBe("invalid_request");
    expect(fake.requests).toHaveLength(0);
  });
});

describe.each(calls)("$name", (call) => {
  it("sends no PayPal-Request-Id, to the sandbox base URL", async () => {
    const fake = fakePayPal(provideEvidenceOr(call));
    expect(await call.run(testClient(fake))).toBe(200);
    const [request] = fake.apiRequests();
    expect(request?.url).toBe(`https://api-m.sandbox.paypal.com${call.path}`);
    expect(request?.headers["paypal-request-id"]).toBeUndefined();
  });

  it("answers a 202 as 202", async () => {
    const fake = fakePayPal(() => reply(202, fixture("dispute-action")));
    expect(await call.run(testClient(fake))).toBe(202);
  });

  it("throws on a 4xx with PayPal's name and issues, sent once", async () => {
    const fake = fakePayPal(() => reply(422, fixture("error-422-unprocessable")));
    const error = await caught(call.run(testClient(fake)));
    expect(error.kind).toBe("http");
    expect(error.status).toBe(422);
    expect(fake.apiRequests()).toHaveLength(1);
  });

  it("throws on a 5xx or a 429 without a retry", async () => {
    for (const status of [500, 503, 429]) {
      const fake = fakePayPal(() => reply(status, { name: "INTERNAL_SERVER_ERROR" }));
      const error = await caught(call.run(testClient(fake)));
      expect(error.status).toBe(status);
      expect(fake.apiRequests()).toHaveLength(1);
    }
  });

  it("throws on a network failure without a retry", async () => {
    const fake = fakePayPal(() => reply(200));
    let sent = 0;
    const client = createPayPalClient({
      env: sandboxEnv,
      sleep: async () => {},
      fetch: async (url, init) => {
        if (new URL(url).pathname === "/v1/oauth2/token") return fake.fetch(url, init);
        sent += 1;
        throw new TypeError("fetch failed");
      },
    });
    const error = await caught(call.run(client));
    expect(error.kind).toBe("network");
    expect(sent).toBe(1);
  });

  it("refuses a malformed dispute ID before any call", async () => {
    const fake = fakePayPal(() => reply(200));
    const error = await caught(call.run(testClient(fake), "PP-D/../1"));
    expect(error.kind).toBe("invalid_request");
    expect(fake.requests).toHaveLength(0);
  });
});

describe("accept claim and make offer notes", () => {
  it("refuse notes outside 1 to 2000 characters before sending", async () => {
    const fake = fakePayPal(() => reply(200, fixture("dispute-action")));
    const client = testClient(fake);
    for (const note of ["", "x".repeat(2001)]) {
      expect((await caught(client.acceptClaim({ disputeId: DISPUTE_ID, note }))).kind).toBe(
        "invalid_request",
      );
      expect(
        (await caught(client.makeOffer({ disputeId: DISPUTE_ID, note, offerType: "REFUND" }))).kind,
      ).toBe("invalid_request");
    }
    expect(fake.requests).toHaveLength(0);
  });
});

function provideEvidenceOr(call: Call) {
  return (req: SeenRequest) =>
    call.name === "provide evidence"
      ? provideEvidenceReply(req)
      : reply(200, fixture("dispute-action"));
}
