import type { Environment } from "@countersign/db";
import { z } from "zod";

// Where baseline mode may run (ADR 0043): `on` anywhere (local, phase 8's behaviour),
// `scenarios` only from the demo scenarios the console's start page launches (the hosted demo,
// so no visitor text reaches an unguarded agent), `off` nowhere. A value Resolve can't read counts
// as `off`: baseline is the unguarded mode, so doubt closes it.

export type BaselinePolicy = "on" | "scenarios" | "off";

const PolicySchema = z.enum(["on", "scenarios", "off"]);

export const BASELINE_POLICY_PROBLEM =
  "RESOLVE_BASELINE must be on, scenarios or off. Baseline mode is off.";

export const BASELINE_REFUSALS = {
  scenariosOnly:
    "Here, baseline mode runs only the demo scenarios. Start one from the console's start page.",
  off: "Baseline mode is off on this Resolve.",
  noToken: "Baseline mode here starts from the console's start page.",
} as const;

/**
 * `RESOLVE_BASELINE`: `on` when unset or blank; exactly `on`, `scenarios` or `off`; anything else
 * is `off`, with the startup line to log. The line names the variable, never its value.
 */
export function parseBaselinePolicy(env: Environment): {
  policy: BaselinePolicy;
  problem: string | null;
} {
  const raw = env.RESOLVE_BASELINE;
  if (raw === undefined || raw.trim() === "") return { policy: "on", problem: null };
  const parsed = PolicySchema.safeParse(raw);
  return parsed.success
    ? { policy: parsed.data, problem: null }
    : { policy: "off", problem: BASELINE_POLICY_PROBLEM };
}
