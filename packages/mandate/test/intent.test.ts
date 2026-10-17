import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { hashIntent, type Intent } from "../src/index";

const reference: Intent = {
  principal: "support-agent",
  rail: "paypal",
  action: "paypal.refund",
  amount: { minor: 1800, currency: "USD" },
  target: { captureId: "7YL89768KH2865638", orderId: "5O190127TN364715T" },
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
      target: { orderId: "5O190127TN364715T", captureId: "7YL89768KH2865638" },
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
    ["capture", { target: { captureId: "8YL89768KH2865638", orderId: "5O190127TN364715T" } }],
    ["ticket", { ticketId: "tkt_0043" }],
    ["principal", { principal: "ops-agent" }],
    ["action", { action: "paypal.payout" }],
    ["rail", { rail: "mpesa" }],
  ])("changes with the %s", (_field, change) => {
    expect(hashIntent({ ...reference, ...change }).hash).not.toBe(hashIntent(reference).hash);
  });
});
