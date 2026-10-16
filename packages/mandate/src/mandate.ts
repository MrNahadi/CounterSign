// The mandate: a merchant's signed, versioned rules for one principal, and its hash.

import { z } from "zod";
import { type JsonValue, sha256Canonical } from "./canonical-json";
import { ACTIONS, CLAIMS, RAILS } from "./intent";
import { CURRENCIES } from "./money";
import { RULE_REASON_CODES, type RuleReasonCode } from "./reason-codes";

// Every verifier a rule may name (original brief §8). Ones not built yet return unknown.
export const VERIFIERS = [
  "capture.refundable",
  "ticket.from_payer",
  "dispute.none_open",
  "shipment.status",
  "evidence.photo_present",
  "payee.allowlisted",
  "ledger.not_duplicate",
  "ledger.velocity",
  "mpesa.receipt_verified",
  "mpesa.amount_matches_order",
  "mpesa.overpayment_covers_refund",
  "mpesa.recipient_is_payer",
  "mpesa.receipt_unused",
] as const;
export type VerifierName = (typeof VERIFIERS)[number];

export const SHIPMENT_STATUSES = ["lost", "stalled_10d", "in_transit", "delivered"] as const;
export type ShipmentStatus = (typeof SHIPMENT_STATUSES)[number];

const Minor = z.int().nonnegative();
const Currency = z.enum(CURRENCIES);
const Action = z.enum(ACTIONS);

const When = z.strictObject({
  claim: z.enum(CLAIMS).optional(),
  "shipment.status": z.array(z.enum(SHIPMENT_STATUSES)).nonempty().optional(),
  rail: z.enum(RAILS).optional(),
});

const RuleBase = {
  id: z.string().min(1),
  action: z.union([Action, z.array(Action).nonempty()]),
  when: When.optional(),
  require: z.array(z.enum(VERIFIERS)).optional(),
  max: z.strictObject({ amount: Minor, currency: Currency }).optional(),
};

// The rule reasons that come with a reply hint. A denial hands its first reason's hint to the
// agent, so a deny rule may only name one of these.
const DENY_RULE_REASON_CODES = [
  "SHIPMENT_DELIVERED",
  "RULE_DENIES",
] as const satisfies readonly RuleReasonCode[];

// A step-up or deny rule names why it held or refused an intent (ADR 0019).
const Rule = z.discriminatedUnion("decide", [
  z.strictObject({ ...RuleBase, decide: z.literal("allow") }),
  z.strictObject({ ...RuleBase, decide: z.literal("step_up"), reason: z.enum(RULE_REASON_CODES) }),
  z.strictObject({
    ...RuleBase,
    decide: z.literal("deny"),
    reason: z.enum(DENY_RULE_REASON_CODES),
  }),
]);

const Limit = z
  .strictObject({
    currency: Currency,
    per_day_total: Minor.optional(),
    per_day_count: Minor.optional(),
  })
  .refine((limit) => limit.per_day_total !== undefined || limit.per_day_count !== undefined, {
    message: "A limit needs per_day_total, per_day_count or both",
  });

function isTimeZone(name: string): boolean {
  try {
    new Intl.DateTimeFormat("en", { timeZone: name });
    return true;
  } catch {
    return false;
  }
}

export const MandateSchema = z
  .strictObject({
    id: z.string().min(1),
    version: z.int().positive(),
    principal: z.string().min(1),
    // Daily limits count calendar days in this IANA time zone (ADR 0019).
    time_zone: z.string().refine(isTimeZone, "Unknown IANA time zone").default("Africa/Nairobi"),
    fallback: z.literal("deny"),
    limits: z.array(Limit),
    rules: z.array(Rule),
  })
  .superRefine((mandate, ctx) => {
    const currencies = new Set<string>();
    mandate.limits.forEach((limit, index) => {
      if (currencies.has(limit.currency)) {
        ctx.addIssue({
          code: "custom",
          path: ["limits", index, "currency"],
          message: `A second limit for ${limit.currency}`,
        });
      }
      currencies.add(limit.currency);
    });
    const ruleIds = new Set<string>();
    mandate.rules.forEach((rule, index) => {
      if (ruleIds.has(rule.id)) {
        ctx.addIssue({
          code: "custom",
          path: ["rules", index, "id"],
          message: `A second rule with id ${rule.id}`,
        });
      }
      ruleIds.add(rule.id);
    });
  });

export type Mandate = z.infer<typeof MandateSchema>;
export type Rule = Mandate["rules"][number];

export type MandateIssue = { path: (string | number)[]; message: string };
export type MandateParse =
  | { ok: true; mandate: Mandate }
  | { ok: false; error: string; issues: MandateIssue[] };

function describePath(path: (string | number)[]): string {
  return path.map((key) => (typeof key === "number" ? `[${key}]` : `.${key}`)).join("") || ".";
}

// Validates a mandate file's contents. Never throws on bad input.
export function parseMandate(input: unknown): MandateParse {
  const result = MandateSchema.safeParse(input);
  if (result.success) return { ok: true, mandate: result.data };
  const issues = result.error.issues.flatMap((issue): MandateIssue[] => {
    const path = issue.path.map((key) => (typeof key === "number" ? key : String(key)));
    // An unknown key's own path names the bad field, not just the object holding it.
    if (issue.code === "unrecognized_keys") {
      return issue.keys.map((key) => ({ path: [...path, key], message: `Unknown key ${key}` }));
    }
    return [{ path, message: issue.message }];
  });
  const [first] = issues;
  const error = first ? `Mandate ${describePath(first.path)}: ${first.message}` : "Invalid mandate";
  return { ok: false, error, issues };
}

// SHA-256 of the mandate's canonical JSON (ADR 0019). The cast only drops the optional keys'
// `undefined` from the type: a parsed mandate omits absent keys, and canonicalJson still
// rejects anything that isn't integer-only JSON at run time.
export function hashMandate(mandate: Mandate): string {
  return sha256Canonical(mandate as unknown as JsonValue);
}
