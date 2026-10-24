// propose(): one guarded PayPal proposal decided on live records, the stored ticket and the
// execution history, and, when allowed, executed once (brief §6 steps 1 to 6, ADRs 0026, 0029 and
// 0033). Live reads happen first, outside any transaction: the records the action targets, and
// the ticket its justification names, from the ticket store. Then one audit-log transaction,
// under the ledger's lock, reads the history, answers a refund's replay or decides, and writes the
// decision entry and, for an allowed intent, the `execution.requested` entry, so a second intent
// on the same capture always sees the first one's request. The intent runs through its action's
// executor after that commits, and its result is appended in its own transaction. An allowed
// invoice or dispute intent that was already requested is never sent again. An allow for an action without
// an executor is denied ACTION_UNAVAILABLE by decide(). No AI, and the lock is never held across
// a network call.

import type { CarrierAdapter } from "@countersign/carrier-mock";
import type { Database } from "@countersign/db";
import { type AuditLogWriter, type ChainRow, withAuditLog } from "@countersign/ledger";
import { hashIntent, type Mandate, REASONS } from "@countersign/mandate";
import type { PayPalClient } from "@countersign/rail-paypal";
import { type AgentResponse, type DecisionRecord, decide } from "./decide";
import { isExecutable } from "./executable";
import {
  executionRequestedEntry,
  type IntentRecord,
  readExecutionHistory,
  readIntentRecord,
  requestTarget,
} from "./execution-log";
import { type Execution, type ExecutionJob, execute } from "./executors";
import { type GateRecords, type ReadProblem, readProposalRecords } from "./live-records";
import { normalizeProposal } from "./proposal";
import { appendDecision, type RecordProblem, recordingFailure } from "./record";

// How long after the first request a replay may re-send the same request ID: the shortest
// replay window we rely on (ADR 0026).
export const REPLAY_WINDOW_MS = 6 * 60 * 60 * 1000;

export type ProposeInput = {
  mandate: Mandate;
  // Who is proposing, from the agent's credentials, never from the proposal itself.
  principal: string;
  // The proposal exactly as the agent sent it. Its ticket is read from the ticket store.
  proposal: unknown;
  // The decision time, and the time the replay window is measured at.
  now: Date;
  // Built by the gate from its environment, never from the proposal.
  rail: PayPalClient;
  carrier: CarrierAdapter;
  db: Database;
  // The time an execution result is logged at, after the rail call. Defaults to the system clock;
  // it never reaches the decision.
  clock?: () => Date;
};

export type ProposeSeqs = {
  mandate: number;
  decision: number;
  // The `execution.requested` entry, on allow only.
  request: number | null;
};

export type { Execution, RailRefusal } from "./executors";

export type ProposeResult =
  | {
      ok: true;
      replay: false;
      response: AgentResponse;
      record: DecisionRecord;
      problems: ReadProblem[];
      seqs: ProposeSeqs;
      // Null unless the decision was allow.
      execution: Execution | null;
    }
  | {
      // The intent was already requested, so it wasn't decided again.
      ok: true;
      replay: true;
      response: AgentResponse;
      intentId: string;
      intentHash: string;
      firstRequestSeq: number;
      problems: ReadProblem[];
      // The replay's `execution.requested` entry.
      seqs: { request: number };
      execution: Execution;
    }
  // Recording failed, so nothing was written and nothing executes.
  | { ok: false; problem: RecordProblem; detail: string; problems: ReadProblem[] };

type Planned =
  | {
      replay: false;
      response: AgentResponse;
      record: DecisionRecord;
      seqs: ProposeSeqs;
      // The intent to carry out once the transaction commits.
      send: ExecutionJob | null;
      // An allowed intent that wasn't sent, because it was already requested once or its trail
      // couldn't be read: what the log says instead.
      unsent: Execution | null;
    }
  | {
      replay: true;
      response: AgentResponse;
      intentId: string;
      intentHash: string;
      firstRequestSeq: number;
      requestSeq: number;
      send: ExecutionJob | null;
      // For a replay of an executed intent, the result already in the log.
      executed: IntentRecord["executed"];
    };

type Context = Pick<ProposeInput, "mandate" | "principal" | "proposal" | "now"> & {
  records: GateRecords;
};

// Decides the proposal and records it. `override` turns the decision into a denial for a
// reason outside the mandate's rules, keeping the intent and the verifier trace.
async function decideAndRecord(
  log: AuditLogWriter,
  ctx: Context,
  override?: { code: "DUPLICATE_REFUND"; detail: string },
): Promise<Planned> {
  const { mandate, principal, proposal, records, now } = ctx;
  const decided = decide({ mandate, principal, proposal, records, now });
  const result =
    override === undefined
      ? decided
      : {
          record: {
            ...decided.record,
            matchedRules: [],
            decision: "deny" as const,
            reasons: [override],
          },
          response: {
            decision: "denied" as const,
            intent_id: decided.record.intentId,
            reasons: [override],
            safe_reply_hint: REASONS[override.code].hint,
          },
        };
  const recorded = await appendDecision(log, { proposal, principal, mandate, decided: result });
  const { record } = result;
  let request: ChainRow | null = null;
  let send: ExecutionJob | null = null;
  let unsent: Execution | null = null;
  if (record.decision === "allow") {
    const { intent, intentId, intentHash } = record;
    if (intent === null || intentId === null || intentHash === null) {
      throw new Error("an allowed decision has no intent");
    }
    // decide() denies an allow for an action without an executor ACTION_UNAVAILABLE.
    const { action } = intent;
    if (!isExecutable(action)) throw new Error(`an allowed decision for ${action} can't execute`);
    const target = requestTarget(intent.target);
    if (action === "paypal.refund" && !("captureId" in target)) {
      throw new Error("an allowed refund targets no capture");
    }
    if (action === "paypal.invoice.send" && !("invoiceId" in target)) {
      throw new Error("an allowed invoice send targets no invoice");
    }
    if (action.startsWith("paypal.dispute.") && !("disputeId" in target)) {
      throw new Error(`an allowed ${action} targets no dispute`);
    }
    if (action === "paypal.payout" && !("email" in target)) {
      throw new Error("an allowed payout targets no payee");
    }
    // A refund intent already requested is answered as a replay before it's decided. Any other
    // is decided again but sent at most once (ADR 0033), so its trail is read first, under the
    // same lock.
    const earlier =
      action === "paypal.refund" ? null : await alreadyRequested(log, intentId, action);
    if (earlier !== null) {
      unsent = earlier;
    } else {
      request = await log.append(
        executionRequestedEntry({
          at: record.decidedAt,
          intentId,
          intentHash,
          principal: intent.principal,
          rail: intent.rail,
          action,
          target,
          amount: intent.amount,
          decisionSeq: recorded.decision.seq,
        }),
      );
      send = {
        requestSeq: request.seq,
        intentId,
        intentHash,
        action,
        target,
        amount: intent.amount,
        ...(intent.params === undefined ? {} : { params: intent.params }),
      };
    }
  }
  return {
    replay: false,
    response: result.response,
    record,
    seqs: {
      mandate: recorded.mandateSeq,
      decision: recorded.decision.seq,
      request: request?.seq ?? null,
    },
    send,
    unsent,
  };
}

// For an intent that isn't replayed, such as an invoice send: what the log says when it was
// already requested, or null when it never was. An unreadable trail counts as requested, so
// nothing is sent (brief §10 trade-off 1).
async function alreadyRequested(
  log: AuditLogWriter,
  intentId: string,
  action: string,
): Promise<Execution | null> {
  const read = await readIntentRecord(log.tx, intentId);
  const unsent = { refund: null, error: null, resultProblem: null, sent: false };
  if (!read.known) {
    return {
      ...unsent,
      outcome: "unknown",
      resultSeq: null,
      resultProblem: `Intent ${intentId}'s earlier entries can't be read (entry #${read.seq}), so the ${action} wasn't sent.`,
    };
  }
  const { trail } = read;
  if (trail === null) return null;
  return {
    ...unsent,
    outcome: trail.executed !== null ? "executed" : (trail.lastOutcome ?? "unknown"),
    refund: trail.executed?.refund ?? null,
    ...(trail.executed?.invoice === undefined ? {} : { invoice: trail.executed.invoice }),
    ...(trail.executed?.dispute === undefined ? {} : { dispute: trail.executed.dispute }),
    ...(trail.executed?.payout === undefined ? {} : { payout: trail.executed.payout }),
    resultSeq: trail.executed?.seq ?? null,
  };
}

// A proposal whose intent was already requested isn't decided again (ADR 0026). An executed
// intent gets the same answer and no rail call; any other is re-sent with the same request ID,
// within the replay window only.
async function answerReplay(
  log: AuditLogWriter,
  ctx: Context,
  trail: IntentRecord,
  intentHash: string,
): Promise<Planned> {
  const { firstRequest } = trail;
  const first = firstRequest.payload;
  const age = ctx.now.getTime() - Date.parse(firstRequest.at);
  if (trail.executed === null && !(age <= REPLAY_WINDOW_MS)) {
    return decideAndRecord(log, ctx, {
      code: "DUPLICATE_REFUND",
      detail:
        `Intent ${first.intentId} was first requested at ${firstRequest.at} (entry #${firstRequest.seq}), ` +
        "over 6 hours ago, and has no executed result, so it isn't sent again. " +
        "Check the refund with npm run reconcile.",
    });
  }
  // A refused intent stops counting against its capture, so another intent may have executed on
  // it since. Re-sending then could pay twice, so it's denied like any second intent on the
  // capture (brief §10 trade-off 1).
  if (trail.executed === null && trail.lastOutcome === "failed") {
    const executions = ctx.records.executions;
    const other = executions?.find(
      (execution) => execution.captureId === first.captureId && execution.id !== first.intentId,
    );
    if (executions === undefined || other !== undefined) {
      return decideAndRecord(log, ctx, {
        code: "DUPLICATE_REFUND",
        detail:
          `Intent ${first.intentId} was refused (entry #${firstRequest.seq}), and ` +
          `${other === undefined ? "the execution history can't be read" : `intent ${other.id} has since executed on capture ${first.captureId}`}, ` +
          "so it isn't sent again. Check the refund with npm run reconcile.",
      });
    }
  }
  // Requests written before phase 9 carry no target; they were all refunds on their capture.
  const target = first.target ?? (first.captureId === null ? null : { captureId: first.captureId });
  if (target === null) throw new Error("a requested intent has no target");
  const request = await log.append(
    executionRequestedEntry({
      at: ctx.now.toISOString(),
      intentId: first.intentId,
      intentHash: first.intentHash,
      principal: first.principal,
      rail: first.rail,
      action: first.action,
      target,
      amount: first.amount,
      replayOf: { firstRequestSeq: firstRequest.seq, proposal: ctx.proposal },
    }),
  );
  // Replays are refunds only, so the job is a refund on the first request's capture.
  const send: ExecutionJob | null =
    trail.executed !== null || first.captureId === null
      ? null
      : {
          requestSeq: request.seq,
          intentId: first.intentId,
          intentHash,
          action: "paypal.refund",
          target: { captureId: first.captureId },
          amount: first.amount,
        };
  if (trail.executed === null && send === null) {
    throw new Error("a requested refund has no capture");
  }
  return {
    replay: true,
    response: { decision: "allowed", intent_id: first.intentId, intent_hash: intentHash },
    intentId: first.intentId,
    intentHash,
    firstRequestSeq: firstRequest.seq,
    requestSeq: request.seq,
    send,
    executed: trail.executed,
  };
}

export async function propose(input: ProposeInput): Promise<ProposeResult> {
  const { mandate, principal, proposal, now, rail, carrier, db } = input;
  const clock = input.clock ?? (() => new Date());

  // 1. Live records and the ticket, outside the transaction.
  const live = await readProposalRecords({ proposal, rail, carrier, db });
  const { problems } = live;

  // 2. One transaction under the ledger's lock: history, then a refund replay's answer or a
  // decision and, for an allowed intent never requested before, the request.
  let planned: Planned;
  try {
    planned = await withAuditLog(db, async (log): Promise<Planned> => {
      const history = await readExecutionHistory(log.tx);
      // An unreadable history leaves `executions` out, so it's unknown, never empty, and the
      // proposal is decided, which can't allow.
      const records: GateRecords = history.known
        ? { ...live.records, executions: history.executions }
        : live.records;
      const ctx: Context = { mandate, principal, proposal, records, now };
      if (history.known) {
        const normalized = normalizeProposal({
          proposal,
          principal,
          mandateVersion: mandate.version,
          records,
        });
        // Replays apply to refunds only (ADR 0026); any other action is decided again.
        if (normalized.ok && normalized.intent.action === "paypal.refund") {
          const { id, hash } = hashIntent(normalized.intent);
          const read = await readIntentRecord(log.tx, id);
          if (read.known && read.trail !== null) return answerReplay(log, ctx, read.trail, hash);
        }
      }
      return decideAndRecord(log, ctx);
    });
  } catch (error) {
    const failure = recordingFailure(error);
    if (failure) return { ok: false, ...failure, problems };
    throw error;
  }

  // 3. After the commit: carry out the intent through its executor and log the result.
  const execution = planned.send === null ? null : await execute(rail, db, planned.send, clock);

  if (!planned.replay) {
    const { response, record, seqs, unsent } = planned;
    return {
      ok: true,
      replay: false,
      response,
      record,
      problems,
      seqs,
      execution: execution ?? unsent,
    };
  }
  const { response, intentId, intentHash, firstRequestSeq, requestSeq, executed } = planned;
  const replayed: Execution = execution ?? {
    outcome: "executed",
    refund: executed?.refund ?? null,
    error: null,
    resultSeq: executed?.seq ?? null,
    resultProblem: null,
    sent: false,
  };
  return {
    ok: true,
    replay: true,
    response,
    intentId,
    intentHash,
    firstRequestSeq,
    problems,
    seqs: { request: requestSeq },
    execution: replayed,
  };
}
