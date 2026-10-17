import { describe, expect, it } from "vitest";
import { type DisputesSnapshot, type RecordSnapshots, runVerifiers } from "../src/index";
import { disputes, intent } from "./fixtures";

function noneOpen(records: RecordSnapshots) {
  return runVerifiers(intent, records).find((entry) => entry.verifier === "dispute.none_open");
}

const dispute = { id: "PP-D-27803", status: "WAITING_FOR_SELLER_RESPONSE" };

describe("dispute.none_open", () => {
  it("passes when the lookup ran and found no dispute", () => {
    expect(noneOpen({ disputes: [disputes] })?.result).toBe("pass");
  });

  it("passes when the only dispute on the capture is resolved", () => {
    const resolved: DisputesSnapshot = {
      ...disputes,
      disputes: [{ ...dispute, status: "RESOLVED" }],
    };
    expect(noneOpen({ disputes: [resolved] })?.result).toBe("pass");
  });

  it.each([
    "OPEN",
    "WAITING_FOR_BUYER_RESPONSE",
    "WAITING_FOR_SELLER_RESPONSE",
    "UNDER_REVIEW",
    "OTHER",
  ])("fails on a %s dispute on the capture", (status) => {
    const open: DisputesSnapshot = { ...disputes, disputes: [{ ...dispute, status }] };
    expect(noneOpen({ disputes: [open] })?.result).toBe("fail");
  });

  it("fails when any dispute in the capture's lookup is open, beside resolved ones", () => {
    const mixed: DisputesSnapshot = {
      ...disputes,
      disputes: [{ ...dispute, id: "PP-D-27802", status: "RESOLVED" }, dispute],
    };
    expect(noneOpen({ disputes: [mixed] })?.result).toBe("fail");
  });

  it("ignores an open dispute found by another capture's lookup", () => {
    const elsewhere: DisputesSnapshot = {
      ...disputes,
      id: "8YL89768KH2865639",
      disputes: [dispute],
    };
    expect(noneOpen({ disputes: [elsewhere, disputes] })?.result).toBe("pass");
  });

  it("is unknown when the lookup didn't run for the capture", () => {
    expect(noneOpen({})?.result).toBe("unknown");
    expect(noneOpen({ disputes: [{ ...disputes, id: "8YL89768KH2865639" }] })?.result).toBe(
      "unknown",
    );
  });

  it("names the lookup call and the capture it was run for", () => {
    const expected = [{ call: "GET /v1/customer/disputes", id: "7YL89768KH2865638" }];
    expect(noneOpen({ disputes: [disputes] })?.records).toEqual(expected);
    expect(noneOpen({})?.records).toEqual(expected);
  });

  it("names the open dispute in its detail", () => {
    const open: DisputesSnapshot = { ...disputes, disputes: [dispute] };
    expect(noneOpen({ disputes: [open] })?.detail).toBe(
      "Dispute PP-D-27803 is WAITING_FOR_SELLER_RESPONSE on capture 7YL89768KH2865638",
    );
  });
});
