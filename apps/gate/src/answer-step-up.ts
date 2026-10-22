// answerStepUp(): the merchant's answer to one step-up (ADR 0032). One audit-log transaction,
// under the ledger's lock, reads the step-up, runs the checks in their fixed order, and writes
// one `approval` entry and, for an approved answer, the `execution.requested` entry that points
// at it. After that commits, an approved intent runs through its action's executor exactly as an
// allowed one (ADR 0033), using only the stored intent, bound by its hash. It never re-reads
// live records or re-decides. No AI, and the lock is never held across a network call.

import type { Database } from "@countersign/db";
import { type AuditLogWriter, withAuditLog } from "@countersign/ledger";
import { hashIntent } from "@countersign/mandate";
import type { PayPalClient } from "@countersign/rail-paypal";
import { z } from "zod";
import {
  APPROVAL_ANSWERS,
  type ApprovalChannel,
  type ApprovalRejectionCode,
  approvalEntry,
  readStepUp,
  type StepUp,
} from "./approval-log";
import { isExecutable } from "./executable";
import {
  executionRequestedEntry,
  readExecutionHistory,
  readIntentRecord,
  requestTarget,
} from "./execution-log";
import { type Execution, type ExecutionJob, execute } from "./executors";
import { type RecordProblem, recordingFailure } from "./record";

export type AnswerStepUpInput = {
  db: Database;
  rail: PayPalClient;
  // The step-up's ID: its decision entry's `seq`.
  stepUpSeq: number;
  // As the approver sent them; read here with zod.
  answer: unknown;
  intentHash: unknown;
  channel: ApprovalChannel;
  // The answer time: the `approval` entry's `at`, and the time expiry is checked at.
  now: Date;
  // The time an execution result is logged at, after the rail call. Defaults to the system clock.
  clock?: () => Date;
};

export type AnswerStepUpResult =
  | {
      kind: "answered";
      outcome: "approved" | "denied" | "rejected";
      // The one rejection code; null unless rejected.
      code: ApprovalRejectionCode | null;
      stepUpSeq: number;
      intentId: string;
      // The `approval` entry.
      approvalSeq: number;
      // The `execution.requested` entry; null unless approved.
      requestSeq: number | null;
      // What carrying out the intent did; null unless approved.
      execution: Execution | null;
    }
  // The `seq` isn't a step-up. Nothing was written.
  | { kind: "not_found" }
  // An answer other than approve or deny, or a hash that isn't one. Nothing was written.
  | { kind: "input_error"; detail: string }
  // An entry the step-up reader needs couldn't be read, so nothing can be answered. Nothing was
  // written.
  | { kind: "unknown"; seq: number; detail: string }
  // The ledger refused the entries, so nothing was written and nothing executes.
  | { kind: "recording_failed"; problem: RecordProblem; detail: string };

const AnswerSchema = z.strictObject({
  stepUpSeq: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  answer: z.enum(APPROVAL_ANSWERS),
  intentHash: z.string().regex(/^[0-9a-f]{64}$/),
});

type Planned =
  | Exclude<AnswerStepUpResult, { kind: "answered" }>
  | {
      kind: "answered";
      result: Omit<Extract<AnswerStepUpResult, { kind: "answered" }>, "execution">;
      send: ExecutionJob | null;
    };

// The first check that fails, in ADR 0032's order, or null when the answer stands.
async function rejection(
  log: AuditLogWriter,
  stepUp: StepUp,
  answer: "approve" | "deny",
  sentHash: string,
): Promise<ApprovalRejectionCode | null> {
  const stored = hashIntent(stepUp.intent);
  if (
    sentHash !== stepUp.intentHash ||
    stored.hash !== stepUp.intentHash ||
    stored.id !== stepUp.intentId
  ) {
    return "HASH_MISMATCH";
  }
  if (stepUp.state === "answered") return "ALREADY_ANSWERED";
  if (stepUp.state === "expired") return "EXPIRED";
  if (answer === "deny") return null;

  // An unreadable trail counts as requested, so nothing is sent (brief §10 trade-off 1).
  const trail = await readIntentRecord(log.tx, stepUp.intentId);
  if (!trail.known || trail.trail !== null) return "ALREADY_REQUESTED";

  const { action } = stepUp.intent;
  if (!isExecutable(action)) return "ACTION_UNAVAILABLE";

  if (action === "paypal.refund") {
    const { target } = stepUp.intent;
    if (target.kind !== "capture") return "DUPLICATE_REFUND";
    const history = await readExecutionHistory(log.tx);
    if (!history.known) return "DUPLICATE_REFUND";
    const other = history.executions.some(
      (execution) => execution.captureId === target.captureId && execution.id !== stepUp.intentId,
    );
    if (other) return "DUPLICATE_REFUND";
  }
  return null;
}

export async function answerStepUp(input: AnswerStepUpInput): Promise<AnswerStepUpResult> {
  const { db, rail, channel, now } = input;
  const clock = input.clock ?? (() => new Date());

  const parsed = AnswerSchema.safeParse({
    stepUpSeq: input.stepUpSeq,
    answer: input.answer,
    intentHash: input.intentHash,
  });
  if (!parsed.success) {
    const [issue] = parsed.error.issues;
    const field = issue?.path.join(".") || "answer";
    return { kind: "input_error", detail: `The ${field} isn't valid.` };
  }
  const { stepUpSeq, answer, intentHash } = parsed.data;
  const at = now.toISOString();

  let planned: Planned;
  try {
    planned = await withAuditLog(db, async (log): Promise<Planned> => {
      const read = await readStepUp(log.tx, stepUpSeq, now);
      if (!read.known) return { kind: "unknown", seq: read.seq, detail: read.detail };
      const { stepUp } = read;
      if (stepUp === null) return { kind: "not_found" };

      const code = await rejection(log, stepUp, answer, intentHash);
      const common = {
        at,
        intentId: stepUp.intentId,
        stepUpSeq,
        intentHash,
        approver: "merchant" as const,
        channel,
      };
      const approval = await log.append(
        code !== null
          ? approvalEntry({ ...common, answer, outcome: "rejected", code })
          : answer === "approve"
            ? approvalEntry({ ...common, answer, outcome: "approved" })
            : approvalEntry({ ...common, answer, outcome: "denied" }),
      );
      const outcome = code !== null ? "rejected" : answer === "approve" ? "approved" : "denied";
      const result = {
        kind: "answered" as const,
        outcome,
        code,
        stepUpSeq,
        intentId: stepUp.intentId,
        approvalSeq: approval.seq,
        requestSeq: null,
      } as const;
      if (outcome !== "approved") return { kind: "answered", result, send: null };

      // Approved: the stored intent, exactly as decided, is what executes.
      const { intent } = stepUp;
      const { action } = intent;
      if (!isExecutable(action)) throw new Error(`an approved ${action} can't execute`);
      const target = requestTarget(intent.target);
      const request = await log.append(
        executionRequestedEntry({
          at,
          intentId: stepUp.intentId,
          intentHash: stepUp.intentHash,
          principal: intent.principal,
          rail: intent.rail,
          action,
          target,
          amount: intent.amount,
          approvalSeq: approval.seq,
        }),
      );
      return {
        kind: "answered",
        result: { ...result, requestSeq: request.seq },
        send: {
          requestSeq: request.seq,
          intentId: stepUp.intentId,
          intentHash: stepUp.intentHash,
          action,
          target,
          amount: intent.amount,
          ...(intent.params === undefined ? {} : { params: intent.params }),
        },
      };
    });
  } catch (error) {
    const failure = recordingFailure(error);
    if (failure) return { kind: "recording_failed", ...failure };
    throw error;
  }

  if (planned.kind !== "answered") return planned;
  // After the commit: carry out the approved intent through its executor and log the result.
  const execution = planned.send === null ? null : await execute(rail, db, planned.send, clock);
  return { ...planned.result, execution };
}
