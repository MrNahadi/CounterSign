import type {
  CaptureSnapshot,
  DisputeRecordSnapshot,
  RecordSnapshots,
} from "@countersign/verifiers";
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
        target: { kind: "capture", captureId: "CAP-1042", orderId: "ORD-1042" },
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
    expect(result.intent.target).toEqual({ kind: "capture", captureId: "CAP-1042", orderId: null });
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

  it("accepts and ignores invoice_id on a refund, as it does the note", () => {
    expect(normalize(withArgs({ invoice_id: "INV-1" }))).toEqual(normalize(proposal));
    expect(deniedCode(withArgs({ invoice_id: "" }))).toBe("INVALID_PROPOSAL");
  });

  it("denies unrecognized fields as INVALID_PROPOSAL rather than ignoring them", () => {
    expect(deniedCode(withArgs({ invoice_ref: "INV-1" }))).toBe("INVALID_PROPOSAL");
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

  it.each([["create_payout"], ["refund_everything"], ["CREATE_REFUND"], [""], ["toString"]])(
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

const dispute: DisputeRecordSnapshot = {
  call: "GET /v1/customer/disputes/{id}",
  id: "PP-D-4012",
  status: "WAITING_FOR_SELLER_RESPONSE",
  amount: { minor: 4500, currency: "USD" },
};

const disputeRecords: RecordSnapshots = { disputeRecords: [dispute] };

const acceptClaim = {
  tool: "accept_dispute_claim",
  args: { dispute_id: "PP-D-4012", note: "Refunding in full, sorry for the trouble." },
  justification: { ticket_id: "TKT-90", claim: "not_received" },
};

const provideEvidence = {
  tool: "provide_dispute_evidence",
  args: {
    dispute_id: "PP-D-4012",
    evidence: [
      {
        evidence_type: "PROOF_OF_FULFILLMENT",
        notes: "Shipped on 2 Oct.",
        tracking_numbers: ["TRK1"],
      },
      { evidence_type: "OTHER", notes: "The buyer confirmed receipt by email." },
    ],
  },
};

const makeOffer = {
  tool: "make_offer",
  args: {
    dispute_id: "PP-D-4012",
    offer_type: "REFUND",
    offer_amount: { value: "20.00", currency_code: "USD" },
    note: "Half back for the scuffed box.",
  },
  justification: {},
};

function normalizeDispute(input: unknown, snapshots: RecordSnapshots = disputeRecords) {
  return normalize(input, snapshots);
}

function deniedDispute(input: unknown, snapshots: RecordSnapshots = disputeRecords) {
  return deniedCode(input, snapshots);
}

function withDisputeArgs(base: { args: object }, args: Record<string, unknown>) {
  return { ...base, args: { ...base.args, ...args } };
}

describe("normalizeProposal for the dispute tools", () => {
  it("makes accept_dispute_claim an intent on the dispute, for the dispute's amount", () => {
    expect(normalizeDispute(acceptClaim)).toEqual({
      ok: true,
      intent: {
        principal: "support-agent",
        rail: "paypal",
        action: "paypal.dispute.accept_claim",
        amount: { minor: 4500, currency: "USD" },
        target: { kind: "dispute", disputeId: "PP-D-4012" },
        ticketId: "TKT-90",
        params: { note: "Refunding in full, sorry for the trouble." },
        claim: "not_received",
        mandateVersion: 3,
      },
    });
  });

  it("makes provide_dispute_evidence an intent holding each evidence item", () => {
    const result = normalizeDispute(provideEvidence);
    if (!result.ok) throw new Error(result.reason.detail);
    expect(result.intent).toMatchObject({
      action: "paypal.dispute.provide_evidence",
      amount: { minor: 4500, currency: "USD" },
      target: { kind: "dispute", disputeId: "PP-D-4012" },
      ticketId: null,
      claim: null,
      params: {
        evidence: [
          {
            evidenceType: "PROOF_OF_FULFILLMENT",
            notes: "Shipped on 2 Oct.",
            trackingNumbers: ["TRK1"],
          },
          {
            evidenceType: "OTHER",
            notes: "The buyer confirmed receipt by email.",
            trackingNumbers: null,
          },
        ],
      },
    });
  });

  it("makes make_offer an intent for the offer amount, or the dispute's without one", () => {
    const offer = normalizeDispute(makeOffer);
    if (!offer.ok) throw new Error(offer.reason.detail);
    expect(offer.intent).toMatchObject({
      action: "paypal.dispute.make_offer",
      amount: { minor: 2000, currency: "USD" },
      target: { kind: "dispute", disputeId: "PP-D-4012" },
      params: { offerType: "REFUND", note: "Half back for the scuffed box." },
    });

    const replacement = normalizeDispute({
      ...makeOffer,
      args: {
        dispute_id: "PP-D-4012",
        offer_type: "REPLACEMENT_WITHOUT_REFUND",
        note: "We'll send a new one.",
      },
    });
    if (!replacement.ok) throw new Error(replacement.reason.detail);
    expect(replacement.intent.amount).toEqual({ minor: 4500, currency: "USD" });
    expect(replacement.intent.params).toEqual({
      offerType: "REPLACEMENT_WITHOUT_REFUND",
      note: "We'll send a new one.",
    });
  });

  it.each([
    ["an empty note", withDisputeArgs(acceptClaim, { note: "" })],
    ["a note over 2,000 characters", withDisputeArgs(acceptClaim, { note: "a".repeat(2001) })],
    ["a missing note", { ...acceptClaim, args: { dispute_id: "PP-D-4012" } }],
    ["a blank dispute ID", withDisputeArgs(acceptClaim, { dispute_id: " " })],
    ["an unknown argument", withDisputeArgs(acceptClaim, { reason: "goodwill" })],
    ["an unknown justification key", { ...acceptClaim, justification: { purpose: "x" } }],
    ["no evidence", withDisputeArgs(provideEvidence, { evidence: [] })],
    [
      "eleven evidence items",
      withDisputeArgs(provideEvidence, {
        evidence: Array.from({ length: 11 }, () => ({ evidence_type: "OTHER", notes: "n" })),
      }),
    ],
    [
      "an unknown evidence type",
      withDisputeArgs(provideEvidence, { evidence: [{ evidence_type: "SELFIE", notes: "n" }] }),
    ],
    [
      "evidence with empty notes",
      withDisputeArgs(provideEvidence, { evidence: [{ evidence_type: "OTHER", notes: "" }] }),
    ],
    [
      "an evidence item with an unknown key",
      withDisputeArgs(provideEvidence, {
        evidence: [{ evidence_type: "OTHER", notes: "n", documents: [] }],
      }),
    ],
    ["an unknown offer type", withDisputeArgs(makeOffer, { offer_type: "STORE_CREDIT" })],
    [
      "a refund offer with no amount",
      { ...makeOffer, args: { dispute_id: "PP-D-4012", offer_type: "REFUND", note: "n" } },
    ],
    [
      "a replacement offer with an amount",
      withDisputeArgs(makeOffer, { offer_type: "REPLACEMENT_WITHOUT_REFUND" }),
    ],
    [
      "a malformed offer amount",
      withDisputeArgs(makeOffer, { offer_amount: { value: "20.001", currency_code: "USD" } }),
    ],
    [
      "a zero offer amount",
      withDisputeArgs(makeOffer, { offer_amount: { value: "0.00", currency_code: "USD" } }),
    ],
    [
      "an offer in another currency than the dispute's",
      withDisputeArgs(makeOffer, { offer_amount: { value: "2000.00", currency_code: "KES" } }),
    ],
    ["a missing offer note", { ...makeOffer, args: { ...makeOffer.args, note: undefined } }],
  ])("denies %s as INVALID_PROPOSAL", (_label, input) => {
    expect(deniedDispute(input)).toBe("INVALID_PROPOSAL");
  });

  it("denies a dispute with no record as TARGET_UNKNOWN, naming the dispute", () => {
    for (const input of [acceptClaim, provideEvidence, makeOffer]) {
      expect(normalizeDispute(input, {})).toEqual({
        ok: false,
        reason: { code: "TARGET_UNKNOWN", detail: "No record of dispute PP-D-4012" },
      });
    }
  });

  it("denies a dispute in an unsupported currency as TARGET_UNKNOWN, naming the dispute", () => {
    const euro = { disputeRecords: [{ ...dispute, amount: { minor: 4500, currency: "EUR" } }] };
    for (const input of [acceptClaim, provideEvidence, makeOffer]) {
      expect(normalizeDispute(input, euro)).toEqual({
        ok: false,
        reason: {
          code: "TARGET_UNKNOWN",
          detail: "Dispute PP-D-4012 is in EUR, which Countersign doesn't support",
        },
      });
    }
  });

  it("checks the arguments before the record, so a bad call with no record is INVALID_PROPOSAL", () => {
    expect(deniedDispute(withDisputeArgs(acceptClaim, { note: "" }), {})).toBe("INVALID_PROPOSAL");
  });
});
