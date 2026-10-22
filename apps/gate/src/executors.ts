// One executor per executable action (ADR 0033), shared by an allowed proposal and an approved
// step-up. Each runs after the transaction that wrote its `execution.requested` entry has
// committed: it makes the one rail call the stored intent describes and appends the result as
// `execution.result`. A refund is sent with the intent hash as its PayPal-Request-Id (ADR 0026);
// an invoice send carries no request ID and is never retried. No AI, no ledger lock held here.

import type { Database } from "@countersign/db";
import { appendEntry } from "@countersign/ledger";
import type { IntentParams, Money } from "@countersign/mandate";
import { type PayPalClient, PayPalError, type PayPalRefund } from "@countersign/rail-paypal";
import type { ExecutableAction } from "./executable";
import {
  type ExecutionOutcome,
  type ExecutionResultPayload,
  executionResultEntry,
  type RequestTarget,
} from "./execution-log";

export type RailRefusal = { name: string | null; issues: string[]; debugId: string | null };

// What happened when the intent was carried out, or, when nothing was sent, what the log already
// says happened.
export type Execution = {
  outcome: ExecutionOutcome;
  refund: { id: string; status: string } | null;
  // The invoice an invoice send sent; absent for every other action.
  invoice?: { id: string; status: string };
  error: RailRefusal | null;
  // The `execution.result` entry; null when no rail call was made or the result couldn't be
  // written (then `resultProblem` says why).
  resultSeq: number | null;
  resultProblem: string | null;
  // False when no rail call was made (a replay of an executed intent, or an intent already
  // requested once).
  sent: boolean;
};

// One requested intent, as its `execution.requested` entry and the stored intent describe it.
// Only these values reach the rail.
export type ExecutionJob = {
  requestSeq: number;
  intentId: string;
  intentHash: string;
  action: ExecutableAction;
  target: RequestTarget;
  amount: Money;
  // The intent's hashed parameters; absent for a refund.
  params?: IntentParams;
};

// One attempt's result, as the `execution.result` payload holds it.
type Attempt = DistributiveOmit<ExecutionResultPayload, "requestSeq">;
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

type Executor = (rail: PayPalClient, job: ExecutionJob) => Promise<Attempt>;

function refusal(error: PayPalError): RailRefusal {
  return { name: error.paypalName, issues: [...error.issues], debugId: error.debugId };
}

// A call PayPal definitely refused: our own input check, or a 4xx. Anything else may have taken
// effect, so it's unknown, never failed.
function refused(error: PayPalError): boolean {
  return (
    error.kind === "invalid_request" ||
    (error.kind === "http" && error.status !== null && error.status >= 400 && error.status < 500)
  );
}

function errorAttempt(error: unknown): Attempt {
  if (!(error instanceof PayPalError)) return { outcome: "unknown" };
  return { outcome: refused(error) ? "failed" : "unknown", error: refusal(error) };
}

// A refund (ADR 0026): phase 6's call, request ID the intent hash.
async function executeRefund(rail: PayPalClient, job: ExecutionJob): Promise<Attempt> {
  if (!("captureId" in job.target)) throw new Error("a refund intent targets no capture");
  let refund: PayPalRefund;
  try {
    refund = await rail.refundCapture({
      captureId: job.target.captureId,
      amount: job.amount,
      customId: job.intentId,
      requestId: job.intentHash,
    });
  } catch (error) {
    return errorAttempt(error);
  }
  const { id, status } = refund;
  if (status === "COMPLETED" || status === "PENDING") {
    return { outcome: "executed", refund: { id, status } };
  }
  return { outcome: "failed", refund: { id, status } };
}

// An invoice send (ADR 0033): the intent's hashed parameters, absent values left out, no request
// ID. PayPal's own default for `send_to_recipient` is true, so an absent flag sends it as true.
async function executeInvoiceSend(rail: PayPalClient, job: ExecutionJob): Promise<Attempt> {
  if (!("invoiceId" in job.target)) throw new Error("an invoice send targets no invoice");
  const invoiceId = job.target.invoiceId;
  const params = job.params ?? {};
  const note = params.note ?? null;
  const recipients = params.additionalRecipients ?? [];
  try {
    const status = await rail.sendInvoice({
      invoiceId,
      sendToRecipient: params.sendToRecipient ?? true,
      ...(note === null ? {} : { note }),
      ...(recipients.length === 0 ? {} : { additionalRecipients: [...recipients] }),
    });
    return { outcome: "executed", invoice: { id: invoiceId, status } };
  } catch (error) {
    return errorAttempt(error);
  }
}

// Exactly the actions in EXECUTABLE_ACTIONS; the type keeps the two lists equal.
export const EXECUTORS: Record<ExecutableAction, Executor> = {
  "paypal.refund": executeRefund,
  "paypal.invoice.send": executeInvoiceSend,
};

// Carries out one requested intent through its action's executor and logs the result.
export async function execute(
  rail: PayPalClient,
  db: Database,
  job: ExecutionJob,
  clock: () => Date,
): Promise<Execution> {
  const attempt = await EXECUTORS[job.action](rail, job);
  const execution: Execution = {
    outcome: attempt.outcome,
    refund: "refund" in attempt ? (attempt.refund ?? null) : null,
    ...("invoice" in attempt ? { invoice: attempt.invoice } : {}),
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
        intentId: job.intentId,
        requestSeq: job.requestSeq,
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
