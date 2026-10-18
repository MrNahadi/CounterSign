// proposeRefund(): one refund proposal decided on live records and the execution history (brief
// §6 steps 1 to 5, ADR 0026). Live reads happen first, outside any transaction. Then one
// audit-log transaction, under the ledger's lock, reads the history, decides, writes the
// decision entry and, on allow, the `execution.requested` entry, so a second intent on the same
// capture always sees the first one's request. No AI, and the lock is never held across a
// network call.

import type { CarrierAdapter } from "@countersign/carrier-mock";
import type { Database } from "@countersign/db";
import { type ChainRow, withAuditLog } from "@countersign/ledger";
import { IdSchema, type Mandate } from "@countersign/mandate";
import type { PayPalClient } from "@countersign/rail-paypal";
import type { RecordSnapshots, TicketSnapshot } from "@countersign/verifiers";
import { z } from "zod";
import { type AgentResponse, type DecisionRecord, decide } from "./decide";
import { executionRequestedEntry, readExecutionHistory } from "./execution-log";
import { type ReadProblem, readLiveRecords } from "./live-records";
import { appendDecision, type RecordProblem, recordingFailure } from "./record";

export type ProposeInput = {
  mandate: Mandate;
  // Who is proposing, from the agent's credentials, never from the proposal itself.
  principal: string;
  // The proposal exactly as the agent sent it.
  proposal: unknown;
  // Simulated in phase 6, from Resolve in phase 8.
  ticket?: TicketSnapshot;
  now: Date;
  // Built by the gate from its environment, never from the proposal.
  rail: PayPalClient;
  carrier: CarrierAdapter;
  db: Database;
};

export type ProposeSeqs = {
  mandate: number;
  decision: number;
  // The `execution.requested` entry, on allow only.
  request: number | null;
};

export type ProposeResult =
  | {
      ok: true;
      response: AgentResponse;
      record: DecisionRecord;
      problems: ReadProblem[];
      seqs: ProposeSeqs;
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

type Decided = {
  response: AgentResponse;
  record: DecisionRecord;
  seqs: ProposeSeqs;
};

export async function proposeRefund(input: ProposeInput): Promise<ProposeResult> {
  const { mandate, principal, proposal, ticket, now, rail, carrier, db } = input;

  // 1. Live records, outside the transaction.
  const captureId = captureOf(proposal);
  const live: { records: RecordSnapshots; problems: ReadProblem[] } =
    captureId === null
      ? { records: ticket ? { ticket } : {}, problems: [] }
      : await readLiveRecords({ captureId, ticket, rail, carrier });
  const { problems } = live;

  // 2. One transaction under the ledger's lock: history, decision, request.
  let decided: Decided;
  try {
    decided = await withAuditLog(db, async (log): Promise<Decided> => {
      const history = await readExecutionHistory(log.tx);
      // An unreadable history leaves `executions` out, so it's unknown, never empty.
      const records: RecordSnapshots = history.known
        ? { ...live.records, executions: history.executions }
        : live.records;
      const result = decide({ mandate, principal, proposal, records, now });
      const recorded = await appendDecision(log, { proposal, principal, mandate, decided: result });
      let request: ChainRow | null = null;
      const { record } = result;
      if (record.decision === "allow") {
        const { intent, intentId, intentHash } = record;
        if (intent === null || intentId === null || intentHash === null) {
          throw new Error("an allowed decision has no intent");
        }
        request = await log.append(
          executionRequestedEntry({
            at: record.decidedAt,
            intentId,
            intentHash,
            principal: intent.principal,
            rail: intent.rail,
            action: intent.action,
            captureId: intent.target.captureId,
            amount: intent.amount,
            decisionSeq: recorded.decision.seq,
          }),
        );
      }
      return {
        response: result.response,
        record,
        seqs: {
          mandate: recorded.mandateSeq,
          decision: recorded.decision.seq,
          request: request?.seq ?? null,
        },
      };
    });
  } catch (error) {
    const failure = recordingFailure(error);
    if (failure) return { ok: false, ...failure, problems };
    throw error;
  }

  return { ok: true, ...decided, problems };
}
