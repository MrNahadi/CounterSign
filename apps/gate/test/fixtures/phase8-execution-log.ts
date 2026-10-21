import type { EntryInput } from "@countersign/ledger";

// An execution log exactly as phases 6 to 8 wrote it: refund requests with no `target`, first
// requests pointing at a decision, a replay, every result outcome, and both reconciliation
// sources. Phase 9's readers must read it as phase 8's did (ADR 0033).

const T1 = "2026-10-18T09:00:00.000Z";
const T2 = "2026-10-18T09:00:05.000Z";
const T3 = "2026-10-18T10:00:00.000Z";

export const hashOf = (n: number) => n.toString(16).padEnd(64, "a");
export const intentIdOf = (n: number) => `int_${hashOf(n).slice(0, 24)}`;

const decision = (n: number): EntryInput => ({
  entryType: "decision",
  refId: intentIdOf(n),
  at: T1,
  payload: { note: "illustrative decision" },
});

const firstRequest = (n: number, decisionSeq: number, at: string): EntryInput => ({
  entryType: "execution.requested",
  refId: intentIdOf(n),
  at,
  payload: {
    intentId: intentIdOf(n),
    intentHash: hashOf(n),
    principal: "agent:resolve",
    rail: "paypal",
    action: "paypal.refund",
    captureId: `CAP-${n}`,
    amount: { minor: 1800 * n, currency: "USD" },
    requestId: hashOf(n),
    replay: false,
    decisionSeq,
  },
});

// Seqs 1 to 12, in this order.
export const PHASE_8_LOG: EntryInput[] = [
  decision(1),
  firstRequest(1, 1, T1),
  {
    entryType: "execution.result",
    refId: intentIdOf(1),
    at: T2,
    payload: { requestSeq: 2, outcome: "executed", refund: { id: "REF-1", status: "COMPLETED" } },
  },
  decision(2),
  firstRequest(2, 4, T1),
  {
    entryType: "execution.result",
    refId: intentIdOf(2),
    at: T2,
    payload: { requestSeq: 5, outcome: "unknown" },
  },
  {
    entryType: "execution.requested",
    refId: intentIdOf(2),
    at: T3,
    payload: {
      intentId: intentIdOf(2),
      intentHash: hashOf(2),
      principal: "agent:resolve",
      rail: "paypal",
      action: "paypal.refund",
      captureId: "CAP-2",
      amount: { minor: 3600, currency: "USD" },
      requestId: hashOf(2),
      replay: true,
      firstRequestSeq: 5,
      proposal: '{"action":"create_refund"}',
      proposalTruncated: false,
    },
  },
  {
    entryType: "execution.result",
    refId: intentIdOf(2),
    at: T3,
    payload: {
      requestSeq: 7,
      outcome: "failed",
      error: { name: "UNPROCESSABLE_ENTITY", issues: ["CAPTURE_FULLY_REFUNDED"], debugId: "f00d" },
    },
  },
  decision(3),
  firstRequest(3, 9, T3),
  {
    entryType: "reconciliation",
    refId: intentIdOf(1),
    at: T3,
    payload: {
      source: "webhook",
      event: { id: "WH-1", type: "PAYMENT.CAPTURE.REFUNDED" },
      refund: {
        id: "REF-1",
        captureId: "CAP-1",
        status: "COMPLETED",
        amount: { minor: 1800, currency: "USD" },
      },
      resultSeq: 3,
    },
  },
  {
    entryType: "reconciliation",
    refId: null,
    at: T3,
    payload: {
      source: "poll",
      refund: {
        id: "REF-9",
        captureId: null,
        status: "PENDING",
        amount: { minor: 500, currency: "USD" },
      },
      resultSeq: null,
    },
  },
];

// What phase 8's readers made of it.
export const PHASE_8_READS = {
  history: {
    known: true,
    executions: [
      {
        call: "audit log executions",
        id: intentIdOf(1),
        principal: "agent:resolve",
        captureId: "CAP-1",
        amount: { minor: 1800, currency: "USD" },
        executedAt: T1,
      },
      {
        call: "audit log executions",
        id: intentIdOf(3),
        principal: "agent:resolve",
        captureId: "CAP-3",
        amount: { minor: 5400, currency: "USD" },
        executedAt: T3,
      },
    ],
  },
  intent1: {
    known: true,
    trail: {
      firstRequest: { seq: 2, at: T1, payload: firstRequest(1, 1, T1).payload },
      executed: { seq: 3, refund: { id: "REF-1", status: "COMPLETED" } },
      lastOutcome: "executed",
    },
  },
  intent2: {
    known: true,
    trail: {
      firstRequest: { seq: 5, at: T1, payload: firstRequest(2, 4, T1).payload },
      executed: null,
      lastOutcome: "failed",
    },
  },
  reconciliation: {
    known: true,
    state: {
      events: new Set(["WH-1"]),
      refunds: new Set(["REF-1", "REF-9"]),
      results: new Map([["REF-1", { seq: 3, intentId: intentIdOf(1) }]]),
    },
  },
  work: {
    known: true,
    work: {
      executed: [
        {
          intentId: intentIdOf(1),
          resultSeq: 3,
          refundId: "REF-1",
          captureId: "CAP-1",
          amount: { minor: 1800, currency: "USD" },
          reconciled: { status: "COMPLETED", amount: { minor: 1800, currency: "USD" } },
        },
      ],
      open: [{ intentId: intentIdOf(3), captureId: "CAP-3", at: T3 }],
    },
  },
};
