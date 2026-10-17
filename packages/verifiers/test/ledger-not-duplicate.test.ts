import { describe, expect, it } from "vitest";
import { type RecordSnapshots, runVerifiers } from "../src/index";
import { execution, intent } from "./fixtures";

function notDuplicate(records: RecordSnapshots) {
  return runVerifiers(intent, records).find((entry) => entry.verifier === "ledger.not_duplicate");
}

// An earlier execution that refunded the intent's own capture.
const sameCapture = { ...execution, id: "exe_0003", captureId: "7YL89768KH2865638" };

describe("ledger.not_duplicate", () => {
  it("passes when nothing has executed", () => {
    expect(notDuplicate({ executions: [] })?.result).toBe("pass");
  });

  it("passes when earlier executions target other captures or none", () => {
    const payout = { ...execution, id: "exe_0008", captureId: null };
    expect(notDuplicate({ executions: [execution, payout] })?.result).toBe("pass");
  });

  it("fails when an earlier execution targets the same capture", () => {
    expect(notDuplicate({ executions: [execution, sameCapture] })?.result).toBe("fail");
  });

  it("fails on an earlier execution on the capture by another principal", () => {
    const other = { ...sameCapture, principal: "ops-agent" };
    expect(notDuplicate({ executions: [other] })?.result).toBe("fail");
  });

  it("still fails on an earlier execution on the capture whose amount is malformed", () => {
    const malformed = { ...sameCapture, amount: { minor: -2500, currency: "USD" as const } };
    const entry = notDuplicate({ executions: [malformed] });
    expect(entry?.result).toBe("fail");
    expect(entry?.detail).toBe("Execution exe_0003 already targeted capture 7YL89768KH2865638");
  });

  it("is unknown without an execution history", () => {
    expect(notDuplicate({})?.result).toBe("unknown");
  });

  it("names the history looked up by the capture when there's no duplicate", () => {
    const expected = [{ call: "audit log executions", id: "7YL89768KH2865638" }];
    expect(notDuplicate({ executions: [execution] })?.records).toEqual(expected);
    expect(notDuplicate({})?.records).toEqual(expected);
  });

  it("names the earlier execution when there is one", () => {
    const entry = notDuplicate({ executions: [sameCapture] });
    expect(entry?.records).toEqual([{ call: "audit log executions", id: "exe_0003" }]);
    expect(entry?.detail).toBe(
      "Execution exe_0003 already moved $25.00 on capture 7YL89768KH2865638",
    );
  });
});
