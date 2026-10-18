import {
  parsePayPalEnv,
  parsePayPalWebhookId,
  type VerifyWebhookInput,
} from "@countersign/rail-paypal";
import { describe, expect, it } from "vitest";
import {
  caught,
  expectNoSecrets,
  fakePayPal,
  fixture,
  reply,
  type SeenRequest,
  sandboxEnv,
  testClient,
} from "./fake-paypal";

const CAPTURE_ID = "8RH70421MV5531947";
const WEBHOOK_ID = "8PT597110X687430LKGECATA";

function query(request: SeenRequest | undefined): URLSearchParams {
  return new URL(request?.url ?? "https://invalid.example").searchParams;
}

// A page of disputes, linking to the next page when `next` is set.
function page(ids: string[], next?: number) {
  const base = `https://api-m.sandbox.paypal.com/v1/customer/disputes?disputed_transaction_id=${CAPTURE_ID}`;
  return {
    items: ids.map((id) => ({ dispute_id: id, status: "RESOLVED" })),
    links: [
      { href: base, rel: "self", method: "GET" },
      ...(next === undefined
        ? []
        : [{ href: `${base}&next_page_token=page-${next}`, rel: "next", method: "GET" }]),
    ],
  };
}

describe("list disputes", () => {
  it("filters by disputed_transaction_id and returns each dispute's ID and status", async () => {
    const fake = fakePayPal((req) =>
      query(req).get("next_page_token")
        ? reply(200, fixture("list-disputes-page-2"))
        : reply(200, fixture("list-disputes-page-1")),
    );
    const result = await testClient(fake).listDisputes(CAPTURE_ID);
    const requests = fake.apiRequests();
    expect(requests).toHaveLength(2);
    expect(requests.every((r) => r.method === "GET")).toBe(true);
    expect(requests.every((r) => r.path === "/v1/customer/disputes")).toBe(true);
    expect(query(requests[0]).get("disputed_transaction_id")).toBe(CAPTURE_ID);
    expect(query(requests[1]).get("disputed_transaction_id")).toBe(CAPTURE_ID);
    expect(query(requests[1]).get("next_page_token")).toBe(
      "JTI1MjJhY2NvdW50X251bWJlciUyNTIyJTI1M0E",
    );
    expect(result).toEqual({
      disputes: [
        { id: "PP-R-NKG-10049671", status: "WAITING_FOR_SELLER_RESPONSE" },
        { id: "PP-R-NKG-10049388", status: "RESOLVED" },
      ],
      complete: true,
    });
    expectNoSecrets(result);
  });

  it("reads an empty list as complete with no disputes", async () => {
    const fake = fakePayPal(() => reply(200, { links: page([]).links }));
    expect(await testClient(fake).listDisputes(CAPTURE_ID)).toEqual({
      disputes: [],
      complete: true,
    });
  });

  it("reads five pages and stops, leaving complete false when a sixth exists", async () => {
    const fake = fakePayPal((req) => {
      const token = query(req).get("next_page_token");
      const n = token ? Number(token.replace("page-", "")) : 1;
      return reply(200, page([`PP-D-${n}`], n + 1));
    });
    const result = await testClient(fake).listDisputes(CAPTURE_ID);
    expect(fake.apiRequests()).toHaveLength(5);
    expect(result.complete).toBe(false);
    expect(result.disputes.map((d) => d.id)).toEqual([
      "PP-D-1",
      "PP-D-2",
      "PP-D-3",
      "PP-D-4",
      "PP-D-5",
    ]);
  });

  it("reads exactly five pages as complete when the fifth has no next link", async () => {
    const fake = fakePayPal((req) => {
      const token = query(req).get("next_page_token");
      const n = token ? Number(token.replace("page-", "")) : 1;
      return reply(200, page([`PP-D-${n}`], n < 5 ? n + 1 : undefined));
    });
    const result = await testClient(fake).listDisputes(CAPTURE_ID);
    expect(fake.apiRequests()).toHaveLength(5);
    expect(result.complete).toBe(true);
  });

  it("refuses a next link that leaves the sandbox's disputes endpoint", async () => {
    const fake = fakePayPal(() =>
      reply(200, {
        items: [],
        links: [{ href: "https://evil.example/v1/customer/disputes?x=1", rel: "next" }],
      }),
    );
    const error = await caught(testClient(fake).listDisputes(CAPTURE_ID));
    expect(error.kind).toBe("invalid_response");
    expect(fake.apiRequests()).toHaveLength(1);
  });

  it("fails on a dispute missing its status", async () => {
    const fake = fakePayPal(() => reply(200, { items: [{ dispute_id: "PP-D-1" }] }));
    const error = await caught(testClient(fake).listDisputes(CAPTURE_ID));
    expect(error.kind).toBe("invalid_response");
    expect(error.field).toBe("items[0].status");
  });

  it("refuses a malformed capture ID before any call", async () => {
    const fake = fakePayPal(() => reply(200, page([])));
    const error = await caught(testClient(fake).listDisputes("8RH7/../x"));
    expect(error.kind).toBe("invalid_request");
    expect(fake.requests).toHaveLength(0);
  });
});

// Odd spacing and key order: re-serializing would change these bytes.
const RAW_BODY =
  '{ "resource" : {"id":"1JU08902781691411",  "status":"COMPLETED"},"event_type":"PAYMENT.CAPTURE.REFUNDED",\n  "id":"WH-58D329510W468432D-8HN650336L201105X" }';

const verifyInput: VerifyWebhookInput = {
  webhookId: WEBHOOK_ID,
  transmission: {
    transmissionId: "69cd13f0-d67a-11e5-baa3-778b53f4ae55",
    transmissionTime: "2026-10-18T15:14:02Z",
    certUrl:
      "https://api.sandbox.paypal.com/v1/notifications/certs/CERT-360caa42-fca2a594-a5cafa77",
    authAlgo: "SHA256withRSA",
    transmissionSig:
      "lmI95Jx3Y9nhR5SJWlHVIWpg4AgFk7n9bCHSRxbrd8A9zrhdu2rMyFrmz+Zjh3s3boXB07VXCXUZy/UFzUlnGJn0wDugt7FlSvdKeIJenLRemUxYCPVoEZzg9VFNqOa48gMkvF+XTpxBeUx/kWy6B5cp7GkT2+pOowfRK7OaynuxUoKW3JcMWw272VKjLTtTAShncla7tGF+55rxyt2KNZIIqxNMJ48RDZheGU5w1npu9dZHnPgTXB9iomeVRoD8O/jhRpnKsGrDschyNdkeh81BJJMH4Ctc6lnCCquoP/GzCzz33MMsNdid7vL/NIWaCsekQpW26FpWPi/tfj8nLA==",
  },
  rawBody: RAW_BODY,
};

describe("verify webhook signature", () => {
  it("sends the five transmission headers, the webhook ID and the raw body byte for byte", async () => {
    const fake = fakePayPal(() => reply(200, fixture("verify-webhook-signature-success")));
    await testClient(fake).verifyWebhookSignature(verifyInput);
    const [request] = fake.apiRequests();
    expect(request?.method).toBe("POST");
    expect(request?.path).toBe("/v1/notifications/verify-webhook-signature");
    expect(request?.body).toContain(RAW_BODY);
    const sent = JSON.parse(request?.body ?? "null");
    expect(sent).toEqual({
      transmission_id: verifyInput.transmission.transmissionId,
      transmission_time: verifyInput.transmission.transmissionTime,
      cert_url: verifyInput.transmission.certUrl,
      auth_algo: verifyInput.transmission.authAlgo,
      transmission_sig: verifyInput.transmission.transmissionSig,
      webhook_id: WEBHOOK_ID,
      webhook_event: JSON.parse(RAW_BODY),
    });
  });

  it("is a pass for SUCCESS", async () => {
    const fake = fakePayPal(() => reply(200, fixture("verify-webhook-signature-success")));
    expect(await testClient(fake).verifyWebhookSignature(verifyInput)).toBe("pass");
  });

  it("is a fail for FAILURE", async () => {
    const fake = fakePayPal(() => reply(200, fixture("verify-webhook-signature-failure")));
    expect(await testClient(fake).verifyWebhookSignature(verifyInput)).toBe("fail");
  });

  it("is a fail for any status but SUCCESS", async () => {
    const fake = fakePayPal(() => reply(200, { verification_status: "success" }));
    expect(await testClient(fake).verifyWebhookSignature(verifyInput)).toBe("fail");
  });

  it("throws on a 5xx and is made exactly once", async () => {
    const fake = fakePayPal(() => reply(503, { name: "SERVICE_UNAVAILABLE" }));
    const error = await caught(testClient(fake).verifyWebhookSignature(verifyInput));
    expect(error.kind).toBe("http");
    expect(error.status).toBe(503);
    expect(fake.apiRequests()).toHaveLength(1);
  });

  it("throws on a network error and is made exactly once", async () => {
    const fake = fakePayPal(() => {
      throw new TypeError("fetch failed");
    });
    const error = await caught(testClient(fake).verifyWebhookSignature(verifyInput));
    expect(error.kind).toBe("network");
    expect(fake.apiRequests()).toHaveLength(1);
  });

  it("throws on an unreadable answer and is made exactly once", async () => {
    const fake = fakePayPal(() => reply(200, { status: "ok" }));
    const error = await caught(testClient(fake).verifyWebhookSignature(verifyInput));
    expect(error.kind).toBe("invalid_response");
    expect(error.field).toBe("verification_status");
    expect(fake.apiRequests()).toHaveLength(1);
  });

  it("never puts the transmission signature in an error", async () => {
    const fake = fakePayPal(() => reply(400, { name: "VALIDATION_ERROR" }));
    const error = await caught(testClient(fake).verifyWebhookSignature(verifyInput));
    expect(String(error)).not.toContain(verifyInput.transmission.transmissionSig);
  });

  it("refuses a body that isn't a JSON object before any call", async () => {
    const fake = fakePayPal(() => reply(200, fixture("verify-webhook-signature-success")));
    const paypal = testClient(fake);
    for (const rawBody of ["", "not json", "[1,2]", '{"id":"x"} trailing']) {
      const error = await caught(paypal.verifyWebhookSignature({ ...verifyInput, rawBody }));
      expect(error.kind).toBe("invalid_request");
    }
    expect(fake.requests).toHaveLength(0);
  });

  it("refuses a missing header or webhook ID before any call", async () => {
    const fake = fakePayPal(() => reply(200, fixture("verify-webhook-signature-success")));
    const paypal = testClient(fake);
    const noSig = { ...verifyInput.transmission, transmissionSig: "" };
    const error = await caught(
      paypal.verifyWebhookSignature({ ...verifyInput, transmission: noSig }),
    );
    expect(error.kind).toBe("invalid_request");
    expect(error.message).toContain("transmission.transmissionSig");
    expect(error.message).not.toContain(verifyInput.transmission.transmissionId);
    const noId = await caught(paypal.verifyWebhookSignature({ ...verifyInput, webhookId: "" }));
    expect(noId.kind).toBe("invalid_request");
    expect(fake.requests).toHaveLength(0);
  });
});

describe("PAYPAL_WEBHOOK_ID", () => {
  it("is read on its own", () => {
    expect(parsePayPalWebhookId({ PAYPAL_WEBHOOK_ID: WEBHOOK_ID })).toEqual({
      ok: true,
      webhookId: WEBHOOK_ID,
    });
  });

  it("is reported by name when missing or empty", () => {
    for (const env of [{}, { PAYPAL_WEBHOOK_ID: "" }]) {
      expect(parsePayPalWebhookId(env)).toEqual({
        ok: false,
        missing: ["PAYPAL_WEBHOOK_ID"],
        problems: ["PAYPAL_WEBHOOK_ID is missing."],
      });
    }
  });

  it("is reported by name, without its value, when malformed", () => {
    const parsed = parsePayPalWebhookId({ PAYPAL_WEBHOOK_ID: "has spaces <and> marks" });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.missing).toEqual([]);
    expect(parsed.problems.join(" ")).toContain("PAYPAL_WEBHOOK_ID");
    expect(parsed.problems.join(" ")).not.toContain("spaces");
  });

  it("isn't needed by the client's other calls", async () => {
    expect(parsePayPalEnv(sandboxEnv).ok).toBe(true);
    const fake = fakePayPal(() => reply(200, page([])));
    const paypal = testClient(fake, { env: sandboxEnv });
    expect((await paypal.listDisputes(CAPTURE_ID)).complete).toBe(true);
  });
});
