// The rule evaluator: brief §6's deterministic steps from a mandate, an intent and its verifier
// trace to allow, step-up or deny. Never imports an AI SDK.

import { ACTIONS, type Intent } from "./intent";
import {
  type Mandate,
  type Rule,
  ruleActions,
  type ShipmentStatus,
  type VerifierName,
} from "./mandate";
import { formatMoney, isMinorUnits } from "./money";
import type { ReasonCode } from "./reason-codes";
import type { TraceEntry, VerifierResult, VerifierTrace } from "./trace";
import type { Usage } from "./usage";

export const DECISIONS = ["allow", "step_up", "deny"] as const;
export type Decision = (typeof DECISIONS)[number];

// One reason for a decision: its code, and the specifics in words.
export type Reason = { code: ReasonCode; detail: string };

export type Evaluation = {
  decision: Decision;
  reasons: Reason[];
  // The IDs of the rules whose action and `when` matched the intent, in mandate order.
  matchedRules: string[];
};

// `usage` is today's usage for the intent's principal (step 3's daily limits).
export type EvaluateInput = {
  mandate: Mandate;
  intent: Intent;
  trace: VerifierTrace;
  usage: Usage;
};

// A verifier's entries in the trace. A trace that names one verifier twice with different results
// is never read as `pass`.
function entriesFor(trace: VerifierTrace, verifier: VerifierName): TraceEntry[] {
  return trace.filter((item) => item.verifier === verifier);
}

function resultOf(entries: TraceEntry[]): VerifierResult {
  if (entries.length > 0 && entries.every((item) => item.result === "pass")) return "pass";
  return entries.some((item) => item.result === "fail") ? "fail" : "unknown";
}

// The shipment status a passing `shipment.status` found. Anything else is unknown, and an
// unknown status never matches a `when`.
function shipmentStatusOf(trace: VerifierTrace): ShipmentStatus | null {
  const entries = entriesFor(trace, "shipment.status");
  if (resultOf(entries) !== "pass") return null;
  const values = new Set(entries.map((item) => item.value));
  const [value] = values;
  return values.size === 1 && value ? value : null;
}

// `status_unknown` means the rule would match but for an unknown shipment status.
type Match = "match" | "no_match" | "status_unknown";

function match(rule: Rule, intent: Intent, status: ShipmentStatus | null): Match {
  if (!ruleActions(rule).includes(intent.action)) return "no_match";
  if (rule.max && rule.max.currency !== intent.amount.currency) return "no_match";
  const when = rule.when ?? {};
  if (when.claim !== undefined && when.claim !== intent.claim) return "no_match";
  if (when.rail !== undefined && when.rail !== intent.rail) return "no_match";
  const statuses = when["shipment.status"];
  if (!statuses) return "match";
  if (status === null) return "status_unknown";
  return statuses.includes(status) ? "match" : "no_match";
}

function notInTrace(verifier: VerifierName): string {
  return `${verifier} isn't in the verifier trace`;
}

// The fallback is always deny. An unknown status that kept a rule out is named after it.
function fallback(input: EvaluateInput, statusKeptOut: boolean): Reason[] {
  const { mandate, intent, trace } = input;
  const facts = [intent.claim ? `claim ${intent.claim}` : "no claim"];
  const shipment = trace.find((item) => item.verifier === "shipment.status");
  if (shipment) facts.push(`shipment ${shipmentStatusOf(trace) ?? "unknown"}`);
  const reasons: Reason[] = [
    {
      code: "NO_MATCHING_RULE",
      detail: `No rule in ${mandate.id} v${mandate.version} matches this ${intent.action} (${facts.join(", ")})`,
    },
  ];
  if (statusKeptOut) {
    const detail = shipment?.detail ?? notInTrace("shipment.status");
    reasons.push({ code: "SHIPMENT_STATUS_UNKNOWN", detail });
  }
  return reasons;
}

// The codes a built verifier raises when a rule requires it and it doesn't pass. Any other
// verifier isn't built yet, so it can only be unknown (VERIFIER_UNAVAILABLE). A result with no
// code of its own is VERIFIER_UNAVAILABLE too (ADR 0040), still a deny.
const REQUIREMENT_CODES: Partial<
  Record<VerifierName, { fail?: ReasonCode; unknown?: ReasonCode }>
> = {
  "capture.refundable": { fail: "CAPTURE_NOT_REFUNDABLE", unknown: "CAPTURE_UNKNOWN" },
  "ticket.from_payer": { fail: "TICKET_NOT_FROM_PAYER", unknown: "PAYER_UNKNOWN" },
  "dispute.none_open": { fail: "DISPUTE_OPEN", unknown: "DISPUTES_UNKNOWN" },
  // shipment.status never fails: a status it can't find is unknown.
  "shipment.status": { fail: "SHIPMENT_STATUS_UNKNOWN", unknown: "SHIPMENT_STATUS_UNKNOWN" },
  "evidence.photo_present": { fail: "NO_PHOTO_EVIDENCE", unknown: "TICKET_UNKNOWN" },
  "ledger.not_duplicate": { fail: "DUPLICATE_REFUND", unknown: "HISTORY_UNKNOWN" },
  "payee.allowlisted": { unknown: "PAYEE_LIST_UNKNOWN" },
};

// One reason per requirement that isn't `pass`. A verifier missing from the trace is unknown.
function unmetRequirements(rule: Rule, trace: VerifierTrace): Reason[] {
  return [...new Set(rule.require ?? [])].flatMap((verifier): Reason[] => {
    const entries = entriesFor(trace, verifier);
    const result = resultOf(entries);
    if (result === "pass") return [];
    const found = entries.find((item) => item.result === result) ?? entries[0];
    const code = REQUIREMENT_CODES[verifier]?.[result] ?? "VERIFIER_UNAVAILABLE";
    return [{ code, detail: found?.detail ?? notInTrace(verifier) }];
  });
}

// Step 3's daily limits: an intent that would take today's total or count for its currency past
// the mandate's limit. Unknown usage always escalates, whatever the limits say, and so does a
// total past the safe-integer range, which can't be counted. A currency with no limit escalates
// too (ADR 0020).
function dailyLimitReasons({ mandate, intent, usage }: EvaluateInput): Reason[] {
  if (!usage.known) return [{ code: "DAILY_LIMIT_UNKNOWN", detail: usage.detail }];
  const { currency } = intent.amount;
  const today = usage.perCurrency[currency];
  const total = today.total.minor + intent.amount.minor;
  const count = today.count + 1;
  if (!isMinorUnits(total) || !Number.isSafeInteger(count)) {
    return [
      {
        code: "DAILY_LIMIT_UNKNOWN",
        detail: `Today's ${currency} total would be too large to count`,
      },
    ];
  }
  const limit = mandate.limits.find((each) => each.currency === currency);
  if (!limit) {
    return [{ code: "NO_DAILY_LIMIT", detail: `Your mandate sets no ${currency} daily limit` }];
  }
  const reasons: Reason[] = [];
  if (limit.per_day_total !== undefined && total > limit.per_day_total) {
    const after = formatMoney({ minor: total, currency });
    const cap = formatMoney({ minor: limit.per_day_total, currency });
    reasons.push({
      code: "DAILY_LIMIT_REACHED",
      detail: `Today's ${currency} total would be ${after}, over the ${cap} daily limit`,
    });
  }
  if (limit.per_day_count !== undefined && count > limit.per_day_count) {
    reasons.push({
      code: "DAILY_LIMIT_REACHED",
      detail: `Today's ${currency} count would be ${count}, over the daily limit of ${limit.per_day_count}`,
    });
  }
  return reasons;
}

// Step 3: what turns an allow into a step-up. The amount above the rule's cap, then the daily
// limits.
function escalations(rule: Rule, input: EvaluateInput): Reason[] {
  const { amount } = input.intent;
  const reasons: Reason[] = [];
  if (rule.max && amount.minor > rule.max.amount) {
    const cap = formatMoney({ minor: rule.max.amount, currency: rule.max.currency });
    reasons.push({
      code: "ABOVE_AUTO_LIMIT",
      detail: `${formatMoney(amount)} is over the ${cap} cap in rule ${rule.id}`,
    });
  }
  return [...reasons, ...dailyLimitReasons(input)];
}

// The facts a matched rule's `when` tested, as the intent and trace showed them.
function matchedFacts(rule: Rule, { intent, trace }: EvaluateInput): string[] {
  const when = rule.when ?? {};
  const facts: string[] = [];
  if (when.claim !== undefined) facts.push(`claim ${intent.claim}`);
  if (when["shipment.status"]) facts.push(`shipment ${shipmentStatusOf(trace) ?? "unknown"}`);
  if (when.rail !== undefined) facts.push(`rail ${intent.rail}`);
  return facts;
}

// A step-up or deny rule's own reason: the facts behind it, then the rule, with a verb that
// matches what the rule decided. SHIPMENT_DELIVERED gives the carrier's delivered reading from the
// shipment.status entry, which names the tracking number. Without one, it says what the carrier
// did report, so the detail never claims a delivery the records don't show.
function ruleReason(
  rule: Extract<Rule, { decide: "step_up" | "deny" }>,
  input: EvaluateInput,
): Reason {
  const holds = rule.decide === "step_up";
  if (rule.reason === "SHIPMENT_DELIVERED") {
    const shipment = entriesFor(input.trace, "shipment.status")[0];
    const reading = !shipment
      ? notInTrace("shipment.status")
      : shipment.result === "pass" && shipment.value === "delivered"
        ? shipment.detail
        : `The carrier reading is ${shipment.value ?? "unknown"}, not delivered`;
    const verb = holds ? "asks you first" : "denies this";
    return { code: rule.reason, detail: `${reading}; rule ${rule.id} ${verb}` };
  }
  const { action } = input.intent;
  const facts = matchedFacts(rule, input);
  const what = facts.length > 0 ? `${action} with ${facts.join(", ")}` : `every ${action}`;
  const verb = holds ? "asks you first for" : "denies";
  return { code: rule.reason, detail: `Rule ${rule.id} ${verb} ${what}` };
}

type RuleDecision = { decision: Decision; reasons: Reason[] };

function ruleDecision(rule: Rule, input: EvaluateInput): RuleDecision {
  const unmet = unmetRequirements(rule, input.trace);
  if (unmet.length > 0) return { decision: "deny", reasons: unmet };
  if (rule.decide === "allow") {
    const escalated = escalations(rule, input);
    if (escalated.length > 0) return { decision: "step_up", reasons: escalated };
    return { decision: "allow", reasons: [] };
  }
  return { decision: rule.decide, reasons: [ruleReason(rule, input)] };
}

const RESTRICTIVENESS: Record<Decision, number> = { allow: 0, step_up: 1, deny: 2 };

// Step 6: an action outside the known list, or a principal this mandate doesn't cover, is denied
// before any rule is read. The action is checked at run time, since callers may be unchecked.
function outOfScope({ mandate, intent }: EvaluateInput): Reason[] {
  const reasons: Reason[] = [];
  if (!(ACTIONS as readonly string[]).includes(intent.action)) {
    reasons.push({ code: "UNKNOWN_ACTION", detail: `Unknown action ${intent.action}` });
  }
  if (intent.principal !== mandate.principal) {
    reasons.push({
      code: "WRONG_MANDATE",
      detail: `Principal ${intent.principal}, mandate ${mandate.id} covers ${mandate.principal}`,
    });
  }
  return reasons;
}

export function evaluate(input: EvaluateInput): Evaluation {
  const { mandate, intent, trace } = input;
  const refused = outOfScope(input);
  if (refused.length > 0) return { decision: "deny", reasons: refused, matchedRules: [] };
  const status = shipmentStatusOf(trace);
  const matches = mandate.rules.map((rule) => match(rule, intent, status));
  const matched = mandate.rules.filter((_rule, index) => matches[index] === "match");
  const matchedRules = matched.map((rule) => rule.id);
  if (matched.length === 0) {
    const statusKeptOut = matches.includes("status_unknown");
    return { decision: "deny", reasons: fallback(input, statusKeptOut), matchedRules };
  }
  const ruleDecisions = matched.map((rule) => ruleDecision(rule, input));
  const decision = ruleDecisions.reduce<Decision>(
    (worst, each) =>
      RESTRICTIVENESS[each.decision] > RESTRICTIVENESS[worst] ? each.decision : worst,
    "allow",
  );
  const reasons = ruleDecisions
    .filter((each) => each.decision === decision)
    .flatMap((each) => each.reasons);
  return { decision, reasons, matchedRules };
}
