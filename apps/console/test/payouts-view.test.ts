import { describe, expect, it } from "vitest";
import type { Answer } from "../src/approval-routes";
import {
  AnswerResultSchema,
  ApprovalsViewSchema,
  RecentSummarySchema,
} from "../src/approval-schemas";
import { answerOutcome, cardView, recentLine } from "../src/approvals-view";
import {
  type ChainVerdict,
  ChainVerdictSchema,
  DecisionDetailSchema,
  DecisionRowsPageSchema,
} from "../src/audit-schemas";
import { type DecisionPageView, decisionView, type Piece } from "../src/decision-view";
import { decisionsView } from "../src/decisions-view";
import { payoutStatusWords } from "../src/payout-words";

// The console's payout views (phase 12), fed the gate's answers as the console's routes and
// loaders pass them on, parsed with the console's own schemas first.

const NOW = new Date("2026-10-20T08:04:00.000Z");
const HASH = "a".repeat(64);
const INTENT = `int_${"b".repeat(24)}`;
const BATCH = "5UXD2E8A7EBQJ";
const ITEM = "8AELMXH8UB2P8";
const PAYEE = "dyeworks@example.com";
const amount = { minor: 4500, currency: "USD", display: "$45.00" };
const payeeTarget = { kind: "payee", id: PAYEE, order_id: null };

const payoutParams = (extra: Record<string, unknown> = {}) => ({
  kind: "payout",
  reference: "KDW-2026-0412",
  note: "April dye order",
  payee_name: "Kisumu Dye Works (illustrative)",
  ...extra,
});

const payoutCard = (params: unknown = payoutParams()) => ({
  step_up_id: 7,
  intent_id: INTENT,
  intent_hash: HASH,
  principal: "ops-agent",
  action: "paypal.payout",
  action_words: "Pay supplier",
  amount,
  target: payeeTarget,
  order_number: null,
  ticket: null,
  claim: null,
  reasons: [
    {
      code: "ALWAYS_NEEDS_APPROVAL",
      words: "This action always needs your approval.",
      detail: "",
    },
  ],
  checks: [
    {
      verifier: "payee.allowlisted",
      result: "pass",
      value: null,
      detail: `Kisumu Dye Works (illustrative) (${PAYEE}) is on payee list kikapu-studio-ops v1`,
      records: [{ call: "mandate payees", id: "kikapu-studio-ops v1" }],
    },
  ],
  claims: [],
  params,
  decided_at: "2026-10-20T08:01:00.000Z",
  expires_at: "2026-10-20T08:16:00.000Z",
  state: "open",
  answer: null,
  can_execute: true,
  cannot_execute: null,
});

const cardOf = (raw: unknown) =>
  cardView(ApprovalsViewSchema.parse({ open: [raw], recent: [] }).open[0] as never, NOW);

const answer = (execution: unknown) =>
  AnswerResultSchema.parse({
    outcome: "approved",
    code: null,
    step_up_id: 7,
    intent_id: INTENT,
    approval_seq: 9,
    execution,
  });

const payoutExecution = (extra: Record<string, unknown> = {}) => ({
  outcome: "executed",
  refund: null,
  invoice: null,
  dispute: null,
  payout: { batchId: BATCH, batchStatus: "PENDING", item: { id: ITEM, status: "UNCLAIMED" } },
  error: null,
  ...extra,
});

describe("payout item status words", () => {
  it("words the statuses requirements.md names, and shows any other as PayPal's code", () => {
    expect(payoutStatusWords("UNCLAIMED")).toBe("Waiting for the payee to claim it");
    expect(payoutStatusWords("SUCCESS")).toBe("Paid");
    expect(payoutStatusWords("PENDING")).toBe("Pending");
    expect(payoutStatusWords("RETURNED")).toBe("Returned to you");
    expect(payoutStatusWords("FAILED")).toBe("Failed");
    expect(payoutStatusWords("ONHOLD")).toBe("ONHOLD");
    expect(payoutStatusWords("SOMETHING_NEW")).toBe("SOMETHING_NEW");
  });
});

describe("the payout approval card", () => {
  it("shows the payee, amount, bill reference and note, with the payout line", () => {
    const view = cardOf(payoutCard());
    expect(view.actions).toEqual(["approve", "deny"]);
    expect(view.cannotExecute).toBeNull();
    expect(view.checks[0]?.verifier).toBe("Payee is on your list");
    expect(view.approving).toEqual({
      line: "Approving sends exactly this payout through PayPal. Nothing is sent until you approve.",
      rows: [
        { label: "Payee", text: "Kisumu Dye Works (illustrative)", mono: false, code: PAYEE },
        { label: "Amount", text: "$45.00", mono: false },
        { label: "Bill reference", text: "KDW-2026-0412", mono: true },
        { label: "Note", text: "April dye order", mono: false },
      ],
      items: [],
      documents: [],
    });
  });

  it("says No note, and shows the email alone when the payee has no name on the list", () => {
    const rows = cardOf(payoutCard(payoutParams({ note: null, payee_name: null }))).approving?.rows;
    expect(rows?.[0]).toEqual({ label: "Payee", text: PAYEE, mono: true });
    expect(rows?.[3]).toEqual({ label: "Note", text: "No note", mono: false });
  });

  it("shows a stored payout with no reference as not set, never invented", () => {
    const rows = cardOf(payoutCard(payoutParams({ reference: null }))).approving?.rows;
    expect(rows?.[2]).toEqual({ label: "Bill reference", text: "Not set", mono: false });
  });

  it("refuses payout params that aren't the gate's shape", () => {
    const parse = (params: unknown) =>
      ApprovalsViewSchema.safeParse({ open: [payoutCard(params)], recent: [] }).success;
    expect(parse(payoutParams())).toBe(true);
    expect(parse(payoutParams({ reference: 7 }))).toBe(false);
    expect(parse({ kind: "payout", reference: "KDW-1", note: null })).toBe(false);
  });
});

describe("the payout approve answer", () => {
  it("says the payout was sent, with the batch and the item's status words", () => {
    expect(answerOutcome(answer(payoutExecution()))).toEqual({
      sentence: `Approved. Payout sent, batch ${BATCH} (waiting for the payee to claim it).`,
      tone: "positive",
    });
    expect(
      answerOutcome(
        answer(
          payoutExecution({
            payout: {
              batchId: BATCH,
              batchStatus: "SUCCESS",
              item: { id: ITEM, status: "ONHOLD" },
            },
          }),
        ),
      ).sentence,
    ).toBe(`Approved. Payout sent, batch ${BATCH} (ONHOLD).`);
  });

  it("names the batch alone when the batch read named no item", () => {
    const execution = payoutExecution({
      payout: { batchId: BATCH, batchStatus: "PENDING", item: null },
    });
    expect(answerOutcome(answer(execution)).sentence).toBe(
      `Approved. Payout sent, batch ${BATCH}.`,
    );
  });

  it("says PayPal denied a denied batch, and an unknown payout stays unconfirmed", () => {
    const denied = payoutExecution({
      outcome: "failed",
      payout: { batchId: BATCH, batchStatus: "DENIED", item: null },
    });
    expect(answerOutcome(answer(denied))).toEqual({
      sentence: `Approved, but PayPal denied the payout batch ${BATCH}.`,
      tone: "danger",
    });
    const unclear = payoutExecution({ outcome: "unknown" });
    expect(answerOutcome(answer(unclear)).sentence).toBe(
      "Approved. PayPal hasn't confirmed it yet.",
    );
  });

  it("still parses an answer from before payouts", () => {
    const older = {
      outcome: "executed",
      refund: { id: "4XJ1", status: "COMPLETED" },
      invoice: null,
      error: null,
    };
    expect(answer(older).execution?.payout).toBeNull();
  });
});

describe("recent payout summaries", () => {
  const summary = (execution: unknown) =>
    RecentSummarySchema.parse({
      step_up_id: 7,
      intent_id: INTENT,
      action: "paypal.payout",
      action_words: "Pay supplier",
      amount,
      order_number: null,
      outcome: "approved",
      at: "2026-10-20T08:00:00.000Z",
      channel: "approvals_page",
      execution,
    });

  it("reads the payout's batch and item status", () => {
    const line = recentLine(
      summary({
        outcome: "executed",
        refund: null,
        invoice: null,
        dispute: null,
        payout: { batchId: BATCH, batchStatus: "SUCCESS", item: { id: ITEM, status: "SUCCESS" } },
      }),
      NOW,
    );
    expect(line.detail).toBe(`Payout batch ${BATCH}, paid`);
    expect(line.tone).toBe("positive");
  });

  it("still parses a summary from before payouts", () => {
    const parsed = summary({ outcome: "pending", refund: null, invoice: null });
    expect(parsed.execution?.payout).toBeNull();
    expect(recentLine(parsed, NOW).detail).toBe("Not run yet");
  });
});

// --- Decisions and a decision's page --------------------------------------------------------

const rowExecution = (
  payout: unknown = {
    batch_id: BATCH,
    batch_status: "PENDING",
    item: { id: ITEM, status: "UNCLAIMED" },
  },
) => ({
  outcome: "executed",
  refund: null,
  invoice: null,
  dispute: null,
  payout,
});

const payoutRow = (extra: Record<string, unknown> = {}) => ({
  readable: true,
  seq: 21,
  at: "2026-10-20T08:01:00.000Z",
  principal: "ops-agent",
  intent_id: INTENT,
  action: "paypal.payout",
  action_words: "Pay supplier",
  amount,
  target: payeeTarget,
  order_number: null,
  sender: null,
  claim: null,
  claim_words: null,
  decision: "step_up",
  reasons: [
    { code: "ALWAYS_NEEDS_APPROVAL", words: "This action always needs your approval.", detail: "" },
  ],
  matched_rules: ["payout-listed-supplier"],
  status: { kind: "approved", execution: rowExecution() },
  ...extra,
});

const pageOf = (rows: unknown[]) =>
  DecisionRowsPageSchema.parse({
    rows,
    counts: { all: rows.length, allowed: 0, stepped_up: rows.length, denied: 0 },
    next_before: null,
  });

describe("decisions: payout rows", () => {
  it("shows the payee as target and Payout sent as the status", () => {
    const [row] = decisionsView(pageOf([payoutRow()]), {}, NOW).rows;
    if (!row?.readable) throw new Error("expected a readable row");
    expect(row.action).toBe("Pay supplier");
    expect(row.status).toEqual({ words: "Approved, payout sent", href: null });
    expect(row.record).toBe(PAYEE);
    const [allowed] = decisionsView(
      pageOf([payoutRow({ status: { kind: "executed", execution: rowExecution() } })]),
      {},
      NOW,
    ).rows;
    expect(allowed?.readable && allowed.status).toEqual({ words: "Payout sent", href: null });
  });

  it("still parses a row execution from before payouts", () => {
    const older = {
      outcome: "executed",
      refund: { id: "4XJ1", status: "COMPLETED" },
      invoice: null,
    };
    const parsed = pageOf([
      payoutRow({ action: "paypal.refund", status: { kind: "executed", execution: older } }),
    ]);
    const [row] = decisionsView(parsed, {}, NOW).rows;
    expect(row?.readable && row.status?.words).toBe("Refunded");
  });
});

const entry = (seq: number, type: string, parts: unknown) => ({
  seq,
  type,
  at: "2026-10-20T08:02:00.000Z",
  hash: String(seq % 10).repeat(64),
  readable: true,
  parts,
});

const payoutResult = (extra: Record<string, unknown> = {}) => ({
  kind: "execution.result",
  request_seq: 23,
  outcome: "executed",
  refund: null,
  invoice: null,
  dispute: null,
  payout: {
    batch_id: BATCH,
    batch_status: "PENDING",
    item: { id: ITEM, status: "UNCLAIMED" },
    payee: PAYEE,
    amount,
  },
  error: null,
  ...extra,
});

const reconciliation = (extra: Record<string, unknown> = {}) => ({
  kind: "reconciliation",
  source: "poll",
  event: null,
  refund: null,
  payout: { batch_id: BATCH, item_id: ITEM, status: "SUCCESS", amount, payee: PAYEE },
  result_seq: 24,
  ...extra,
});

const payoutTrail = [
  entry(21, "decision", { kind: "decision", decision: "step_up" }),
  entry(22, "approval", {
    kind: "approval",
    step_up_seq: 21,
    answer: "approve",
    outcome: "approved",
    code: null,
    channel: "approvals_page",
  }),
  entry(23, "execution.requested", {
    kind: "execution.requested",
    action: "paypal.payout",
    request_id: HASH,
    replay: false,
    decision_seq: null,
    approval_seq: 22,
    first_request_seq: null,
    amount,
  }),
  entry(24, "execution.result", payoutResult()),
  entry(25, "reconciliation", reconciliation()),
  entry(
    26,
    "reconciliation",
    reconciliation({
      source: "webhook",
      event: {
        id: "WH-1RX43126GA4459612-8KW07451BL2186347",
        type: "PAYMENT.PAYOUTS-ITEM.RETURNED",
      },
      payout: { batch_id: BATCH, item_id: ITEM, status: "RETURNED", amount, payee: PAYEE },
    }),
  ),
];

const payoutDetail = (extra: Record<string, unknown> = {}) =>
  DecisionDetailSchema.parse({
    ...payoutRow(),
    intent_hash: HASH,
    intent_canonical: "{}",
    mandate: { id: "kikapu-studio-ops", version: 1, hash: "9".repeat(64), seq: 1 },
    usage: { known: false, detail: "Not read." },
    safe_reply_hint: null,
    expires_at: null,
    claims: [],
    trace: [],
    ticket: null,
    proposal: "{}",
    proposal_truncated: false,
    entry: { seq: 21, at: "2026-10-20T08:01:00.000Z", hash: HASH, prev_hash: HASH },
    trail: payoutTrail,
    ...extra,
  });

const intact: Answer<ChainVerdict> = {
  ok: true,
  value: ChainVerdictSchema.parse({ intact: true, entry_count: 26, head: null, problems: [] }),
};

const readable = (value: DecisionPageView) => {
  if (!value.readable) throw new Error("expected a readable view");
  return value;
};

const textOf = (pieces: Piece[]) =>
  pieces
    .map((piece) => ("text" in piece ? piece.text : "mono" in piece ? piece.mono : piece.code))
    .join("");

describe("a payout decision's page", () => {
  it("says the payout was sent and words its request, result and reconciliations", () => {
    const view = readable(decisionView(payoutDetail(), intact, NOW));
    expect(view.title).toBe(`Pay supplier $45.00 on ${PAYEE}`);
    expect(view.line).toBe("Proposed by ops-agent at 20 Oct 2026, 08:01 UTC. The payout was sent.");
    expect(view.happened.slice(2).map((line) => textOf(line.pieces))).toEqual([
      "Asked PayPal to pay out $45.00.",
      `Paid out $45.00 to ${PAYEE}, batch ${BATCH} (waiting for the payee to claim it).`,
      `Re-read payout item ${ITEM}: paid.`,
      `Matched webhook WH-1RX43126GA4459612-8KW07451BL2186347 to payout item ${ITEM}: returned to you.`,
    ]);
    const result = view.happened[3]?.pieces ?? [];
    expect(result).toContainEqual({ mono: PAYEE });
    expect(result).toContainEqual({ mono: BATCH });
  });

  it("words a denied batch, a result whose request can't be read, and an item it didn't read", () => {
    const batch = (batch_status: string) => ({
      batch_id: BATCH,
      batch_status,
      item: null,
      payee: null,
      amount: null,
    });
    const lines = readable(
      decisionView(
        payoutDetail({
          trail: [
            entry(
              24,
              "execution.result",
              payoutResult({ outcome: "failed", payout: batch("DENIED") }),
            ),
            entry(27, "execution.result", payoutResult({ payout: batch("PENDING") })),
            entry(28, "reconciliation", reconciliation({ payout: null })),
          ],
        }),
        intact,
        NOW,
      ),
    ).happened.map((line) => textOf(line.pieces));
    expect(lines).toEqual([
      `PayPal denied the payout batch ${BATCH}.`,
      `PayPal took the payout, batch ${BATCH}.`,
      "Reconciled, with no refund or payout named.",
    ]);
  });

  it("still parses trail entries from before payouts", () => {
    const older = payoutDetail({
      trail: [
        entry(24, "execution.result", {
          kind: "execution.result",
          request_seq: 23,
          outcome: "executed",
          refund: { id: "4XJ1", status: "COMPLETED" },
          invoice: null,
          error: null,
        }),
        entry(25, "reconciliation", {
          kind: "reconciliation",
          source: "poll",
          event: null,
          refund: { id: "4XJ1", status: "COMPLETED", amount },
          result_seq: 24,
        }),
      ],
    });
    const view = readable(decisionView(older, intact, NOW));
    expect(view.happened.map((line) => textOf(line.pieces))).toEqual([
      "PayPal refunded it: 4XJ1, completed.",
      "Re-read refund 4XJ1: completed.",
    ]);
  });
});
