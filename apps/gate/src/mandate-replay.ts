// The mandate replay (PLAN E2, brief §6 "the merchant changes their rules"): every decision the
// audit log holds under the mandate in force, run again with a draft version N+1 through the same
// rule step decide() uses (`ruleDecision`), to list the decisions the change would flip. Offline:
// it reads only the log, with each decision's own intent, verifier trace and day's usage, so it
// calls no PayPal, carrier or AI. A check the draft requires that the decision never ran isn't in
// its trace, so it reads as unknown and the replay denies, as the gate would with no record.

import { auditLog, type Database, desc, eq } from "@countersign/db";
import type { ChainRow } from "@countersign/ledger";
import {
  canonicalJson,
  type Decision,
  hashMandate,
  type JsonValue,
  type Mandate,
  type Money,
  parseMandate,
} from "@countersign/mandate";
import { type DecisionPayload, parseDecision } from "./audit-reader";
import { ruleDecision } from "./decide";

/** The most decisions one replay reads, newest first; an older remainder makes it partial. */
export const REPLAY_LIMIT = 5_000;

export const DRAFT_PROBLEMS = {
  invalid: "The draft isn't a valid mandate",
  unknownMandate: "The gate holds no mandate with that id.",
  principal: "The draft names a different principal from the mandate in force.",
  version: "The draft must be the next version of the mandate in force.",
  timeZone: "The draft changes the time zone, which a replay can't check.",
  payees: "The draft changes the payee list, which a replay can't check.",
} as const;

export type DraftCheck =
  | { ok: true; base: Mandate; draft: Mandate }
  | { ok: false; problem: string };

const canonical = (value: unknown) => canonicalJson((value ?? null) as JsonValue);

/**
 * The draft checked against the gate's mandate with its id: a valid mandate, same principal,
 * time zone and payees, and exactly the next version. Code fills those in when it compiles, so a
 * draft that differs was changed by hand; the time zone and payees also shaped the recorded
 * usage and payee checks, so a replay of a draft that changes them would mislead.
 */
export function checkDraft(input: unknown, mandates: readonly Mandate[]): DraftCheck {
  const parsed = parseMandate(input);
  if (!parsed.ok) return { ok: false, problem: `${DRAFT_PROBLEMS.invalid}: ${parsed.error}` };
  const draft = parsed.mandate;
  const base = mandates.find((mandate) => mandate.id === draft.id);
  if (base === undefined) return { ok: false, problem: DRAFT_PROBLEMS.unknownMandate };
  if (draft.principal !== base.principal) return { ok: false, problem: DRAFT_PROBLEMS.principal };
  if (draft.version !== base.version + 1) return { ok: false, problem: DRAFT_PROBLEMS.version };
  if (draft.time_zone !== base.time_zone) return { ok: false, problem: DRAFT_PROBLEMS.timeZone };
  if (canonical(draft.payees) !== canonical(base.payees)) {
    return { ok: false, problem: DRAFT_PROBLEMS.payees };
  }
  return { ok: true, base, draft };
}

export type Flip = {
  seq: number;
  intent_id: string;
  ticket_id: string | null;
  action: string;
  amount: Money;
  claim: string | null;
  before: Decision;
  after: Decision;
  /** The draft's reasons, codes and specifics; empty for an allow. */
  reasons: { code: string; detail: string }[];
  /** Looser lets more through without a person (toward allow); tighter, the other way. */
  direction: "looser" | "tighter";
};

export type Replay = {
  base: { id: string; version: number; hash: string };
  draft: { id: string; version: number; hash: string };
  /** Decisions under the base version that were run again. */
  replayed: number;
  /** Of those, the ones the draft decides the same way. */
  unchanged: number;
  flips: Flip[];
  /** Flips per before and after, e.g. `deny_to_allow`. */
  counts: Record<`${Decision}_to_${Decision}`, number>;
  skipped: {
    /** Decided under another mandate or version, so not this change's to judge. */
    other_mandate: number;
    /** Denied before it became an intent; no mandate rule decided it. */
    no_intent: number;
    /** Entries the reader can't read. */
    unreadable: number;
  };
  /** True when the log held more decisions than one replay reads. */
  partial: boolean;
};

const STRICTNESS: Record<Decision, number> = { allow: 0, step_up: 1, deny: 2 };

const emptyCounts = (): Replay["counts"] => ({
  allow_to_allow: 0,
  allow_to_step_up: 0,
  allow_to_deny: 0,
  step_up_to_allow: 0,
  step_up_to_step_up: 0,
  step_up_to_deny: 0,
  deny_to_allow: 0,
  deny_to_step_up: 0,
  deny_to_deny: 0,
});

export type LoggedDecision =
  | { seq: number; readable: true; payload: DecisionPayload }
  | { seq: number; readable: false };

/** Runs each logged decision again with the draft. Pure: the caller reads the log. */
export function replayDecisions(
  base: Mandate,
  draft: Mandate,
  decisions: readonly LoggedDecision[],
  partial = false,
): Replay {
  const baseHash = hashMandate(base).hash;
  const replay: Replay = {
    base: { id: base.id, version: base.version, hash: baseHash },
    draft: { id: draft.id, version: draft.version, hash: hashMandate(draft).hash },
    replayed: 0,
    unchanged: 0,
    flips: [],
    counts: emptyCounts(),
    skipped: { other_mandate: 0, no_intent: 0, unreadable: 0 },
    partial,
  };
  for (const logged of decisions) {
    if (!logged.readable) {
      replay.skipped.unreadable++;
      continue;
    }
    const { record } = logged.payload;
    const { mandate } = record;
    if (mandate.id !== base.id || mandate.version !== base.version || mandate.hash !== baseHash) {
      replay.skipped.other_mandate++;
      continue;
    }
    if (record.intent === null || record.intentId === null) {
      replay.skipped.no_intent++;
      continue;
    }
    const { intent, trace, usage } = record;
    const after = ruleDecision({ mandate: draft, intent, trace, usage });
    replay.replayed++;
    replay.counts[`${record.decision}_to_${after.decision}`]++;
    if (after.decision === record.decision) {
      replay.unchanged++;
      continue;
    }
    replay.flips.push({
      seq: logged.seq,
      intent_id: record.intentId,
      ticket_id: intent.ticketId,
      action: intent.action,
      amount: intent.amount,
      claim: intent.claim,
      before: record.decision,
      after: after.decision,
      reasons: after.reasons.map(({ code, detail }) => ({ code, detail })),
      direction: STRICTNESS[after.decision] < STRICTNESS[record.decision] ? "looser" : "tighter",
    });
  }
  // Looser flips first: they're the ones that would let money move without a person.
  replay.flips.sort((a, b) =>
    a.direction === b.direction ? b.seq - a.seq : a.direction === "looser" ? -1 : 1,
  );
  return replay;
}

/** Reads up to `limit` decision entries, newest first, each parsed or marked unreadable. */
export async function readLoggedDecisions(
  db: Database,
  limit = REPLAY_LIMIT,
): Promise<{ decisions: LoggedDecision[]; partial: boolean }> {
  const rows: ChainRow[] = await db
    .select()
    .from(auditLog)
    .where(eq(auditLog.entryType, "decision"))
    .orderBy(desc(auditLog.seq))
    .limit(limit + 1);
  const decisions = rows.slice(0, limit).map((row): LoggedDecision => {
    const parsed = parseDecision(row);
    return parsed.ok
      ? { seq: row.seq, readable: true, payload: parsed.value }
      : { seq: row.seq, readable: false };
  });
  return { decisions, partial: rows.length > limit };
}
