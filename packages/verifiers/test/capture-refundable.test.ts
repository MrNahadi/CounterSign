import type { Intent } from "@countersign/mandate";
import { describe, expect, it } from "vitest";
import { type CaptureSnapshot, type RecordSnapshots, runVerifiers } from "../src/index";
import { capture, intent } from "./fixtures";

function refundable(records: RecordSnapshots, asked: Intent = intent) {
  return runVerifiers(asked, records).find((entry) => entry.verifier === "capture.refundable");
}

describe("capture.refundable", () => {
  it("passes for a completed capture within its amount", () => {
    expect(refundable({ captures: [capture] })?.result).toBe("pass");
  });

  it("passes for a partially refunded capture within what's left", () => {
    const partly: CaptureSnapshot = {
      ...capture,
      status: "PARTIALLY_REFUNDED",
      refundedMinor: 3000,
    };
    expect(refundable({ captures: [partly] })?.result).toBe("pass");
  });

  it("passes for exactly what's left", () => {
    const partly: CaptureSnapshot = {
      ...capture,
      status: "PARTIALLY_REFUNDED",
      refundedMinor: 1200,
    };
    const all: Intent = { ...intent, amount: { minor: 3600, currency: "USD" } };
    expect(refundable({ captures: [partly] }, all)?.result).toBe("pass");
  });

  it("fails when more is asked for than is left", () => {
    const partly: CaptureSnapshot = {
      ...capture,
      status: "PARTIALLY_REFUNDED",
      refundedMinor: 3001,
    };
    expect(refundable({ captures: [partly] })?.result).toBe("fail");
  });

  it("fails when more is asked for than was captured", () => {
    const tooMuch: Intent = { ...intent, amount: { minor: 4801, currency: "USD" } };
    expect(refundable({ captures: [capture] }, tooMuch)?.result).toBe("fail");
  });

  it.each(["REFUNDED", "PENDING", "DECLINED", "FAILED"])("fails for a %s capture", (status) => {
    expect(refundable({ captures: [{ ...capture, status }] })?.result).toBe("fail");
  });

  it("fails when the capture is in another currency", () => {
    const shillings: CaptureSnapshot = { ...capture, amount: { minor: 480000, currency: "KES" } };
    expect(refundable({ captures: [shillings] })?.result).toBe("fail");
  });

  it("is unknown without a capture record", () => {
    expect(refundable({})?.result).toBe("unknown");
    expect(refundable({ captures: [] })?.result).toBe("unknown");
  });

  it("is unknown when the only capture record is for another capture", () => {
    const other: CaptureSnapshot = { ...capture, id: "8YL89768KH2865638" };
    expect(refundable({ captures: [other] })?.result).toBe("unknown");
  });

  it.each<[string, Partial<CaptureSnapshot>]>([
    ["a negative refunded total", { refundedMinor: -100 }],
    ["more refunded than captured", { refundedMinor: 4801 }],
    ["a fractional amount", { amount: { minor: 4800.5, currency: "USD" } }],
  ])("is unknown when the record has %s", (_case, change) => {
    expect(refundable({ captures: [{ ...capture, ...change }] })?.result).toBe("unknown");
  });

  it("names the capture call and record ID, even when the record is missing", () => {
    const expected = [{ call: "GET /v2/payments/captures/{id}", id: "7YL89768KH2865638" }];
    expect(refundable({ captures: [capture] })?.records).toEqual(expected);
    expect(refundable({})?.records).toEqual(expected);
  });

  it("says how much is left to refund", () => {
    const partly: CaptureSnapshot = {
      ...capture,
      status: "PARTIALLY_REFUNDED",
      refundedMinor: 3001,
    };
    expect(refundable({ captures: [partly] })?.detail).toBe(
      "$18.00 asked for, $17.99 of $48.00 left to refund, capture PARTIALLY_REFUNDED",
    );
  });
});
