// proposeRefund(): one refund proposal decided on live records and the execution history, then
// executed once (brief §6 steps 1 to 6, ADR 0026). Live reads happen first, outside any
// transaction. Then one audit-log transaction, under the ledger's lock, reads the history,
// answers a replay or decides, and writes the decision entry and, on allow, the
// `execution.requested` entry, so a second intent on the same capture always sees the first
// one's request. The refund is sent after that commits, and its result is appended in its own
// transaction. No AI, and the lock is never held across a network call.

import type { CarrierAdapter } from "@countersign/carrier-mock";
import type { Database } from "@countersign/db";
import { type AuditLogWriter, appendEntry, type ChainRow, withAuditLog } from "@countersign/ledger";
import { hashIntent, IdSchema, type Mandate, type Money, REASONS } from "@countersign/mandate";
import { type PayPalClient, PayPalError, type PayPalRefund } from "@countersign/rail-paypal";
import type { RecordSnapshots, TicketSnapshot } from "@countersign/verifiers";
import { z } from "zod";
import { type AgentResponse, type DecisionRecord, decide } from "./decide";
import {
  type ExecutionOutcome,
  executionRequestedEntry,
  executionResultEntry,
  type IntentRecord,
  readExecutionHistory,
  readIntentRecord,
} from "./execution-log";
import { type ReadProblem, readLiveRecords } from "./live-records";
import { normalizeProposal } from "./proposal";
import { appendDecision, type RecordProblem, recordingFailure } from "./record";

// How long after the first request a replay may re-send the same request ID: the shortest
// replay window we rely on (ADR 0026).
export const REPLAY_WINDOW_MS = 6 * 60 * 60 * 1000;

export type ProposeInput = {
  mandate: Mandate;
  // Who is proposing, from the agent's credentials, never from the proposal itself.
  principal: string;
  // The proposal exactly as the agent sent it.
  proposal: unknown;
  // Simulated in phase 6, from Resolve in phase 8.
  ticket?: TicketSnapshot;
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

export type RailRefusal = { name: string | null; issues: string[]; debugId: string | null };

// What happened when the refund was sent, or, for a replay of an executed intent, what the log
// already says happened.
export type Execution = {
  outcome: ExecutionOutcome;
  refund: { id: string; status: string } | null;
  error: RailRefusal | null;
  // The `execution.result` entry; null when no rail call was made or the result couldn't be
  // written (then `resultProblem` says why).
  resultSeq: number | null;
  resultProblem: string | null;
  // False for a replay of an executed intent: no rail call, no new refund.
  sent: boolean;
};

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

// Only the capture ID is read before normalizing, to know which records to fetch. A proposal
// without a readable one reads nothing, and normalizing denies it.
const NamedCapture = z.object({ args: z.object({ capture_id: IdSchema }) });

function captureOf(proposal: unknown): string | null {
  const parsed = NamedCapture.safeParse(proposal);
  return parsed.success ? parsed.data.args.capture_id : null;
}

// A refund to send once the transaction commits.
type Send = {
  requestSeq: number;
  intentId: string;
  intentHash: string;
  captureId: string;
  amount: Money;
};

type Planned =
  | {
      replay: false;
      response: AgentResponse;
      record: DecisionRecord;
      seqs: ProposeSeqs;
      send: Send | null;
    }
  | {
      replay: true;
      response: AgentResponse;
      intentId: string;
      intentHash: string;
      firstRequestSeq: number;
      requestSeq: number;
      send: Send | null;
      // For a replay of an executed intent, the result already in the log.
      executed: IntentRecord["executed"];
    };

type Context = Pick<ProposeInput, "mandate" | "principal" | "proposal" | "now"> & {
  records: RecordSnapshots;
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
  let send: Send | null = null;
  if (record.decision === "allow") {
    const { intent, intentId, intentHash } = record;
    if (intent === null || intentId === null || intentHash === null) {
      throw new Error("an allowed decision has no intent");
    }
    const captureId = intent.target.captureId;
    request = await log.append(
      executionRequestedEntry({
        at: record.decidedAt,
        intentId,
        intentHash,
        principal: intent.principal,
        rail: intent.rail,
        action: intent.action,
        captureId,
        amount: intent.amount,
        decisionSeq: recorded.decision.seq,
      }),
    );
    send = { requestSeq: request.seq, intentId, intentHash, captureId, amount: intent.amount };
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
  const request = await log.append(
    executionRequestedEntry({
      at: ctx.now.toISOString(),
      intentId: first.intentId,
      intentHash: first.intentHash,
      principal: first.principal,
      rail: first.rail,
      action: first.action,
      captureId: first.captureId,
      amount: first.amount,
      replayOf: { firstRequestSeq: firstRequest.seq, proposal: ctx.proposal },
    }),
  );
  const send: Send | null =
    trail.executed !== null || first.captureId === null
      ? null
      : {
          requestSeq: request.seq,
          intentId: first.intentId,
          intentHash,
          captureId: first.captureId,
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

// One attempt's result, as the `execution.result` payload holds it.
type Attempt =
  | { outcome: "executed"; refund: { id: string; status: "COMPLETED" | "PENDING" } }
  | {
      outcome: "failed";
      refund?: { id: string; status: "FAILED" | "CANCELLED" };
      error?: RailRefusal;
    }
  | { outcome: "unknown"; error?: RailRefusal };

function refusal(error: PayPalError): RailRefusal {
  return { name: error.paypalName, issues: [...error.issues], debugId: error.debugId };
}

// What a refund call's answer means (ADR 0026): anything not definitely refused may have moved
// money, so it's unknown, never failed.
function outcomeOf(answer: { refund: PayPalRefund } | { error: unknown }): Attempt {
  if ("refund" in answer) {
    const { id, status } = answer.refund;
    if (status === "COMPLETED" || status === "PENDING") {
      return { outcome: "executed", refund: { id, status } };
    }
    return { outcome: "failed", refund: { id, status } };
  }
  const { error } = answer;
  if (!(error instanceof PayPalError)) return { outcome: "unknown" };
  const refused =
    error.kind === "invalid_request" ||
    (error.kind === "http" && error.status !== null && error.status >= 400 && error.status < 500);
  return { outcome: refused ? "failed" : "unknown", error: refusal(error) };
}

async function sendRefund(
  rail: PayPalClient,
  db: Database,
  send: Send,
  clock: () => Date,
): Promise<Execution> {
  let answer: { refund: PayPalRefund } | { error: unknown };
  try {
    const refund = await rail.refundCapture({
      captureId: send.captureId,
      amount: send.amount,
      customId: send.intentId,
      requestId: send.intentHash,
    });
    answer = { refund };
  } catch (error) {
    answer = { error };
  }
  const attempt = outcomeOf(answer);
  const execution: Execution = {
    outcome: attempt.outcome,
    refund: "refund" in attempt ? (attempt.refund ?? null) : null,
    error: "error" in attempt ? (attempt.error ?? null) : null,
    resultSeq: null,
    resultProblem: null,
    sent: true,
  };
  try {
    const appended = await appendEntry(
      db,
      executionResultEntry({
        at: clock().toISOString(),
        intentId: send.intentId,
        requestSeq: send.requestSeq,
        ...attempt,
      }),
    );
    if (appended.ok) execution.resultSeq = appended.entry.seq;
    else execution.resultProblem = `${appended.rejection.problem}: ${appended.rejection.detail}`;
  } catch {
    // A fixed line, so nothing the database error carries leaks.
    execution.resultProblem = "The result couldn't be written to the audit log.";
  }
  return execution;
}

export async function proposeRefund(input: ProposeInput): Promise<ProposeResult> {
  const { mandate, principal, proposal, ticket, now, rail, carrier, db } = input;
  const clock = input.clock ?? (() => new Date());

  // 1. Live records, outside the transaction.
  const captureId = captureOf(proposal);
  const live: { records: RecordSnapshots; problems: ReadProblem[] } =
    captureId === null
      ? { records: ticket ? { ticket } : {}, problems: [] }
      : await readLiveRecords({ captureId, ticket, rail, carrier });
  const { problems } = live;

  // 2. One transaction under the ledger's lock: history, then a replay's answer or a decision
  // and, on allow, the request.
  let planned: Planned;
  try {
    planned = await withAuditLog(db, async (log): Promise<Planned> => {
      const history = await readExecutionHistory(log.tx);
      // An unreadable history leaves `executions` out, so it's unknown, never empty, and the
      // proposal is decided, which can't allow.
      const records: RecordSnapshots = history.known
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
        if (normalized.ok) {
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

  // 3. After the commit: send the refund and log its result.
  const execution = planned.send === null ? null : await sendRefund(rail, db, planned.send, clock);

  if (!planned.replay) {
    const { response, record, seqs } = planned;
    return { ok: true, replay: false, response, record, problems, seqs, execution };
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
