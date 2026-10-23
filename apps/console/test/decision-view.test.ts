import { describe, expect, it } from "vitest";
import type { Answer } from "../src/approval-routes";
import {
  type ChainVerdict,
  ChainVerdictSchema,
  type DecisionDetail,
  DecisionDetailSchema,
} from "../src/audit-schemas";
import {
  absoluteTime,
  DECISION_COPY,
  type DecisionPageView,
  decisionPageOf,
  decisionView,
  hashView,
  intentPageOf,
} from "../src/decision-view";

// A decision's page view model, fed the gate's decision detail as the console's loader passes it
// on (parsed with the console's own schema first, so a fixture can't drift from it).

const NOW = new Date("2026-10-20T08:04:00.000Z");
const INTENT = `int_${"b".repeat(24)}`;
const HASH = "a".repeat(64);
const PREV = "c".repeat(64);
const INTENT_HASH = "d".repeat(64);
const amount = { minor: 24000, currency: "USD", display: "$240.00" };
const target = { kind: "capture", id: "CAP-1037", order_id: "ORD-1037" };

const executed = {
  outcome: "executed",
  refund: { id: "4XJ12345", status: "COMPLETED" },
  invoice: null,
};

const ticket = {
  id: "KT-77",
  channel: "email",
  sender: "payer@example.com",
  subject: "Broken lamp",
  excerpt: "It arrived in pieces.",
  received_at: "2026-10-20T07:50:00.000Z",
  attachment_ids: ["att-1"],
  simulated: true,
  thread_id: "thr-5",
};

const source = (words: string, call: string, id: string) => ({ words, call, id });

const claims = [
  {
    check: "evidence.photo_present",
    claim: { text: "1 photo attached", quote: null, simulated: false },
    record: {
      words: "Photo of the damage",
      detail: "1 photo on the ticket.",
      value: null,
      sources: [source("Ticket store", "tickets.read", "KT-77")],
    },
    verdict: "matches",
  },
  {
    check: "shipment.status",
    claim: { text: "Says the parcel never arrived", quote: null, simulated: false },
    record: {
      words: "Carrier status",
      detail: "The carrier says it was delivered.",
      value: "delivered",
      sources: [source("Carrier (simulated)", "carrier.track", "TRK-9")],
    },
    verdict: "contradicts",
  },
  {
    check: "dispute.none_open",
    claim: null,
    record: { words: "No open PayPal dispute", detail: "No dispute.", value: null, sources: [] },
    verdict: "passes",
  },
  {
    check: "ticket.from_payer",
    claim: { text: "Sent from payer@example.com", quote: null, simulated: false },
    record: { words: "Sender paid for the order", detail: "Unknown.", value: null, sources: [] },
    verdict: "no_record",
  },
  {
    check: "ledger.velocity",
    claim: null,
    record: { words: "Within your usual pace", detail: "Too many.", value: null, sources: [] },
    verdict: "fails",
  },
  {
    check: "message",
    claim: { text: "Broken lamp", quote: "It arrived in pieces.", simulated: true },
    record: {
      words: "Messages can't approve money. Only your signed rules can.",
      detail: "",
      value: null,
      sources: [source("Mandate", "mandate", "kikapu-studio v3")],
    },
    verdict: "not_used",
  },
];

const trace = [
  {
    verifier: "capture.refundable",
    words: "Payment can be refunded",
    result: "pass",
    value: null,
    detail: "Completed capture.",
    records: [
      { words: "PayPal capture", call: "GET /v2/payments/captures", id: "CAP-1037" },
      { words: "PayPal order", call: "GET /v2/checkout/orders", id: null },
    ],
  },
  {
    verifier: "shipment.status",
    words: "Carrier status",
    result: "unknown",
    value: null,
    detail: "No tracking.",
    records: [],
  },
  {
    verifier: "ticket.from_payer",
    words: "Sender paid for the order",
    result: "fail",
    value: null,
    detail: "Not the payer.",
    records: [],
  },
];

const trail = [
  {
    seq: 12,
    type: "decision",
    at: "2026-10-20T08:01:00.000Z",
    hash: HASH,
    readable: true,
    parts: { kind: "decision", decision: "allow" },
  },
  {
    seq: 13,
    type: "execution.requested",
    at: "2026-10-20T08:01:01.000Z",
    hash: "e".repeat(64),
    readable: true,
    parts: {
      kind: "execution.requested",
      request_id: INTENT_HASH,
      replay: false,
      decision_seq: 12,
      approval_seq: null,
      first_request_seq: null,
      amount,
    },
  },
  {
    seq: 14,
    type: "execution.result",
    at: "2026-10-20T08:01:02.000Z",
    hash: "f".repeat(64),
    readable: true,
    parts: {
      kind: "execution.result",
      request_seq: 13,
      outcome: "executed",
      refund: { id: "4XJ12345", status: "COMPLETED" },
      invoice: null,
      error: null,
    },
  },
  {
    seq: 15,
    type: "reconciliation",
    at: "2026-10-20T08:02:00.000Z",
    hash: "1".repeat(64),
    readable: true,
    parts: {
      kind: "reconciliation",
      source: "webhook",
      event: { id: "WH-55", type: "PAYMENT.CAPTURE.REFUNDED" },
      refund: { id: "4XJ12345", status: "COMPLETED", amount },
      result_seq: 14,
    },
  },
  {
    seq: 16,
    type: "approval",
    at: "2026-10-20T08:03:00.000Z",
    hash: "2".repeat(64),
    readable: false,
    problem: "The payload isn't JSON.",
  },
];

const detail = (extra: Record<string, unknown>): DecisionDetail =>
  DecisionDetailSchema.parse({
    readable: true,
    seq: 12,
    at: "2026-10-20T08:01:00.000Z",
    principal: "support-agent",
    intent_id: INTENT,
    action: "paypal.refund",
    action_words: "Refund",
    amount,
    target,
    order_number: "KIK-1037",
    sender: "payer@example.com",
    claim: "damaged",
    claim_words: "Says the item arrived damaged",
    decision: "allow",
    reasons: [],
    matched_rules: ["refund-damaged"],
    status: { kind: "executed", execution: executed },
    intent_hash: INTENT_HASH,
    intent_canonical: "{}",
    mandate: { id: "kikapu-studio", version: 3, hash: "9".repeat(64), seq: 1 },
    usage: { known: false, detail: "Not read." },
    safe_reply_hint: null,
    expires_at: null,
    claims,
    trace,
    ticket,
    proposal: "{}",
    proposal_truncated: false,
    entry: { seq: 12, at: "2026-10-20T08:01:00.000Z", hash: HASH, prev_hash: PREV },
    trail,
    ...extra,
  });

const intact: Answer<ChainVerdict> = {
  ok: true,
  value: ChainVerdictSchema.parse({
    intact: true,
    entry_count: 16,
    head: { seq: 16, hash: HASH },
    problems: [],
  }),
};

const readable = (value: DecisionPageView) => {
  if (!value.readable) throw new Error("expected a readable view");
  return value;
};

describe("decisionView: the header", () => {
  const view = readable(decisionView(detail({}), intact, NOW));

  it("titles the decision with its action, amount and order, and badges it", () => {
    expect(view.title).toBe("Refund $240.00 on KIK-1037");
    expect(view.breadcrumb).toEqual({
      parent: { label: "Decisions", href: "/decisions" },
      current: "Refund on KIK-1037",
    });
    expect(view.badge).toEqual({ label: "Allowed", tone: "positive" });
  });

  it("says who proposed it from whose ticket and that PayPal refunded it", () => {
    expect(view.line).toBe(
      "Proposed by support-agent from payer@example.com's ticket at 20 Oct 2026, 08:01 UTC. PayPal refunded it.",
    );
  });

  it("links Open ticket to the ticket's thread", () => {
    expect(view.ticketHref).toBe("/inbox?thread=thr-5");
    expect(decisionView(detail({ ticket: null }), intact, NOW)).toMatchObject({ ticketHref: null });
  });

  it("says no money moved for a deny, a failed run or a step-up, and never for an unconfirmed one", () => {
    const line = (extra: Record<string, unknown>) =>
      readable(decisionView(detail(extra), intact, NOW)).line;
    expect(line({ decision: "deny", status: null, sender: null })).toBe(
      "Proposed by support-agent at 20 Oct 2026, 08:01 UTC. No money moved.",
    );
    expect(
      line({
        status: { kind: "failed", execution: { ...executed, outcome: "failed", refund: null } },
      }),
    ).toMatch(/No money moved\.$/);
    expect(line({ decision: "step_up", status: { kind: "open", execution: null } })).toMatch(
      /No money moved\.$/,
    );
    expect(
      line({
        status: { kind: "unknown", execution: { ...executed, outcome: "unknown", refund: null } },
      }),
    ).toMatch(/PayPal hasn't confirmed it yet\.$/);
    expect(line({ decision: "step_up", status: { kind: "unknown", execution: null } })).toMatch(
      /PayPal hasn't confirmed it yet\.$/,
    );
  });

  it("says the invoice was sent for an executed invoice", () => {
    const view = readable(
      decisionView(
        detail({
          action: "paypal.invoice.send",
          action_words: "Send invoice",
          target: { kind: "invoice", id: "INV2-AAAA", order_id: null },
          order_number: null,
          status: {
            kind: "executed",
            execution: {
              outcome: "executed",
              refund: null,
              invoice: { id: "INV2-AAAA", status: "SENT" },
            },
          },
        }),
        intact,
        NOW,
      ),
    );
    expect(view.line).toMatch(/The invoice was sent\.$/);
    expect(view.title).toBe("Send invoice $240.00 on INV2-AAAA");
    expect(view.exports.map((link) => link.label)).toEqual(["Export evidence"]);
  });

  it("says what an executed dispute action did, with the dispute as the target", () => {
    const line = (action: string, words: string) =>
      readable(
        decisionView(
          detail({
            action,
            action_words: words,
            target: { kind: "dispute", id: "PP-D-4012", order_id: null },
            order_number: null,
            status: {
              kind: "approved",
              execution: {
                outcome: "executed",
                refund: null,
                invoice: null,
                dispute: { id: "PP-D-4012", status: "UNDER_REVIEW" },
              },
            },
          }),
          intact,
          NOW,
        ),
      );
    expect(line("paypal.dispute.provide_evidence", "Provide dispute evidence").line).toMatch(
      /The evidence was sent\.$/,
    );
    expect(line("paypal.dispute.accept_claim", "Accept dispute claim").line).toMatch(
      /The claim was accepted\.$/,
    );
    expect(line("paypal.dispute.make_offer", "Make dispute offer").line).toMatch(
      /The offer was sent\.$/,
    );
    expect(line("paypal.dispute.provide_evidence", "Provide dispute evidence").title).toBe(
      "Provide dispute evidence $240.00 on PP-D-4012",
    );
  });
});

describe("decisionView: claims vs records", () => {
  const view = readable(decisionView(detail({}), intact, NOW));

  it("keeps the gate's pairs in order with the verdict badge and tone for each", () => {
    expect(view.claims.map((pair) => [pair.check, pair.verdict])).toEqual([
      ["evidence.photo_present", { label: "Matches", tone: "positive" }],
      ["shipment.status", { label: "Contradicts", tone: "danger" }],
      ["dispute.none_open", { label: "Passes", tone: "positive" }],
      ["ticket.from_payer", { label: "No record", tone: "neutral" }],
      ["ledger.velocity", { label: "Fails", tone: "danger" }],
      ["message", { label: "Not used", tone: "neutral" }],
    ]);
  });

  it("shows the record words with the value, the detail, and each source with its ID", () => {
    expect(view.claims[1]?.record).toEqual({
      lead: "Carrier status: delivered",
      detail: "The carrier says it was delivered.",
      sources: [{ words: "Carrier (simulated)", call: "carrier.track", id: "TRK-9" }],
    });
    expect(view.claims[2]?.claim).toBeNull();
    expect(view.claims[5]?.claim).toEqual({
      text: "Broken lamp",
      quote: "It arrived in pieces.",
      simulated: true,
    });
  });

  it("shows every trace entry with its records, a missing ID as none, and its result", () => {
    expect(view.trace).toEqual([
      {
        verifier: "capture.refundable",
        words: "Payment can be refunded",
        detail: "Completed capture.",
        records: [
          { words: "PayPal capture", call: "GET /v2/payments/captures", id: "CAP-1037" },
          { words: "PayPal order", call: "GET /v2/checkout/orders", id: "none" },
        ],
        result: { label: "Pass", tone: "positive" },
      },
      expect.objectContaining({ result: { label: "Unknown", tone: "neutral" } }),
      expect.objectContaining({ result: { label: "Fail", tone: "danger" } }),
    ]);
  });
});

describe("decisionView: why, and the suggested reply", () => {
  it("lists the matched rules for an allow, with no reply", () => {
    const view = readable(decisionView(detail({}), intact, NOW));
    expect(view.why).toEqual({
      heading: "Why it was allowed",
      items: [{ words: "Allowed by rule", code: "refund-damaged", detail: null }],
    });
    expect(view.reply).toBeNull();
  });

  it("lists each reason with its code for a deny, and offers the reply", () => {
    const view = readable(
      decisionView(
        detail({
          decision: "deny",
          status: null,
          reasons: [
            {
              code: "TICKET_NOT_FROM_PAYER",
              words: "The message isn't from the person who paid.",
              detail: "buyer-a@example.com is not the payer.",
            },
          ],
          safe_reply_hint: "We can only refund the person who paid for the order.",
        }),
        intact,
        NOW,
      ),
    );
    expect(view.why).toEqual({
      heading: "Why it was denied",
      items: [
        {
          words: "The message isn't from the person who paid.",
          code: "TICKET_NOT_FROM_PAYER",
          detail: "buyer-a@example.com is not the payer.",
        },
      ],
    });
    expect(view.badge).toEqual({ label: "Denied", tone: "danger" });
    expect(view.reply).toEqual({
      text: "We can only refund the person who paid for the order.",
      note: "Only repeats what the records say",
    });
  });

  it("calls a step-up held and never offers a reply for it", () => {
    const view = readable(
      decisionView(
        detail({
          decision: "step_up",
          status: { kind: "open", execution: null },
          reasons: [{ code: "AMOUNT_OVER_LIMIT", words: "Over the limit.", detail: "" }],
          safe_reply_hint: "Held.",
        }),
        intact,
        NOW,
      ),
    );
    expect(view.why.heading).toBe("Why it was held");
    expect(view.why.items[0]?.detail).toBeNull();
    expect(view.reply).toBeNull();
    expect(view.waiting).toEqual({ words: "Waiting for you", href: "/approvals" });
  });
});

describe("decisionView: what happened", () => {
  const view = readable(decisionView(detail({}), intact, NOW));

  it("turns each trail entry into its sentence, with sandbox IDs in mono", () => {
    expect(view.happened.map((line) => line.pieces)).toEqual([
      [{ text: "Countersign allowed it." }],
      [{ text: "Asked PayPal to refund $240.00." }],
      [{ text: "PayPal refunded it: " }, { mono: "4XJ12345" }, { text: ", completed." }],
      [
        { text: "Matched webhook " },
        { mono: "WH-55" },
        { text: " to refund " },
        { mono: "4XJ12345" },
        { text: ", completed." },
      ],
      [{ text: "Entry 16 (approval) can't be read: The payload isn't JSON." }],
    ]);
    expect(view.happened[0]).toMatchObject({ seq: 12, when: "3m ago" });
    expect(view.waiting).toBeNull();
  });

  it("words approvals, refusals and invoices", () => {
    const at = "2026-10-20T08:02:00.000Z";
    const entry = (seq: number, type: string, parts: Record<string, unknown>) => ({
      seq,
      type,
      at,
      hash: HASH,
      readable: true,
      parts: { kind: type, ...parts },
    });
    const view = readable(
      decisionView(
        detail({
          trail: [
            entry(20, "approval", {
              step_up_seq: 12,
              answer: "approve",
              outcome: "approved",
              code: null,
              channel: "approvals_page",
            }),
            entry(21, "approval", {
              step_up_seq: 12,
              answer: "approve",
              outcome: "rejected",
              code: "APPROVAL_EXPIRED",
              channel: "cli",
            }),
            entry(22, "approval", {
              step_up_seq: 12,
              answer: "deny",
              outcome: "denied",
              code: null,
              channel: "approvals_page",
            }),
            entry(23, "execution.requested", {
              request_id: null,
              replay: false,
              decision_seq: null,
              approval_seq: 20,
              first_request_seq: null,
              amount,
            }),
            entry(24, "execution.result", {
              request_seq: 23,
              outcome: "failed",
              refund: null,
              invoice: null,
              error: { name: "UNPROCESSABLE_ENTITY", issues: [], debug_id: "dbg-1" },
            }),
            entry(25, "execution.result", {
              request_seq: 23,
              outcome: "executed",
              refund: null,
              invoice: { id: "INV2-AAAA", status: "SENT" },
              error: null,
            }),
          ],
        }),
        intact,
        NOW,
      ),
    );
    expect(view.happened.map((line) => line.pieces)).toEqual([
      [{ text: "Approved by you on the approvals page." }],
      [
        { text: "An answer from the command line was turned away: " },
        { code: "APPROVAL_EXPIRED" },
        { text: "." },
      ],
      [{ text: "Denied by you on the approvals page." }],
      [{ text: "Asked PayPal to send the invoice." }],
      [
        { text: "PayPal refused it: UNPROCESSABLE_ENTITY." },
        { text: " Debug ID " },
        { mono: "dbg-1" },
        { text: "." },
      ],
      [{ text: "PayPal sent the invoice: " }, { mono: "INV2-AAAA" }, { text: ", sent." }],
    ]);
  });

  it("words a dispute action's request and result by its action", () => {
    const at = "2026-10-20T08:02:00.000Z";
    const entry = (seq: number, type: string, parts: Record<string, unknown>) => ({
      seq,
      type,
      at,
      hash: HASH,
      readable: true,
      parts: { kind: type, ...parts },
    });
    const request = (action: string) =>
      entry(30, "execution.requested", {
        action,
        request_id: null,
        replay: false,
        decision_seq: null,
        approval_seq: 20,
        first_request_seq: null,
        amount,
      });
    const result = (action: string | null, status: string | null) =>
      entry(31, "execution.result", {
        request_seq: 30,
        outcome: "executed",
        refund: null,
        invoice: null,
        dispute: { id: "PP-D-4012", status, action },
        error: null,
      });
    const view = readable(
      decisionView(
        detail({
          trail: [
            request("paypal.dispute.provide_evidence"),
            result("paypal.dispute.provide_evidence", "UNDER_REVIEW"),
            result("paypal.dispute.provide_evidence", null),
            request("paypal.dispute.accept_claim"),
            result("paypal.dispute.accept_claim", "RESOLVED"),
            request("paypal.dispute.make_offer"),
            result("paypal.dispute.make_offer", "WAITING_FOR_BUYER_RESPONSE"),
            result(null, "UNDER_REVIEW"),
          ],
        }),
        intact,
        NOW,
      ),
    );
    expect(view.happened.map((line) => line.pieces)).toEqual([
      [{ text: "Asked PayPal to send the evidence." }],
      [
        { text: "PayPal took the evidence for " },
        { mono: "PP-D-4012" },
        { text: ": under review." },
      ],
      [{ text: "PayPal took the evidence for " }, { mono: "PP-D-4012" }, { text: "." }],
      [{ text: "Asked PayPal to accept the claim." }],
      [{ text: "Accepted the claim on " }, { mono: "PP-D-4012" }, { text: "." }],
      [{ text: "Asked PayPal to send the offer." }],
      [{ text: "Sent an offer on " }, { mono: "PP-D-4012" }, { text: "." }],
      [{ text: "PayPal acted on " }, { mono: "PP-D-4012" }, { text: ": under review." }],
    ]);
  });
});

describe("decisionView: the audit entry and exports", () => {
  it("shows the chain badge from the verdict, the hashes cut short with their full values, and the mandate", () => {
    const view = readable(decisionView(detail({}), intact, NOW));
    expect(view.entry).toEqual({
      heading: "Audit entry 12",
      chain: expect.objectContaining({ label: "Chain intact", tone: "positive" }),
      intentHash: { short: `${"d".repeat(12)}…`, full: INTENT_HASH },
      hash: { short: `${"a".repeat(12)}…`, full: HASH },
      prevHash: { short: `${"c".repeat(12)}…`, full: PREV },
      mandate: "kikapu-studio version 3",
      checkHref: "/audit",
    });
  });

  it("never shows the chain intact without a verdict", () => {
    const view = decisionView(detail({}), { ok: false, status: 502, message: "Down." }, NOW);
    expect(view.entry.chain).toMatchObject({ label: "Chain not checked", tone: "neutral" });
    const broken = decisionView(
      detail({}),
      {
        ok: true,
        value: ChainVerdictSchema.parse({
          intact: false,
          entry_count: 16,
          head: { seq: 16, hash: HASH },
          problems: [{ seq: 4, code: "HASH_MISMATCH", detail: "Changed." }],
        }),
      },
      NOW,
    );
    expect(broken.entry.chain).toMatchObject({ label: "Chain broken", tone: "danger" });
  });

  it("exports the intent, and for a capture target the payment too", () => {
    const view = readable(decisionView(detail({}), intact, NOW));
    expect(view.exports).toEqual([
      { label: "Export evidence", href: `/api/audit/export?intent=${INTENT}` },
      { label: "Export evidence for this payment", href: "/api/audit/export?capture=CAP-1037" },
    ]);
  });

  it("offers no export for a proposal that never became an intent", () => {
    const view = readable(
      decisionView(
        detail({
          intent_id: null,
          action: null,
          action_words: null,
          amount: null,
          target: null,
          order_number: null,
          sender: null,
          intent_hash: null,
          decision: "deny",
          status: null,
          ticket: null,
        }),
        intact,
        NOW,
      ),
    );
    expect(view.exports).toEqual([]);
    expect(view.entry.intentHash).toBeNull();
    expect(view.title).toBe("Proposal not read");
  });

  it("keeps a short hash whole", () => {
    expect(hashView("abc")).toEqual({ short: "abc", full: "abc" });
    expect(absoluteTime("not a time")).toBe("not a time");
  });
});

describe("decisionView: an unreadable entry", () => {
  it("shows its problem and raw payload, never a guess", () => {
    const view = decisionView(
      DecisionDetailSchema.parse({
        readable: false,
        seq: 30,
        at: "2026-10-20T08:00:00.000Z",
        hash: HASH,
        prev_hash: PREV,
        problem: "The payload isn't a decision.",
        payload: '{"junk":true}',
      }),
      intact,
      NOW,
    );
    expect(view).toMatchObject({
      readable: false,
      title: "Decision 30",
      line: "This entry can't be read.",
      problem: "The payload isn't a decision.",
      payload: '{"junk":true}',
      breadcrumb: { current: "Decision 30" },
    });
    expect(view).not.toHaveProperty("badge");
  });
});

describe("decisionPageOf and intentPageOf", () => {
  it("shows the view, the sign-in after a 401, or the not-found sentence", () => {
    const ok = { ok: true as const, value: detail({}) };
    expect(decisionPageOf(ok, intact, NOW).kind).toBe("view");
    expect(decisionPageOf({ ok: false, status: 401, message: "x" }, intact, NOW)).toEqual({
      kind: "sign_in",
    });
    expect(decisionPageOf(ok, { ok: false, status: 401, message: "x" }, NOW)).toEqual({
      kind: "sign_in",
    });
    for (const status of [404, 400] as const) {
      expect(decisionPageOf({ ok: false, status, message: "x" }, intact, NOW)).toEqual({
        kind: "not_found",
        view: {
          message: DECISION_COPY.noDecision,
          link: { label: "Back to decisions", href: "/decisions" },
        },
      });
    }
    expect(decisionPageOf({ ok: false, status: 502, message: "Down." }, intact, NOW)).toEqual({
      kind: "error",
      message: "Down.",
    });
  });

  it("redirects an intent to its newest decision, or says there's none", () => {
    expect(intentPageOf({ ok: true, value: { decision_seq: 42 } })).toEqual({
      kind: "redirect",
      href: "/decisions/42",
    });
    expect(intentPageOf({ ok: false, status: 404, message: "x" })).toEqual({
      kind: "not_found",
      view: {
        message: "There's no decision for that intent.",
        link: { label: "Back to decisions", href: "/decisions" },
      },
    });
    expect(intentPageOf({ ok: false, status: 401, message: "x" })).toEqual({ kind: "sign_in" });
    expect(intentPageOf({ ok: false, status: 503, message: "No db." })).toEqual({
      kind: "error",
      message: "No db.",
    });
  });
});
