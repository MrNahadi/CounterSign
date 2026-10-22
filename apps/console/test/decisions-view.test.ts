import { describe, expect, it } from "vitest";
import {
  type ChainVerdict,
  ChainVerdictSchema,
  type DecisionRowsPage,
  DecisionRowsPageSchema,
} from "../src/audit-schemas";
import {
  chainView,
  DECISIONS_COPY,
  decisionFiltersOf,
  decisionsView,
  rowStatusWords,
} from "../src/decisions-view";

// The Decisions page's view model, fed the gate's audit answers as the console's loaders pass
// them on (parsed with the console's own schemas first, so a fixture can't drift from them).

const NOW = new Date("2026-10-20T08:04:00.000Z");
const INTENT = `int_${"b".repeat(24)}`;
const amount = { minor: 24000, currency: "USD", display: "$240.00" };
const target = { kind: "capture", id: "CAP-1037", order_id: "ORD-1037" };

const executed = (refund: string | null, invoice: string | null = null) => ({
  outcome: "executed",
  refund: refund === null ? null : { id: refund, status: "COMPLETED" },
  invoice: invoice === null ? null : { id: invoice, status: "SENT" },
});

const row = (extra: Record<string, unknown>) => ({
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
  status: { kind: "executed", execution: executed("4XJ12345") },
  ...extra,
});

const parsePage = (value: unknown): DecisionRowsPage => DecisionRowsPageSchema.parse(value);
const parseVerdict = (value: unknown): ChainVerdict => ChainVerdictSchema.parse(value);

const page = parsePage({
  rows: [
    row({}),
    row({
      seq: 11,
      at: "2026-10-20T07:00:00.000Z",
      order_number: "KIK-1039",
      sender: "buyer-a@example.com",
      claim: "not_received",
      claim_words: "Says the parcel never arrived",
      amount: { minor: 9600, currency: "USD", display: "$96.00" },
      target: { kind: "capture", id: "CAP-1039", order_id: "ORD-1039" },
      decision: "deny",
      reasons: [
        {
          code: "TICKET_NOT_FROM_PAYER",
          words: "The message isn't from the person who paid.",
          detail: "buyer-a@example.com is not the payer.",
        },
      ],
      matched_rules: ["refund-lost-parcel"],
      status: null,
    }),
    row({
      seq: 10,
      order_number: "KIK-1042",
      decision: "step_up",
      reasons: [
        { code: "SHIPMENT_DELIVERED", words: "The carrier says it was delivered.", detail: "" },
      ],
      matched_rules: [],
      status: { kind: "open", execution: null },
    }),
    { readable: false, seq: 9, at: "2026-10-20T06:00:00.000Z", problem: "It isn't JSON." },
    row({
      seq: 8,
      intent_id: null,
      action: null,
      action_words: null,
      amount: null,
      target: null,
      order_number: null,
      sender: null,
      claim: null,
      claim_words: null,
      decision: "deny",
      reasons: [
        { code: "MALFORMED_PROPOSAL", words: "The proposal couldn't be read.", detail: "" },
      ],
      matched_rules: [],
      status: null,
    }),
  ],
  counts: { all: 5, allowed: 1, stepped_up: 1, denied: 2 },
  next_before: 8,
});

describe("decisionsView", () => {
  const view = decisionsView(page, {}, NOW);

  it("shows an allowed, executed refund with its badge, rule, status and record", () => {
    expect(view.rows[0]).toEqual({
      readable: true,
      seq: 12,
      href: "/decisions/12",
      when: "3m ago",
      at: "2026-10-20T08:01:00.000Z",
      sender: "payer@example.com",
      claim: "Says the item arrived damaged",
      action: "Refund",
      amount: "$240.00",
      decision: { label: "Allowed", tone: "positive" },
      why: { words: "Allowed by rule refund-damaged", code: null },
      status: { words: "Refunded", href: null },
      record: "4XJ12345",
    });
  });

  it("shows a denial's first reason as words with its code, and no status", () => {
    const denied = view.rows[1];
    expect(denied).toMatchObject({
      href: "/decisions/11",
      when: "1h ago",
      sender: "buyer-a@example.com",
      claim: "Says the parcel never arrived",
      amount: "$96.00",
      decision: { label: "Denied", tone: "danger" },
      why: { words: "The message isn't from the person who paid.", code: "TICKET_NOT_FROM_PAYER" },
      status: null,
      record: "CAP-1039",
    });
  });

  it("shows an open step-up as waiting, linking to the approvals page", () => {
    expect(view.rows[2]).toMatchObject({
      decision: { label: "Step-up", tone: "warning" },
      why: { words: "The carrier says it was delivered.", code: "SHIPMENT_DELIVERED" },
      status: { words: "Waiting for you", href: "/approvals" },
      record: "CAP-1037",
    });
  });

  it("says an unreadable row can't be read, with its problem, and still links to it", () => {
    expect(view.rows[3]).toEqual({
      readable: false,
      seq: 9,
      href: "/decisions/9",
      when: "2h ago",
      at: "2026-10-20T06:00:00.000Z",
      why: { words: "This entry can't be read.", code: null },
      problem: "It isn't JSON.",
    });
  });

  it("shows a proposal that never became an intent without inventing an action", () => {
    expect(view.rows[4]).toMatchObject({
      sender: null,
      claim: null,
      action: DECISIONS_COPY.unreadProposal,
      amount: null,
      record: null,
      why: { words: "The proposal couldn't be read.", code: "MALFORMED_PROPOSAL" },
    });
  });

  it("counts each segment, marks the current one and keeps the search in its link", () => {
    const searched = decisionsView(page, { decision: "deny", q: "KIK 10" }, NOW);
    expect(searched.segments).toEqual([
      { label: "All", count: 5, href: "/decisions?q=KIK+10", current: false },
      { label: "Allowed", count: 1, href: "/decisions?decision=allow&q=KIK+10", current: false },
      { label: "Step-up", count: 1, href: "/decisions?decision=step_up&q=KIK+10", current: false },
      { label: "Denied", count: 2, href: "/decisions?decision=deny&q=KIK+10", current: true },
    ]);
    expect(searched.search).toEqual({ q: "KIK 10", decision: "deny" });
    expect(view.segments[0]).toMatchObject({ href: "/decisions", current: true });
  });

  it("pages back with the filters kept", () => {
    expect(decisionsView(page, { decision: "deny", q: "a" }, NOW).olderHref).toBe(
      "/decisions?decision=deny&q=a&before=8",
    );
    expect(decisionsView({ ...page, next_before: null }, {}, NOW).olderHref).toBeNull();
    expect(DECISIONS_COPY.older).toBe("Older decisions");
  });

  it("says the log is empty only when there are no decisions at all", () => {
    const none = parsePage({
      rows: [],
      counts: { all: 0, allowed: 0, stepped_up: 0, denied: 0 },
      next_before: null,
    });
    expect(decisionsView(none, {}, NOW).empty).toBe(
      "No decisions yet. They appear here when an agent proposes a money action.",
    );
    expect(decisionsView(none, { q: "nope" }, NOW).empty).toBe(DECISIONS_COPY.noMatch);
    expect(decisionsView({ ...none, counts: { ...none.counts, all: 3 } }, {}, NOW).empty).toBe(
      DECISIONS_COPY.noMatch,
    );
    expect(view.empty).toBeNull();
  });

  it("carries the page's title and subtitle", () => {
    expect(DECISIONS_COPY.title).toBe("Decisions");
    expect(DECISIONS_COPY.subtitle).toBe(
      "Every money action your agents proposed, and what the records said.",
    );
    expect(DECISIONS_COPY.searchPlaceholder).toBe("Order, sender or ID");
  });
});

describe("rowStatusWords", () => {
  const words = (status: unknown, action = "paypal.refund") => {
    const parsed = parsePage({
      rows: [row({ status, action })],
      counts: { all: 1, allowed: 1, stepped_up: 0, denied: 0 },
      next_before: null,
    }).rows[0];
    if (parsed === undefined || !parsed.readable) throw new Error("fixture");
    return rowStatusWords(parsed);
  };

  it("words every status the gate can give", () => {
    expect(words({ kind: "executed", execution: executed("4XJ1") })).toEqual({
      words: "Refunded",
      href: null,
    });
    expect(
      words({ kind: "executed", execution: executed(null, "INV2-1") }, "paypal.invoice.send"),
    ).toEqual({ words: "Invoice sent", href: null });
    const failed = { outcome: "failed", refund: null, invoice: null };
    expect(words({ kind: "failed", execution: failed })?.words).toBe("PayPal refused it");
    const unknown = { outcome: "unknown", refund: null, invoice: null };
    expect(words({ kind: "unknown", execution: unknown })?.words).toBe("Not confirmed yet");
    const pending = { outcome: "pending", refund: null, invoice: null };
    expect(words({ kind: "pending", execution: pending })?.words).toBe("Not confirmed yet");
    expect(words({ kind: "unknown", execution: null })?.words).toBe("Not confirmed yet");
    expect(words({ kind: "not_executable", execution: null })?.words).toBe("Can't run yet");
    expect(words({ kind: "open", execution: null })).toEqual({
      words: "Waiting for you",
      href: "/approvals",
    });
    expect(words({ kind: "approved", execution: executed("4XJ1") })?.words).toBe(
      "Approved, refunded",
    );
    expect(words({ kind: "approved", execution: failed })?.words).toBe(
      "Approved, PayPal refused it",
    );
    expect(words({ kind: "approved", execution: pending })?.words).toBe(
      "Approved, not confirmed yet",
    );
    expect(words({ kind: "denied", execution: null })?.words).toBe("Denied by you");
    expect(words({ kind: "expired", execution: null })?.words).toBe("Expired, so denied");
    expect(words(null)).toBeNull();
  });
});

describe("chainView", () => {
  it("shows an intact chain with its entries and the time it was checked", () => {
    const verdict = parseVerdict({
      intact: true,
      entry_count: 42,
      head: { seq: 42, hash: "a".repeat(64) },
      problems: [],
    });
    expect(chainView({ ok: true, value: verdict }, NOW)).toEqual({
      label: "Chain intact",
      tone: "positive",
      line: "42 entries, checked at 08:04 UTC.",
      link: null,
    });
    const one = parseVerdict({ ...verdict, entry_count: 1 });
    expect(chainView({ ok: true, value: one }, NOW).line).toBe("1 entry, checked at 08:04 UTC.");
  });

  it("shows a broken chain with its problem count and a link to the audit log", () => {
    const verdict = parseVerdict({
      intact: false,
      entry_count: 42,
      head: { seq: 42, hash: "a".repeat(64) },
      problems: [
        { seq: 7, code: "HASH_MISMATCH", detail: "Entry 7's hash doesn't match." },
        { seq: 8, code: "PREV_HASH_MISMATCH", detail: "Entry 8 doesn't point at 7." },
      ],
    });
    expect(chainView({ ok: true, value: verdict }, NOW)).toEqual({
      label: "Chain broken",
      tone: "danger",
      line: "2 problems.",
      link: { href: "/audit", label: "Open the audit log" },
    });
  });

  it("never assumes a verdict it couldn't get", () => {
    expect(
      chainView({ ok: false, status: 502, message: "The gate isn't reachable." }, NOW),
    ).toEqual({
      label: "Chain not checked",
      tone: "neutral",
      line: "The gate isn't reachable.",
      link: { href: "/audit", label: "Open the audit log" },
    });
  });
});

describe("decisionFiltersOf", () => {
  it("passes on only the page's own string parameters", () => {
    expect(decisionFiltersOf({ decision: "deny", q: "KIK", before: "8", thread: "x" })).toEqual({
      decision: "deny",
      q: "KIK",
      before: "8",
    });
    expect(decisionFiltersOf({ decision: ["deny", "allow"], q: "" })).toEqual({});
  });

  it("drops an unknown decision kind rather than showing every decision under its name", () => {
    expect(decisionFiltersOf({ decision: "maybe" })).toEqual({});
  });
});
