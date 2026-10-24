import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { type CaptureTarget, hashIntent, type Intent } from "../src/index";

const reference: Intent & { target: CaptureTarget } = {
  principal: "support-agent",
  rail: "paypal",
  action: "paypal.refund",
  amount: { minor: 1800, currency: "USD" },
  target: { kind: "capture", captureId: "7YL89768KH2865638", orderId: "5O190127TN364715T" },
  ticketId: "tkt_0042",
  claim: "not_received",
  mandateVersion: 3,
};

const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

describe("hashIntent", () => {
  it("hashes the canonical JSON of what executes, and returns that JSON", () => {
    const expected =
      '{"action":"paypal.refund","amount":1800,"currency":"USD","principal":"support-agent",' +
      '"rail":"paypal","target":{"captureId":"7YL89768KH2865638"},"ticketId":"tkt_0042"}';
    const { hash, canonical } = hashIntent(reference);
    expect(canonical).toBe(expected);
    expect(hash).toBe(sha256(expected));
  });

  it("returns JSON whose UTF-8 SHA-256 is the hash", () => {
    const ticketId = `tkt_${String.fromCharCode(0xe9, 0x4e2d)}`;
    const { hash, canonical } = hashIntent({ ...reference, ticketId });
    expect(sha256(canonical)).toBe(hash);
  });

  it("ignores the order ID, which only the capture record supplies", () => {
    const withoutOrder = { ...reference, target: { ...reference.target, orderId: null } };
    expect(hashIntent(withoutOrder)).toEqual(hashIntent(reference));
  });

  it("gives an ID of int_ and the first 24 hex characters of the hash", () => {
    const { hash, id } = hashIntent(reference);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(id).toMatch(/^int_[0-9a-f]{24}$/);
    expect(id).toBe(`int_${hash.slice(0, 24)}`);
  });

  it("ignores key order", () => {
    const reordered: Intent = {
      mandateVersion: 3,
      claim: "not_received",
      ticketId: "tkt_0042",
      target: { orderId: "5O190127TN364715T", captureId: "7YL89768KH2865638", kind: "capture" },
      amount: { currency: "USD", minor: 1800 },
      action: "paypal.refund",
      rail: "paypal",
      principal: "support-agent",
    };
    expect(hashIntent(reordered)).toEqual(hashIntent(reference));
  });

  it("ignores the claim and the mandate version", () => {
    expect(hashIntent({ ...reference, claim: "damaged" })).toEqual(hashIntent(reference));
    expect(hashIntent({ ...reference, claim: null })).toEqual(hashIntent(reference));
    expect(hashIntent({ ...reference, mandateVersion: 4 })).toEqual(hashIntent(reference));
  });

  it.each<[string, Partial<Intent>]>([
    ["amount", { amount: { minor: 1801, currency: "USD" } }],
    ["currency", { amount: { minor: 1800, currency: "KES" } }],
    [
      "capture",
      { target: { kind: "capture", captureId: "8YL89768KH2865638", orderId: "5O190127TN364715T" } },
    ],
    ["ticket", { ticketId: "tkt_0043" }],
    ["principal", { principal: "ops-agent" }],
    ["action", { action: "paypal.payout" }],
    ["rail", { rail: "mpesa" }],
  ])("changes with the %s", (_field, change) => {
    expect(hashIntent({ ...reference, ...change }).hash).not.toBe(hashIntent(reference).hash);
  });

  it("hashes no parameters for a refund, even when the intent carries some", () => {
    const withParams: Intent = { ...reference, params: { note: "Sorry about that" } };
    expect(hashIntent(withParams)).toEqual(hashIntent(reference));
  });
});

const base = {
  principal: "support-agent",
  rail: "paypal",
  amount: { minor: 4200, currency: "USD" },
  ticketId: null,
  claim: null,
  mandateVersion: 3,
} as const satisfies Partial<Intent>;

const parsedHash = (intent: Intent) => JSON.parse(hashIntent(intent).canonical);

// Each guarded action other than a refund, with its own target and every parameter set.
const others: [string, Intent, Intent][] = [
  [
    "accept_claim",
    {
      ...base,
      action: "paypal.dispute.accept_claim",
      target: { kind: "dispute", disputeId: "PP-D-27803" },
      params: { note: "Refund accepted" },
    },
    {
      ...base,
      action: "paypal.dispute.accept_claim",
      target: { kind: "dispute", disputeId: "PP-D-27803" },
      params: { note: "Refund accepted, sorry" },
    },
  ],
  [
    "provide_evidence",
    {
      ...base,
      action: "paypal.dispute.provide_evidence",
      target: { kind: "dispute", disputeId: "PP-D-27803" },
      params: {
        evidence: [
          { evidenceType: "PROOF_OF_FULFILLMENT", notes: "Delivered", trackingNumbers: ["1Z99"] },
        ],
      },
    },
    {
      ...base,
      action: "paypal.dispute.provide_evidence",
      target: { kind: "dispute", disputeId: "PP-D-27803" },
      params: {
        evidence: [
          { evidenceType: "PROOF_OF_FULFILLMENT", notes: "Delivered", trackingNumbers: ["1Z98"] },
        ],
      },
    },
  ],
  [
    "make_offer",
    {
      ...base,
      action: "paypal.dispute.make_offer",
      target: { kind: "dispute", disputeId: "PP-D-27803" },
      params: { offerType: "REFUND", note: "Half back" },
    },
    {
      ...base,
      action: "paypal.dispute.make_offer",
      target: { kind: "dispute", disputeId: "PP-D-27803" },
      params: { offerType: "REFUND_WITH_RETURN", note: "Half back" },
    },
  ],
  [
    "invoice_send",
    {
      ...base,
      action: "paypal.invoice.send",
      target: { kind: "invoice", invoiceId: "INV2-AB12" },
      params: { note: "Thanks", sendToRecipient: true, additionalRecipients: ["a@example.com"] },
    },
    {
      ...base,
      action: "paypal.invoice.send",
      target: { kind: "invoice", invoiceId: "INV2-AB12" },
      params: {
        note: "Thanks",
        sendToRecipient: true,
        additionalRecipients: ["a@example.com", "b@example.com"],
      },
    },
  ],
  [
    "payout",
    {
      ...base,
      action: "paypal.payout",
      target: { kind: "payee", email: "payee@example.com" },
      params: { note: "Commission" },
    },
    {
      ...base,
      action: "paypal.payout",
      target: { kind: "payee", email: "payee@example.com" },
      params: { note: "Bonus" },
    },
  ],
];

describe("hashIntent for actions other than a refund", () => {
  it("hashes each target's own ID and the action's parameters", () => {
    expect(parsedHash(others[0][1])).toEqual({
      action: "paypal.dispute.accept_claim",
      amount: 4200,
      currency: "USD",
      principal: "support-agent",
      rail: "paypal",
      target: { disputeId: "PP-D-27803" },
      ticketId: null,
      params: { note: "Refund accepted" },
    });
    expect(parsedHash(others[1][1]).params).toEqual({
      evidence: [
        { evidenceType: "PROOF_OF_FULFILLMENT", notes: "Delivered", trackingNumbers: ["1Z99"] },
      ],
    });
    expect(parsedHash(others[2][1]).params).toEqual({ offerType: "REFUND", note: "Half back" });
    expect(parsedHash(others[3][1]).target).toEqual({ invoiceId: "INV2-AB12" });
    expect(parsedHash(others[4][1]).target).toEqual({ email: "payee@example.com" });
  });

  it("hashes absent optional parameters as null, under the action's fixed keys", () => {
    const send: Intent = {
      ...base,
      action: "paypal.invoice.send",
      target: { kind: "invoice", invoiceId: "INV2-AB12" },
    };
    expect(parsedHash(send).params).toEqual({
      note: null,
      sendToRecipient: null,
      additionalRecipients: null,
    });
    const extra: Intent = { ...send, params: { offerType: "REFUND" } };
    expect(parsedHash(extra).params).toEqual(parsedHash(send).params);
    const evidence: Intent = {
      ...base,
      action: "paypal.dispute.provide_evidence",
      target: { kind: "dispute", disputeId: "PP-D-27803" },
      params: { evidence: [{ evidenceType: "OTHER", notes: "See photos" }] },
    };
    expect(parsedHash(evidence).params).toEqual({
      evidence: [{ evidenceType: "OTHER", notes: "See photos", trackingNumbers: null }],
    });
  });

  it("hashes an evidence submission's documents and refund IDs only when they're set", () => {
    const [, evidence] = others[1];
    const documents = [
      { id: "doc_0123456789abcdef01234567", name: "a.pdf", sha256: "ab".repeat(32) },
    ];
    const withDocuments: Intent = {
      ...evidence,
      params: {
        evidence: [
          {
            evidenceType: "PROOF_OF_REFUND",
            notes: "Refunded",
            trackingNumbers: null,
            refundIds: ["REF-1"],
          },
        ],
        documents,
      },
    };
    expect(parsedHash(withDocuments).params).toEqual({
      evidence: [
        {
          evidenceType: "PROOF_OF_REFUND",
          notes: "Refunded",
          trackingNumbers: null,
          refundIds: ["REF-1"],
        },
      ],
      documents,
    });
    const changed = (document: Partial<(typeof documents)[number]>): Intent => ({
      ...withDocuments,
      params: { ...withDocuments.params, documents: [{ ...documents[0], ...document }] },
    });
    const original = hashIntent(withDocuments).hash;
    expect(hashIntent(changed({ sha256: "cd".repeat(32) })).hash).not.toBe(original);
    expect(hashIntent(changed({ name: "b.pdf" })).hash).not.toBe(original);
    expect(hashIntent(changed({ id: "doc_76543210fedcba9876543210" })).hash).not.toBe(original);
    const noRefunds: Intent = {
      ...withDocuments,
      params: {
        ...withDocuments.params,
        evidence: [{ evidenceType: "PROOF_OF_REFUND", notes: "Refunded", refundIds: null }],
      },
    };
    expect(parsedHash(noRefunds).params.evidence).toEqual([
      { evidenceType: "PROOF_OF_REFUND", notes: "Refunded", trackingNumbers: null },
    ]);
    // Documents on any other action aren't hashed.
    const [, claim] = others[0];
    const claimWithDocuments: Intent = { ...claim, params: { ...claim.params, documents } };
    expect(hashIntent(claimWithDocuments)).toEqual(hashIntent(claim));
  });

  it("hashes an order capture's order and an empty parameter object", () => {
    const capture: Intent = {
      ...base,
      action: "paypal.order.capture",
      target: { kind: "order", orderId: "5O190127TN364715T" },
    };
    const json = parsedHash(capture);
    expect(json.target).toEqual({ orderId: "5O190127TN364715T" });
    expect(json.params).toEqual({});
    const other: Intent = { ...capture, target: { kind: "order", orderId: "6O190127TN364715T" } };
    expect(hashIntent(other).hash).not.toBe(hashIntent(capture).hash);
  });

  it("hashes a payout's reference only when it's set", () => {
    const [, payout] = others[4];
    expect(hashIntent(payout).hash).toBe(
      "b3ef2f2819f858fa75b38c658da75a2968bb4a234663c2e89a2ec04c039fd2a4",
    );
    expect(parsedHash(payout).params).toEqual({ note: "Commission" });
    const unset: Intent = { ...payout, params: { ...payout.params, reference: null } };
    expect(hashIntent(unset)).toEqual(hashIntent(payout));
    const billed: Intent = { ...payout, params: { ...payout.params, reference: "KDW-2026-0412" } };
    expect(parsedHash(billed).params).toEqual({ note: "Commission", reference: "KDW-2026-0412" });
    const other: Intent = { ...billed, params: { ...billed.params, reference: "KDW-2026-0413" } };
    expect(hashIntent(other).hash).not.toBe(hashIntent(billed).hash);
    expect(hashIntent(billed).hash).not.toBe(hashIntent(payout).hash);
    // A reference on any other action isn't hashed.
    const [, claim] = others[0];
    const claimWithReference: Intent = { ...claim, params: { ...claim.params, reference: "X-1" } };
    expect(hashIntent(claimWithReference)).toEqual(hashIntent(claim));
  });

  it("hashes a payee's email lower-cased and trimmed", () => {
    const [, payout] = others[4];
    const shouted: Intent = { ...payout, target: { kind: "payee", email: " PAYEE@Example.com " } };
    expect(hashIntent(shouted)).toEqual(hashIntent(payout));
  });

  it.each(others)("changes with a %s parameter", (_name, intent, changed) => {
    expect(hashIntent(changed).hash).not.toBe(hashIntent(intent).hash);
  });

  it.each(others)("changes with the %s target and amount", (_name, intent) => {
    const target = intent.target;
    const moved: Intent = {
      ...intent,
      target:
        target.kind === "dispute"
          ? { ...target, disputeId: `${target.disputeId}9` }
          : target.kind === "invoice"
            ? { ...target, invoiceId: `${target.invoiceId}9` }
            : { kind: "payee", email: "other@example.com" },
    };
    expect(hashIntent(moved).hash).not.toBe(hashIntent(intent).hash);
    const more: Intent = { ...intent, amount: { minor: 4201, currency: "USD" } };
    expect(hashIntent(more).hash).not.toBe(hashIntent(intent).hash);
  });

  it.each(others)("ignores key order for %s", (_name, intent) => {
    const reversed = (value: object) => Object.fromEntries(Object.entries(value).reverse());
    const reordered = {
      ...reversed(intent),
      target: reversed(intent.target),
      params: reversed(intent.params ?? {}),
    } as Intent;
    expect(hashIntent(reordered)).toEqual(hashIntent(intent));
  });

  it("hashes a ticket ID when one is given", () => {
    const [, accept] = others[0];
    expect(parsedHash({ ...accept, ticketId: "tkt_0042" }).ticketId).toBe("tkt_0042");
    expect(hashIntent({ ...accept, ticketId: "tkt_0042" }).hash).not.toBe(hashIntent(accept).hash);
  });
});
