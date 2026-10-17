// decide(): one proposal through normalize, verify and evaluate (brief §6 steps 2 to 4), giving
// the decision record and the agent's response. Pure: `now` is passed in, and nothing executes.

import {
  evaluate,
  hashIntent,
  hashMandate,
  type Intent,
  type Mandate,
  type Outcome,
  REASONS,
  type Reason,
  type Usage,
  type VerifierTrace,
} from "@countersign/mandate";
import { type RecordSnapshots, runVerifiers, todaysUsage } from "@countersign/verifiers";
import { z } from "zod";
import { ReasonCodeSchema } from "./case-file";
import { normalizeProposal } from "./proposal";

// How long a step-up waits for the merchant before it expires as a deny.
export const APPROVAL_WINDOW_MS = 15 * 60 * 1000;

const ReasonSchema = z.strictObject({ code: ReasonCodeSchema, detail: z.string().min(1) });
const IntentId = z.string().regex(/^int_[0-9a-f]{24}$/);

// What the agent gets back (original brief §6).
export const AgentResponseSchema = z.discriminatedUnion("decision", [
  z.strictObject({
    decision: z.literal("allowed"),
    intent_id: IntentId,
    intent_hash: z.string().regex(/^[0-9a-f]{64}$/),
  }),
  z.strictObject({
    decision: z.literal("pending_approval"),
    intent_id: IntentId,
    reasons: z.array(ReasonSchema).min(1),
    expires_at: z.iso.datetime(),
  }),
  z.strictObject({
    decision: z.literal("denied"),
    // Null when the proposal never became an intent.
    intent_id: IntentId.nullable(),
    reasons: z.array(ReasonSchema).min(1),
    safe_reply_hint: z.string().min(1),
  }),
]);

export type AgentResponse = z.infer<typeof AgentResponseSchema>;

// Everything phases 4 and 10 need to record and show the decision.
export type DecisionRecord = {
  // Null when the proposal never became an intent.
  intent: Intent | null;
  intentId: string | null;
  intentHash: string | null;
  // The exact canonical JSON the intent hash covers (ADR 0020).
  intentCanonical: string | null;
  mandate: { id: string; version: number; hash: string };
  trace: VerifierTrace;
  usage: Usage;
  matchedRules: string[];
  decision: Outcome;
  reasons: Reason[];
  decidedAt: string;
};

export type DecideInput = {
  mandate: Mandate;
  // Who is proposing, from the agent's credentials, never from the proposal itself.
  principal: string;
  proposal: unknown;
  records: RecordSnapshots;
  now: Date;
};

export type Decided = { record: DecisionRecord; response: AgentResponse };

// The first reason's hint. A denial whose first reason has none still gets a safe hint.
function safeReplyHint(reasons: readonly Reason[]): string {
  const hints = reasons.map((reason) => REASONS[reason.code].hint);
  return hints.find((hint) => hint !== null) ?? REASONS.NO_MATCHING_RULE.hint;
}

function denied(intentId: string | null, reasons: Reason[]): AgentResponse {
  return {
    decision: "denied",
    intent_id: intentId,
    reasons,
    safe_reply_hint: safeReplyHint(reasons),
  };
}

// The verifiers this mandate's rules for the action require, beyond the action's own set.
function requiredBy(mandate: Mandate, intent: Intent) {
  return mandate.rules
    .filter((rule) =>
      (typeof rule.action === "string" ? [rule.action] : rule.action).includes(intent.action),
    )
    .flatMap((rule) => rule.require ?? []);
}

export function decide(input: DecideInput): Decided {
  const { mandate, principal, records, now } = input;
  const decidedAt = now.toISOString();
  const usage = todaysUsage(records, { principal, timeZone: mandate.time_zone, now });
  const base = {
    mandate: { id: mandate.id, version: mandate.version, hash: hashMandate(mandate).hash },
    usage,
    decidedAt,
  };

  const normalized = normalizeProposal({
    proposal: input.proposal,
    principal,
    mandateVersion: mandate.version,
    records,
  });
  if (!normalized.ok) {
    const reasons = [normalized.reason];
    return {
      record: {
        ...base,
        intent: null,
        intentId: null,
        intentHash: null,
        intentCanonical: null,
        trace: [],
        matchedRules: [],
        decision: "deny",
        reasons,
      },
      response: denied(null, reasons),
    };
  }

  const { intent } = normalized;
  const { hash, id, canonical } = hashIntent(intent);
  const trace = runVerifiers(intent, records, requiredBy(mandate, intent));
  const { outcome, reasons, matchedRules } = evaluate({ mandate, intent, trace, usage });
  const record: DecisionRecord = {
    ...base,
    intent,
    intentId: id,
    intentHash: hash,
    intentCanonical: canonical,
    trace,
    matchedRules,
    decision: outcome,
    reasons,
  };
  if (outcome === "allow") {
    return { record, response: { decision: "allowed", intent_id: id, intent_hash: hash } };
  }
  if (outcome === "step_up") {
    const expiresAt = new Date(now.getTime() + APPROVAL_WINDOW_MS).toISOString();
    return {
      record,
      response: { decision: "pending_approval", intent_id: id, reasons, expires_at: expiresAt },
    };
  }
  return { record, response: denied(id, reasons) };
}
