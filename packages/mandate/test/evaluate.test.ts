import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  evaluate,
  type Intent,
  parseMandate,
  type ShipmentStatus,
  type TraceEntry,
  type VerifierName,
  type VerifierResult,
} from "../src/index";

const parsed = parseMandate(
  JSON.parse(readFileSync(new URL("../fixtures/kikapu-studio-v3.json", import.meta.url), "utf8")),
);
if (!parsed.ok) throw new Error(parsed.error);
const mandate = parsed.mandate;

function refund(change: Partial<Intent> = {}): Intent {
  return {
    principal: "support-agent",
    rail: "paypal",
    action: "paypal.refund",
    amount: { minor: 1800, currency: "USD" },
    target: { captureId: "7YL89768KH2865638", orderId: "5O190127TN364715T" },
    ticketId: "tkt_0042",
    claim: "not_received",
    mandateVersion: 3,
    ...change,
  };
}

function entry(verifier: VerifierName, result: VerifierResult, value?: ShipmentStatus): TraceEntry {
  return {
    verifier,
    result,
    records: [{ call: "fixture", id: "rec_1" }],
    detail: `${verifier} ${result}`,
    ...(value ? { value } : {}),
  };
}

// A refund trace where every verifier passes, with the given shipment status.
function passing(status: ShipmentStatus | null = "lost"): TraceEntry[] {
  return [
    entry("capture.refundable", "pass"),
    entry("ticket.from_payer", "pass"),
    entry("dispute.none_open", "pass"),
    status ? entry("shipment.status", "pass", status) : entry("shipment.status", "unknown"),
    entry("evidence.photo_present", "pass"),
    entry("ledger.not_duplicate", "pass"),
  ];
}

function withResult(trace: TraceEntry[], verifier: VerifierName, result: VerifierResult) {
  return trace.map((item) => (item.verifier === verifier ? entry(verifier, result) : item));
}

const codes = (evaluation: ReturnType<typeof evaluate>) =>
  evaluation.reasons.map((reason) => reason.code);

// The fixture mandate with its rules replaced, validated like any mandate file.
function withRules(rules: unknown[]) {
  const result = parseMandate({ ...structuredClone(mandate), rules });
  if (!result.ok) throw new Error(result.error);
  return result.mandate;
}

describe("step 1: matching rules", () => {
  it("allows a lost parcel under the cap through its rule", () => {
    const result = evaluate({ mandate, intent: refund(), trace: passing("lost") });
    expect(result).toEqual({ outcome: "allow", reasons: [], matchedRules: ["refund-lost-parcel"] });
  });

  it("matches the claim against one value", () => {
    const damaged = evaluate({ mandate, intent: refund({ claim: "damaged" }), trace: passing() });
    expect(damaged.matchedRules).toEqual(["refund-damaged"]);
    const wrongItem = evaluate({
      mandate,
      intent: refund({ claim: "wrong_item" }),
      trace: passing(),
    });
    expect(wrongItem.matchedRules).toEqual(["refund-wrong-item"]);
  });

  it("matches a claim-tested rule only when the intent makes that claim", () => {
    const result = evaluate({ mandate, intent: refund({ claim: null }), trace: passing("lost") });
    expect(result.matchedRules).toEqual([]);
  });

  it("matches shipment.status against its list of values", () => {
    const stalled = evaluate({ mandate, intent: refund(), trace: passing("stalled_10d") });
    expect(stalled.matchedRules).toEqual(["refund-lost-parcel"]);
    const delivered = evaluate({ mandate, intent: refund(), trace: passing("delivered") });
    expect(delivered.matchedRules).toEqual(["refund-delivered-claim"]);
    const inTransit = evaluate({ mandate, intent: refund(), trace: passing("in_transit") });
    expect(inTransit.matchedRules).toEqual([]);
  });

  it("never matches an unknown shipment status", () => {
    const unknown = evaluate({ mandate, intent: refund(), trace: passing(null) });
    expect(unknown.matchedRules).toEqual([]);
    const missing = passing().filter((item) => item.verifier !== "shipment.status");
    expect(evaluate({ mandate, intent: refund(), trace: missing }).matchedRules).toEqual([]);
    const noValue = passing().map((item) =>
      item.verifier === "shipment.status" ? entry("shipment.status", "pass") : item,
    );
    expect(evaluate({ mandate, intent: refund(), trace: noValue }).matchedRules).toEqual([]);
    const conflicting = [...passing("lost"), entry("shipment.status", "pass", "delivered")];
    expect(evaluate({ mandate, intent: refund(), trace: conflicting }).matchedRules).toEqual([]);
    const thenUnknown = [...passing("lost"), entry("shipment.status", "unknown")];
    expect(evaluate({ mandate, intent: refund(), trace: thenUnknown }).matchedRules).toEqual([]);
  });

  it("matches on the rail", () => {
    const rules = [
      { id: "mpesa-only", action: "paypal.refund", when: { rail: "mpesa" }, decide: "allow" },
      { id: "paypal-only", action: "paypal.refund", when: { rail: "paypal" }, decide: "allow" },
    ];
    const result = evaluate({ mandate: withRules(rules), intent: refund(), trace: passing() });
    expect(result.matchedRules).toEqual(["paypal-only"]);
  });

  it("matches every intent for its action when the rule has no when", () => {
    const rules = [
      { id: "any-refund", action: "paypal.refund", decide: "allow" },
      { id: "any-payout", action: "paypal.payout", decide: "allow" },
    ];
    const result = evaluate({
      mandate: withRules(rules),
      intent: refund({ claim: null }),
      trace: passing(null),
    });
    expect(result).toEqual({ outcome: "allow", reasons: [], matchedRules: ["any-refund"] });
  });

  it("matches a rule from its list of actions", () => {
    const result = evaluate({
      mandate,
      intent: refund({ action: "paypal.invoice.send", claim: null }),
      trace: [],
    });
    expect(result.matchedRules).toEqual(["dispute-and-invoice-actions"]);
  });

  it("matches a rule with a max only in the max's currency", () => {
    const kes = refund({ amount: { minor: 1800, currency: "KES" } });
    expect(evaluate({ mandate, intent: kes, trace: passing("lost") }).matchedRules).toEqual([]);
  });
});

describe("step 2: requirements", () => {
  it("denies when the ticket isn't from the payer, with the verifier's detail", () => {
    const trace = withResult(passing("delivered"), "ticket.from_payer", "fail");
    const result = evaluate({ mandate, intent: refund(), trace });
    expect(result).toEqual({
      outcome: "deny",
      reasons: [{ code: "TICKET_NOT_FROM_PAYER", detail: "ticket.from_payer fail" }],
      matchedRules: ["refund-delivered-claim"],
    });
  });

  it.each<[VerifierName, VerifierResult, string]>([
    ["ticket.from_payer", "fail", "TICKET_NOT_FROM_PAYER"],
    ["ticket.from_payer", "unknown", "PAYER_UNKNOWN"],
    ["capture.refundable", "fail", "CAPTURE_NOT_REFUNDABLE"],
    ["capture.refundable", "unknown", "CAPTURE_UNKNOWN"],
    ["dispute.none_open", "fail", "DISPUTE_OPEN"],
    ["dispute.none_open", "unknown", "DISPUTES_UNKNOWN"],
    ["ledger.not_duplicate", "fail", "DUPLICATE_REFUND"],
    ["ledger.not_duplicate", "unknown", "HISTORY_UNKNOWN"],
  ])("denies a lost parcel when %s is %s, with %s", (verifier, result, code) => {
    const trace = withResult(passing("lost"), verifier, result);
    const evaluation = evaluate({ mandate, intent: refund(), trace });
    expect(evaluation.outcome).toBe("deny");
    expect(codes(evaluation)).toEqual([code]);
  });

  it.each<[VerifierResult, string]>([
    ["fail", "NO_PHOTO_EVIDENCE"],
    ["unknown", "TICKET_UNKNOWN"],
  ])("denies a damaged item when the photo check is %s, with %s", (result, code) => {
    const trace = withResult(passing(), "evidence.photo_present", result);
    const evaluation = evaluate({ mandate, intent: refund({ claim: "damaged" }), trace });
    expect(evaluation.outcome).toBe("deny");
    expect(codes(evaluation)).toEqual([code]);
  });

  it("denies a required shipment status that's unknown with SHIPMENT_STATUS_UNKNOWN", () => {
    const rules = [
      { id: "any-refund", action: "paypal.refund", require: ["shipment.status"], decide: "allow" },
    ];
    const result = evaluate({ mandate: withRules(rules), intent: refund(), trace: passing(null) });
    expect(result.outcome).toBe("deny");
    expect(codes(result)).toEqual(["SHIPMENT_STATUS_UNKNOWN"]);
  });

  it("gives one reason per failed or unknown requirement, in the rule's order", () => {
    let trace = withResult(passing("lost"), "ticket.from_payer", "fail");
    trace = withResult(trace, "dispute.none_open", "unknown");
    trace = withResult(trace, "ledger.not_duplicate", "fail");
    const result = evaluate({ mandate, intent: refund(), trace });
    expect(codes(result)).toEqual([
      "TICKET_NOT_FROM_PAYER",
      "DISPUTES_UNKNOWN",
      "DUPLICATE_REFUND",
    ]);
  });

  it("treats a required verifier missing from the trace as unknown", () => {
    const trace = passing("lost").filter((item) => item.verifier !== "capture.refundable");
    const result = evaluate({ mandate, intent: refund(), trace });
    expect(result.outcome).toBe("deny");
    expect(codes(result)).toEqual(["CAPTURE_UNKNOWN"]);
  });

  it("never reads a requirement named twice with different results as pass", () => {
    const failing = [...passing("lost"), entry("ticket.from_payer", "fail")];
    expect(codes(evaluate({ mandate, intent: refund(), trace: failing }))).toEqual([
      "TICKET_NOT_FROM_PAYER",
    ]);
    const unknown = [...passing("lost"), entry("capture.refundable", "unknown")];
    expect(codes(evaluate({ mandate, intent: refund(), trace: unknown }))).toEqual([
      "CAPTURE_UNKNOWN",
    ]);
  });

  it("denies a requirement that isn't built yet with VERIFIER_UNAVAILABLE", () => {
    const rules = [
      { id: "payout", action: "paypal.refund", require: ["payee.allowlisted"], decide: "allow" },
    ];
    const trace = [...passing(), entry("payee.allowlisted", "unknown")];
    const result = evaluate({ mandate: withRules(rules), intent: refund(), trace });
    expect(result.outcome).toBe("deny");
    expect(codes(result)).toEqual(["VERIFIER_UNAVAILABLE"]);
  });

  it("denies a step-up rule whose requirements fail, rather than holding it", () => {
    const trace = withResult(passing(), "capture.refundable", "fail");
    const result = evaluate({ mandate, intent: refund({ claim: "wrong_item" }), trace });
    expect(result.outcome).toBe("deny");
    expect(codes(result)).toEqual(["CAPTURE_NOT_REFUNDABLE"]);
  });

  it("names a repeated requirement once", () => {
    const rules = [
      {
        id: "any-refund",
        action: "paypal.refund",
        require: ["ticket.from_payer", "ticket.from_payer"],
        decide: "allow",
      },
    ];
    const trace = withResult(passing(), "ticket.from_payer", "fail");
    const result = evaluate({ mandate: withRules(rules), intent: refund(), trace });
    expect(codes(result)).toEqual(["TICKET_NOT_FROM_PAYER"]);
  });
});

describe("step 5: fallback", () => {
  it("denies a parcel in transit with NO_MATCHING_RULE, naming the mandate", () => {
    const result = evaluate({ mandate, intent: refund(), trace: passing("in_transit") });
    expect(result).toMatchObject({ outcome: "deny", matchedRules: [] });
    expect(codes(result)).toEqual(["NO_MATCHING_RULE"]);
    expect(result.reasons[0]?.detail).toContain("kikapu-studio v3");
  });

  it("denies a proposal with no claim with NO_MATCHING_RULE alone", () => {
    const result = evaluate({ mandate, intent: refund({ claim: null }), trace: passing(null) });
    expect(result.outcome).toBe("deny");
    expect(codes(result)).toEqual(["NO_MATCHING_RULE"]);
  });

  it("follows NO_MATCHING_RULE with SHIPMENT_STATUS_UNKNOWN when only the status kept a rule out", () => {
    const trace = passing(null);
    const result = evaluate({ mandate, intent: refund(), trace });
    expect(result.outcome).toBe("deny");
    expect(codes(result)).toEqual(["NO_MATCHING_RULE", "SHIPMENT_STATUS_UNKNOWN"]);
    expect(result.reasons[1]?.detail).toBe("shipment.status unknown");
  });

  it("names the unknown status even when it's missing from the trace", () => {
    const trace = passing().filter((item) => item.verifier !== "shipment.status");
    const result = evaluate({ mandate, intent: refund(), trace });
    expect(codes(result)).toEqual(["NO_MATCHING_RULE", "SHIPMENT_STATUS_UNKNOWN"]);
  });

  it("denies an action with no rules with NO_MATCHING_RULE", () => {
    const result = evaluate({
      mandate,
      intent: refund({ action: "paypal.payout", claim: null }),
      trace: [],
    });
    expect(result.outcome).toBe("deny");
    expect(codes(result)).toEqual(["NO_MATCHING_RULE"]);
  });
});

describe("step 6: unknown actions and principals", () => {
  // An action name from outside the type, as an unchecked caller could send.
  const wire = "paypal.wire" as Intent["action"];

  it("denies an unknown action with UNKNOWN_ACTION, naming it", () => {
    const result = evaluate({ mandate, intent: refund({ action: wire }), trace: passing() });
    expect(result).toMatchObject({ outcome: "deny", matchedRules: [] });
    expect(codes(result)).toEqual(["UNKNOWN_ACTION"]);
    expect(result.reasons[0]?.detail).toContain("paypal.wire");
  });

  it("denies a principal that isn't the mandate's with WRONG_MANDATE", () => {
    const result = evaluate({
      mandate,
      intent: refund({ principal: "ops-agent" }),
      trace: passing("lost"),
    });
    expect(result).toMatchObject({ outcome: "deny", matchedRules: [] });
    expect(codes(result)).toEqual(["WRONG_MANDATE"]);
    expect(result.reasons[0]?.detail).toContain("ops-agent");
  });

  it("names both when the action is unknown and the principal is wrong", () => {
    const result = evaluate({
      mandate,
      intent: refund({ action: wire, principal: "ops-agent" }),
      trace: [],
    });
    expect(codes(result)).toEqual(["UNKNOWN_ACTION", "WRONG_MANDATE"]);
  });
});

describe("rule reasons", () => {
  it("holds a delivered never-arrived claim with SHIPMENT_DELIVERED, naming the rule", () => {
    const result = evaluate({ mandate, intent: refund(), trace: passing("delivered") });
    expect(result.outcome).toBe("step_up");
    expect(codes(result)).toEqual(["SHIPMENT_DELIVERED"]);
    expect(result.reasons[0]?.detail).toContain("refund-delivered-claim");
  });

  it("holds a wrong-item claim with ALWAYS_NEEDS_APPROVAL", () => {
    const result = evaluate({ mandate, intent: refund({ claim: "wrong_item" }), trace: passing() });
    expect(result).toMatchObject({ outcome: "step_up", matchedRules: ["refund-wrong-item"] });
    expect(codes(result)).toEqual(["ALWAYS_NEEDS_APPROVAL"]);
  });

  it("denies through a deny rule with its reason, naming the rule", () => {
    const rules = [
      { id: "no-refunds", action: "paypal.refund", decide: "deny", reason: "RULE_DENIES" },
    ];
    const result = evaluate({ mandate: withRules(rules), intent: refund(), trace: passing() });
    expect(result.outcome).toBe("deny");
    expect(codes(result)).toEqual(["RULE_DENIES"]);
    expect(result.reasons[0]?.detail).toContain("no-refunds");
  });
});
