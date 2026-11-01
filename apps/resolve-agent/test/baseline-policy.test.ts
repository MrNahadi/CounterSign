import { describe, expect, it } from "vitest";
import { BASELINE_REFUSALS, parseBaselinePolicy } from "../src/baseline-policy";

const PROBLEM = "RESOLVE_BASELINE must be on, scenarios or off. Baseline mode is off.";

describe("parseBaselinePolicy", () => {
  it("is on when RESOLVE_BASELINE is unset or blank", () => {
    expect(parseBaselinePolicy({})).toEqual({ policy: "on", problem: null });
    expect(parseBaselinePolicy({ RESOLVE_BASELINE: "" })).toEqual({ policy: "on", problem: null });
    expect(parseBaselinePolicy({ RESOLVE_BASELINE: "  " })).toEqual({
      policy: "on",
      problem: null,
    });
  });

  it("reads on, scenarios and off exactly", () => {
    for (const policy of ["on", "scenarios", "off"] as const) {
      expect(parseBaselinePolicy({ RESOLVE_BASELINE: policy })).toEqual({ policy, problem: null });
    }
  });

  it("counts any other value as off, with the startup sentence", () => {
    for (const raw of ["ON", "Scenarios", "true", "1", "no", " on", "scenarios ", "of"]) {
      expect(parseBaselinePolicy({ RESOLVE_BASELINE: raw })).toEqual({
        policy: "off",
        problem: PROBLEM,
      });
    }
  });

  it("holds the refusal sentences", () => {
    expect(BASELINE_REFUSALS).toEqual({
      scenariosOnly:
        "Here, baseline mode runs only the demo scenarios. Start one from the console's start page.",
      off: "Baseline mode is off on this Resolve.",
      noToken: "Baseline mode here starts from the console's start page.",
    });
  });
});
