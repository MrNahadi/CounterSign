// One executor per executable action (ADR 0033), shared by an allowed proposal and an approved
// step-up. Each runs after the transaction that wrote its `execution.requested` entry has
// committed: it makes the one rail call the stored intent describes and appends the result as
// `execution.result`. A refund is sent with the intent hash as its PayPal-Request-Id (ADR 0026);
// an invoice send or a dispute action carries no request ID and is never retried (ADRs 0033 and
// 0035). No AI, no ledger lock held here.

import {
  type Database,
  readEvidenceDocument,
  type StoredEvidenceDocument,
  sha256Hex,
} from "@countersign/db";
import { appendEntry } from "@countersign/ledger";
import type { IntentParams, Money } from "@countersign/mandate";
import {
  type DisputeEvidence,
  type EvidenceDocument,
  OFFER_TYPES,
  type OfferType,
  type PayPalClient,
  PayPalError,
  type PayPalRefund,
} from "@countersign/rail-paypal";
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
  // The dispute a dispute action acted on, with its status as re-read after the call (null when
  // that read failed); absent for every other action.
  dispute?: { id: string; status: string | null };
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

// The database is for the evidence documents a provide-evidence intent names.
type Executor = (rail: PayPalClient, job: ExecutionJob, db: Database) => Promise<Attempt>;

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

// What a tracking number is sent with. Every carrier in this demo is the carrier mock, PayPal
// needs a free-form name for carrier OTHER, and only hashed values may vary, so it's this fixed
// label, never a name read from a record (ADR 0036).
export const EVIDENCE_CARRIER = { name: "OTHER", nameOther: "Carrier (simulated)" } as const;

// Sends one dispute action (ADR 0035): once, with no request ID, never retried. A 2xx is
// executed, a refusal failed and anything else unknown. The dispute's status is re-read after a
// 2xx; a read that fails leaves it null and never changes the outcome.
async function disputeAttempt(
  rail: PayPalClient,
  disputeId: string,
  send: () => Promise<number>,
): Promise<Attempt> {
  let status: number;
  try {
    status = await send();
  } catch (error) {
    return errorAttempt(error);
  }
  if (!(status >= 200 && status < 300)) return { outcome: "unknown" };
  let disputeStatus: string | null = null;
  try {
    disputeStatus = (await rail.getDispute(disputeId)).status;
  } catch {
    // Left null: the call took effect whatever the read says.
  }
  return { outcome: "executed", dispute: { id: disputeId, status: disputeStatus } };
}

function disputeOf(job: ExecutionJob): string {
  if (!("disputeId" in job.target)) throw new Error(`a ${job.action} intent targets no dispute`);
  return job.target.disputeId;
}

function noteOf(job: ExecutionJob): string {
  const note = job.params?.note;
  if (typeof note !== "string") throw new Error(`a ${job.action} intent has no note`);
  return note;
}

// Accept claim: the intent's hashed note.
async function executeAcceptClaim(rail: PayPalClient, job: ExecutionJob): Promise<Attempt> {
  const disputeId = disputeOf(job);
  const note = noteOf(job);
  return disputeAttempt(rail, disputeId, () => rail.acceptClaim({ disputeId, note }));
}

const isOfferType = (value: unknown): value is OfferType =>
  (OFFER_TYPES as readonly unknown[]).includes(value);

// Make offer: the intent's hashed type and note, and its amount, which is the offer's own, except
// for a replacement without a refund, which offers no money.
async function executeMakeOffer(rail: PayPalClient, job: ExecutionJob): Promise<Attempt> {
  const disputeId = disputeOf(job);
  const note = noteOf(job);
  const offerType = job.params?.offerType;
  if (!isOfferType(offerType)) throw new Error("a make offer intent has no offer type");
  return disputeAttempt(rail, disputeId, () =>
    rail.makeOffer({
      disputeId,
      note,
      offerType,
      ...(offerType === "REPLACEMENT_WITHOUT_REFUND" ? {} : { offerAmount: job.amount }),
    }),
  );
}

// A refusal that never reached PayPal: a document isn't the one approved.
const documentChanged = (detail: string): Attempt => ({
  outcome: "failed",
  error: { name: "DOCUMENT_CHANGED", issues: [detail], debugId: null },
});

// Provide evidence: the intent's hashed items, with every document it names read by ID. A row
// that's gone, can't be read or whose bytes no longer have the hashed SHA-256 sends nothing.
async function executeProvideEvidence(
  rail: PayPalClient,
  job: ExecutionJob,
  db: Database,
): Promise<Attempt> {
  const disputeId = disputeOf(job);
  const items = job.params?.evidence ?? [];
  if (items.length === 0) throw new Error("a provide evidence intent has no evidence");
  const documents: EvidenceDocument[] = [];
  for (const ref of job.params?.documents ?? []) {
    let stored: StoredEvidenceDocument | null;
    try {
      stored = await readEvidenceDocument(db, ref.id);
    } catch {
      return documentChanged(`Evidence document ${ref.id} can't be read.`);
    }
    if (stored === null) return documentChanged(`Evidence document ${ref.id} is gone.`);
    if (
      sha256Hex(stored.bytes) !== ref.sha256 ||
      stored.name !== ref.name ||
      stored.contentType !== "application/pdf"
    ) {
      return documentChanged(`Evidence document ${ref.id} isn't the one approved.`);
    }
    documents.push({ name: ref.name, contentType: "application/pdf", bytes: stored.bytes });
  }
  const evidences: DisputeEvidence[] = items.map((item) => {
    const tracking = item.trackingNumbers ?? [];
    const refundIds = item.refundIds ?? [];
    return {
      evidenceType: item.evidenceType,
      notes: item.notes,
      ...(tracking.length === 0
        ? {}
        : {
            trackingInfo: tracking.map((trackingNumber) => ({
              carrierName: EVIDENCE_CARRIER.name,
              carrierNameOther: EVIDENCE_CARRIER.nameOther,
              trackingNumber,
            })),
          }),
      ...(refundIds.length === 0 ? {} : { refundIds: [...refundIds] }),
    };
  });
  return disputeAttempt(rail, disputeId, () =>
    rail.provideEvidence({ disputeId, evidences, documents }),
  );
}

// Exactly the actions in EXECUTABLE_ACTIONS; the type keeps the two lists equal.
export const EXECUTORS: Record<ExecutableAction, Executor> = {
  "paypal.refund": executeRefund,
  "paypal.invoice.send": executeInvoiceSend,
  "paypal.dispute.accept_claim": executeAcceptClaim,
  "paypal.dispute.make_offer": executeMakeOffer,
  "paypal.dispute.provide_evidence": executeProvideEvidence,
};

// Carries out one requested intent through its action's executor and logs the result.
export async function execute(
  rail: PayPalClient,
  db: Database,
  job: ExecutionJob,
  clock: () => Date,
): Promise<Execution> {
  const attempt = await EXECUTORS[job.action](rail, job, db);
  const execution: Execution = {
    outcome: attempt.outcome,
    refund: "refund" in attempt ? (attempt.refund ?? null) : null,
    ...("invoice" in attempt ? { invoice: attempt.invoice } : {}),
    ...("dispute" in attempt ? { dispute: attempt.dispute } : {}),
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
