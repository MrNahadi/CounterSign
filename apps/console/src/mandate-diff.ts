import type { Mandate } from "@countersign/mandate";
import { CURRENCIES } from "@countersign/mandate/money";
import { readBackMandate, readBackRule } from "./mandate-readback";

// The diff between the mandate in force and a compiled draft (PLAN E2, brief §6 step 3), in the
// read-back's own words, so each side reads as the gate would enforce it. Rules are matched by id,
// limits by currency. Rule order isn't a change: the strictest matching rule wins wherever it sits.
// Written by this code from the validated mandates, never by the model. Client-safe.

export type DiffKind = "added" | "removed" | "changed";

export type DiffItem = {
  area: "rule" | "limit" | "payees" | "time_zone";
  /** The rule id, the currency, or the area's name. */
  id: string;
  kind: DiffKind;
  /** The lines as they read now, or null for an added item. */
  before: string[] | null;
  /** The lines as the draft reads, or null for a removed item. */
  after: string[] | null;
};

export type MandateDiff = {
  items: DiffItem[];
  /** Rules with the same id that read and decide the same. */
  unchangedRules: number;
};

/** JSON with object keys sorted, so two equal values compare equal whatever their key order. */
export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/**
 * A rule as the gate reads it: one action or a list of them mean the same (`ruleActions`), and so
 * does the list in any order. The compiler always writes a list, so a string in the mandate in
 * force mustn't read as a change.
 */
function ruleKey(rule: Mandate["rules"][number]): string {
  const actions = typeof rule.action === "string" ? [rule.action] : [...rule.action];
  return stableJson({ ...rule, action: [...new Set(actions)].sort() });
}

function ruleLines(rule: Mandate["rules"][number]): string[] {
  const read = readBackRule(rule);
  return [read.sentence, read.checks, read.reason].filter((line): line is string => line !== null);
}

function changeOf(
  area: DiffItem["area"],
  id: string,
  before: string[] | null,
  after: string[] | null,
): DiffItem {
  const kind: DiffKind = before === null ? "added" : after === null ? "removed" : "changed";
  return { area, id, kind, before, after };
}

export function diffMandates(base: Mandate, draft: Mandate): MandateDiff {
  const items: DiffItem[] = [];
  let unchangedRules = 0;
  const draftRules = new Map(draft.rules.map((rule) => [rule.id, rule]));
  const baseIds = new Set(base.rules.map((rule) => rule.id));

  for (const rule of base.rules) {
    const next = draftRules.get(rule.id);
    if (next === undefined) {
      items.push(changeOf("rule", rule.id, ruleLines(rule), null));
    } else if (ruleKey(rule) !== ruleKey(next)) {
      items.push(changeOf("rule", rule.id, ruleLines(rule), ruleLines(next)));
    } else {
      unchangedRules++;
    }
  }
  for (const rule of draft.rules) {
    if (!baseIds.has(rule.id)) items.push(changeOf("rule", rule.id, null, ruleLines(rule)));
  }

  // The read-back words a currency with no limit too, so a limit added or dropped reads as changed.
  const baseLimits = readBackMandate(base).limits;
  const draftLimits = readBackMandate(draft).limits;
  CURRENCIES.forEach((currency, index) => {
    const before = base.limits.find((limit) => limit.currency === currency);
    const after = draft.limits.find((limit) => limit.currency === currency);
    if (stableJson(before ?? null) === stableJson(after ?? null)) return;
    const was = baseLimits[index];
    const now = draftLimits[index];
    if (was === undefined || now === undefined) return;
    items.push(changeOf("limit", currency, [was], [now]));
  });

  if (stableJson(base.payees ?? []) !== stableJson(draft.payees ?? [])) {
    const words = (m: Mandate) => readBackMandate(m).payees;
    items.push(changeOf("payees", "payees", words(base), words(draft)));
  }
  if (base.time_zone !== draft.time_zone) {
    items.push(changeOf("time_zone", "time zone", [base.time_zone], [draft.time_zone]));
  }
  return { items, unchangedRules };
}
