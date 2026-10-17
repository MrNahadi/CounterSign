import { describe, expect, it } from "vitest";
import {
  ACTIONS,
  CLAIMS,
  CURRENCIES,
  type Currency,
  evaluate,
  type Intent,
  type Mandate,
  parseMandate,
  RAILS,
  RULE_REASON_CODES,
  type Rule,
  SHIPMENT_STATUSES,
  type TraceEntry,
  type Usage,
  VERIFIER_RESULTS,
  VERIFIERS,
} from "../src/index";

// A small seeded generator (mulberry32), so a failure replays exactly.
function generator(seed: number) {
  let state = seed >>> 0;
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const chance = (p: number) => next() < p;
  const int = (max: number) => Math.floor(next() * (max + 1));
  const pick = <T>(items: readonly T[]): T => items[int(items.length - 1)] as T;
  const some = <T>(items: readonly T[], p: number): T[] => items.filter(() => chance(p));
  return { chance, int, pick, some };
}

type Random = ReturnType<typeof generator>;

// Refund-heavy, so most generated rules can match the generated intents.
const actions = ["paypal.refund", "paypal.refund", "paypal.refund", ...ACTIONS] as const;
const amounts = [500, 1800, 5000, 8000, 9600, 24000, 1500000];

function randomRule(random: Random, index: number): unknown {
  const rule: Record<string, unknown> = {
    id: `rule-${index}`,
    action: random.chance(0.8)
      ? random.pick(actions)
      : [random.pick(actions), random.pick(actions)],
  };
  const when: Record<string, unknown> = {};
  if (random.chance(0.5)) when.claim = random.pick(CLAIMS);
  if (random.chance(0.5)) {
    when["shipment.status"] = [random.pick(SHIPMENT_STATUSES), random.pick(SHIPMENT_STATUSES)];
  }
  if (random.chance(0.2)) when.rail = random.pick(RAILS);
  if (Object.keys(when).length > 0) rule.when = when;
  if (random.chance(0.7)) rule.require = random.some(VERIFIERS.slice(0, 7), 0.3);
  if (random.chance(0.5))
    rule.max = { amount: random.pick(amounts), currency: random.pick(CURRENCIES) };
  const decide = random.pick(["allow", "allow", "allow", "step_up", "deny"] as const);
  rule.decide = decide;
  if (decide === "step_up") rule.reason = random.pick(RULE_REASON_CODES);
  if (decide === "deny") rule.reason = random.pick(["SHIPMENT_DELIVERED", "RULE_DENIES"]);
  return rule;
}

function randomMandate(random: Random): Mandate {
  const limits = CURRENCIES.filter(() => random.chance(0.7)).map((currency) => ({
    currency,
    ...(random.chance(0.8) ? { per_day_total: random.pick(amounts) * random.int(5) } : {}),
    per_day_count: random.int(10),
  }));
  const rules = Array.from({ length: 1 + random.int(2) }, (_, index) => randomRule(random, index));
  const parsed = parseMandate({
    id: "random",
    version: 1,
    principal: "support-agent",
    fallback: "deny",
    limits,
    rules,
  });
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.mandate;
}

function randomIntent(random: Random): Intent {
  return {
    principal: random.chance(0.95) ? "support-agent" : "ops-agent",
    rail: random.chance(0.9) ? "paypal" : random.pick(RAILS),
    action: random.chance(0.97)
      ? random.chance(0.8)
        ? "paypal.refund"
        : random.pick(ACTIONS)
      : ("paypal.wire" as Intent["action"]),
    amount: { minor: random.pick(amounts), currency: random.chance(0.8) ? "USD" : "KES" },
    target: {
      captureId: "7YL89768KH2865638",
      orderId: random.chance(0.9) ? "5O190127TN364715T" : null,
    },
    ticketId: "tkt_0042",
    claim: random.chance(0.85) ? random.pick(CLAIMS) : null,
    mandateVersion: 1,
  };
}

// Each verifier appears zero, one or two times, mostly passing.
function randomTrace(random: Random): TraceEntry[] {
  return VERIFIERS.flatMap((verifier) =>
    Array.from({ length: random.pick([0, 1, 1, 1, 1, 1, 1, 1, 2]) }, (): TraceEntry => {
      const result = random.chance(0.9) ? "pass" : random.pick(VERIFIER_RESULTS);
      const value =
        verifier === "shipment.status" && random.chance(0.9)
          ? random.pick(SHIPMENT_STATUSES)
          : undefined;
      return {
        verifier,
        result,
        records: [{ call: "fixture", id: null }],
        detail: `${verifier} ${result}`,
        ...(value ? { value } : {}),
      };
    }),
  );
}

function randomUsage(random: Random): Usage {
  if (random.chance(0.15)) return { known: false, detail: "No execution history given" };
  const today = (currency: Currency) => ({
    count: random.int(4),
    total: { minor: random.chance(0.5) ? 0 : random.pick(amounts) * random.int(3), currency },
  });
  return { known: true, date: "2026-10-17", perCurrency: { USD: today("USD"), KES: today("KES") } };
}

// The oracle: brief §6 written out independently of the evaluator. A rule can only allow if it
// matches the intent, its decide is allow, every requirement is in the trace and passes, the
// amount is within its max, usage is known and today's limits hold.
function passes(trace: TraceEntry[], verifier: string): boolean {
  const entries = trace.filter((item) => item.verifier === verifier);
  return entries.length > 0 && entries.every((item) => item.result === "pass");
}

function matches(rule: Rule, intent: Intent, trace: TraceEntry[]): boolean {
  const ruleActions: readonly string[] =
    typeof rule.action === "string" ? [rule.action] : rule.action;
  if (!ruleActions.includes(intent.action)) return false;
  if (rule.max && rule.max.currency !== intent.amount.currency) return false;
  if (rule.when?.claim !== undefined && rule.when.claim !== intent.claim) return false;
  if (rule.when?.rail !== undefined && rule.when.rail !== intent.rail) return false;
  const statuses = rule.when?.["shipment.status"];
  if (!statuses) return true;
  if (!passes(trace, "shipment.status")) return false;
  const values = new Set(
    trace.filter((item) => item.verifier === "shipment.status").map((item) => item.value),
  );
  const [value] = values;
  return values.size === 1 && value !== undefined && statuses.includes(value);
}

function cleanAllow(
  mandate: Mandate,
  rule: Rule,
  intent: Intent,
  trace: TraceEntry[],
  usage: Usage,
) {
  if (rule.decide !== "allow") return false;
  if (!(rule.require ?? []).every((verifier) => passes(trace, verifier))) return false;
  if (rule.max && intent.amount.minor > rule.max.amount) return false;
  if (!usage.known) return false;
  const limit = mandate.limits.find((each) => each.currency === intent.amount.currency);
  const today = usage.perCurrency[intent.amount.currency];
  if (
    limit?.per_day_total !== undefined &&
    today.total.minor + intent.amount.minor > limit.per_day_total
  )
    return false;
  if (limit?.per_day_count !== undefined && today.count + 1 > limit.per_day_count) return false;
  return true;
}

describe("the fail-closed property", () => {
  it("never allows without a matched allow rule whose requirements all passed, unescalated", () => {
    const random = generator(20261017);
    const runs = 5000;
    let allowed = 0;
    for (let run = 0; run < runs; run++) {
      const mandate = randomMandate(random);
      const intent = randomIntent(random);
      const trace = randomTrace(random);
      const usage = randomUsage(random);
      const result = evaluate({ mandate, intent, trace, usage });
      if (result.outcome !== "allow") continue;
      allowed++;
      const context = { run, mandate, intent, trace, usage, result };
      expect(intent.principal, JSON.stringify(context)).toBe(mandate.principal);
      expect(ACTIONS as readonly string[]).toContain(intent.action);
      const matched = mandate.rules.filter((rule) => matches(rule, intent, trace));
      // At least one matched rule cleanly allows, and, since the most restrictive outcome wins,
      // so does every other matched rule.
      expect(matched.length, JSON.stringify(context)).toBeGreaterThan(0);
      for (const rule of matched) {
        expect(cleanAllow(mandate, rule, intent, trace, usage), JSON.stringify(context)).toBe(true);
      }
      expect(result.reasons).toEqual([]);
      expect(result.matchedRules).toEqual(matched.map((rule) => rule.id));
    }
    // The generator must reach allow often enough for the property to mean something.
    expect(allowed).toBeGreaterThan(runs / 50);
  });
});
