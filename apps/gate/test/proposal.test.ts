import type { CaptureSnapshot, RecordSnapshots } from "@countersign/verifiers";
import { describe, expect, it } from "vitest";
import { normalizeProposal } from "../src/proposal";

const capture: CaptureSnapshot = {
  call: "GET /v2/payments/captures/{id}",
  id: "CAP-1042",
  orderId: "ORD-1042",
  status: "PARTIALLY_REFUNDED",
  amount: { minor: 9600, currency: "USD" },
  refundedMinor: 1600,
};

const records: RecordSnapshots = { captures: [capture] };

const proposal = {
  tool: "create_refund",
  args: {
    capture_id: "CAP-1042",
    amount: { value: "18.00", currency_code: "USD" },
    note_to_payer: "Sorry your parcel stalled.",
  },
  justification: { ticket_id: "TKT-77", claim: "not_received" },
};

function normalize(input: unknown, snapshots: RecordSnapshots = records) {
  return normalizeProposal({
    proposal: input,
    principal: "support-agent",
    mandateVersion: 3,
    records: snapshots,
  });
}

function withArgs(args: Record<string, unknown>) {
  return { ...proposal, args: { ...proposal.args, ...args } };
}

function withJustification(justification: Record<string, unknown>) {
  return { ...proposal, justification: { ...proposal.justification, ...justification } };
}

function deniedCode(input: unknown, snapshots?: RecordSnapshots) {
  const result = normalize(input, snapshots);
  if (result.ok) throw new Error("Expected a denial");
  expect(result.reason.detail).not.toBe("");
  return result.reason.code;
}

describe("normalizeProposal", () => {
  it("turns a valid create_refund proposal into an intent", () => {
    expect(normalize(proposal)).toEqual({
      ok: true,
      intent: {
        principal: "support-agent",
        rail: "paypal",
        action: "paypal.refund",
        amount: { minor: 1800, currency: "USD" },
        target: { captureId: "CAP-1042", orderId: "ORD-1042" },
        ticketId: "TKT-77",
        claim: "not_received",
        mandateVersion: 3,
      },
    });
  });

  it("parses shillings and keeps a proposal with no claim or note", () => {
    const result = normalize({
      tool: "create_refund",
      args: { capture_id: "CAP-1042", amount: { value: "4500", currency_code: "KES" } },
      justification: { ticket_id: "TKT-77" },
    });
    if (!result.ok) throw new Error(result.reason.detail);
    expect(result.intent.amount).toEqual({ minor: 450000, currency: "KES" });
    expect(result.intent.claim).toBeNull();
  });

  it("takes the order ID from the capture record, and null without one", () => {
    const result = normalize(proposal, {});
    if (!result.ok) throw new Error(result.reason.detail);
    expect(result.intent.target).toEqual({ captureId: "CAP-1042", orderId: null });
  });

  it("refunds what's left on the capture when no amount is given", () => {
    const result = normalize(withArgs({ amount: undefined }));
    if (!result.ok) throw new Error(result.reason.detail);
    expect(result.intent.amount).toEqual({ minor: 8000, currency: "USD" });
  });

  it("is invalid with no amount and no capture record", () => {
    const { amount: _, ...args } = proposal.args;
    expect(deniedCode({ ...proposal, args }, {})).toBe("INVALID_PROPOSAL");
    expect(deniedCode({ ...proposal, args }, { captures: [{ ...capture, id: "CAP-9" }] })).toBe(
      "INVALID_PROPOSAL",
    );
  });

  it("is invalid with no amount when nothing is left to refund", () => {
    const refunded = { ...capture, status: "REFUNDED", refundedMinor: 9600 };
    const malformed = { ...capture, refundedMinor: 9700 };
    expect(deniedCode(withArgs({ amount: undefined }), { captures: [refunded] })).toBe(
      "INVALID_PROPOSAL",
    );
    expect(deniedCode(withArgs({ amount: undefined }), { captures: [malformed] })).toBe(
      "INVALID_PROPOSAL",
    );
  });

  it.each([
    ["a comma", "1,000.00", "USD"],
    ["three decimals", "18.005", "USD"],
    ["a sign", "-18.00", "USD"],
    ["a plus sign", "+18.00", "USD"],
    ["an exponent", "1e3", "USD"],
    ["zero", "0.00", "USD"],
    ["a number instead of a string", 18, "USD"],
    ["an unsupported currency", "18.00", "EUR"],
    ["a lowercase currency", "18.00", "usd"],
  ])("denies bad money with %s as INVALID_PROPOSAL", (_, value, currency_code) => {
    expect(deniedCode(withArgs({ amount: { value, currency_code } }))).toBe("INVALID_PROPOSAL");
  });

  it("denies a malformed amount object as INVALID_PROPOSAL", () => {
    expect(deniedCode(withArgs({ amount: { value: "18.00" } }))).toBe("INVALID_PROPOSAL");
    expect(deniedCode(withArgs({ amount: "18.00" }))).toBe("INVALID_PROPOSAL");
    expect(deniedCode(withArgs({ amount: null }))).toBe("INVALID_PROPOSAL");
  });

  it.each([
    ["missing", undefined],
    ["empty", ""],
    ["blank", "   "],
    ["not a string", 1042],
  ])("denies a %s capture ID as INVALID_PROPOSAL", (_, capture_id) => {
    expect(deniedCode(withArgs({ capture_id }))).toBe("INVALID_PROPOSAL");
  });

  it.each([
    ["missing", undefined],
    ["empty", ""],
    ["blank", " "],
    ["not a string", 77],
  ])("denies a %s ticket ID as INVALID_PROPOSAL", (_, ticket_id) => {
    expect(deniedCode(withJustification({ ticket_id }))).toBe("INVALID_PROPOSAL");
  });

  it.each([["lost"], ["NOT_RECEIVED"], [""], [7]])(
    "denies the unknown claim %j as INVALID_PROPOSAL",
    (claim) => {
      expect(deniedCode(withJustification({ claim }))).toBe("INVALID_PROPOSAL");
    },
  );

  it("denies unrecognized fields as INVALID_PROPOSAL rather than ignoring them", () => {
    expect(deniedCode(withArgs({ invoice_id: "INV-1" }))).toBe("INVALID_PROPOSAL");
    expect(deniedCode(withJustification({ purpose: "goodwill" }))).toBe("INVALID_PROPOSAL");
    expect(deniedCode({ ...proposal, principal: "admin" })).toBe("INVALID_PROPOSAL");
  });

  it("denies a proposal that isn't the right shape as INVALID_PROPOSAL, without throwing", () => {
    for (const input of [undefined, null, "create_refund", 42, [], {}, { tool: 7 }]) {
      expect(deniedCode(input)).toBe("INVALID_PROPOSAL");
    }
    expect(deniedCode({ ...proposal, args: undefined })).toBe("INVALID_PROPOSAL");
    expect(deniedCode({ ...proposal, justification: undefined })).toBe("INVALID_PROPOSAL");
  });

  it.each([["create_payout"], ["accept_dispute_claim"], ["CREATE_REFUND"], [""], ["toString"]])(
    "denies the unknown tool %j as UNKNOWN_ACTION",
    (tool) => {
      expect(deniedCode({ ...proposal, tool })).toBe("UNKNOWN_ACTION");
    },
  );

  it("denies an unknown tool as UNKNOWN_ACTION whatever else is wrong", () => {
    expect(deniedCode({ tool: "create_payout" })).toBe("UNKNOWN_ACTION");
    expect(deniedCode({ tool: "create_payout", args: 7, principal: "admin" })).toBe(
      "UNKNOWN_ACTION",
    );
  });

  it("says what was wrong in the reason's detail", () => {
    const result = normalize(withArgs({ amount: { value: "1,000.00", currency_code: "USD" } }));
    expect(result).toEqual({
      ok: false,
      reason: { code: "INVALID_PROPOSAL", detail: expect.stringContaining("args.amount") },
    });
    const unknown = normalize({ ...proposal, tool: "create_payout" });
    expect(unknown).toEqual({
      ok: false,
      reason: { code: "UNKNOWN_ACTION", detail: expect.stringContaining("create_payout") },
    });
  });
});
