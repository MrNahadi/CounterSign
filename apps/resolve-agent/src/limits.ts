import type { Environment } from "@countersign/db";

// Bounds on AI cost (ADR 0031): a runaway or broken day can't spend unbounded model calls.

export const DEFAULT_DAILY_RUN_CAP = 200;

/**
 * `RESOLVE_DAILY_RUN_CAP`: a positive whole number of runs per UTC date, or 200 when unset or
 * blank. Throws, naming the variable and never its value, for anything else.
 */
export function parseDailyCap(env: Environment): number {
  const raw = env.RESOLVE_DAILY_RUN_CAP?.trim();
  if (raw === undefined || raw === "") return DEFAULT_DAILY_RUN_CAP;
  const cap = /^[1-9][0-9]{0,8}$/.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isSafeInteger(cap)) {
    throw new Error("RESOLVE_DAILY_RUN_CAP must be a whole number of 1 or more.");
  }
  return cap;
}

/** The UTC date (`YYYY-MM-DD`) a run counts against. */
export const utcDate = (at: Date): string => at.toISOString().slice(0, 10);
