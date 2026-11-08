import { describe, expect, it } from "vitest";
import type { DecisionRow } from "../src/audit-schemas";
import {
  formatMinor,
  loadRiskDecisions,
  RISK_COPY,
  RISK_MAX_PAGES,
  RISK_PAGE_SIZE,
  type RiskDecisions,
  riskView,
} from "../src/risk-view";

// The Risk desk's numbers (brief §5 item 11), worked out from the gate's audit API. The gate is
// played by an injected fetch.

const KEY = "approver-key-0123456789abcdefghijklmnop";
const env = { GATE_URL: "http://gate.test:8787" };
const NOW = new Date("2026-11-08T12:00:00.000Z");

type Readable = Extract<DecisionRow, { readable: true }>;

const usd = (minor: number) => ({
  minor,
  currency: "USD",
  display: formatMinor(minor, "USD"),
});

function row(seq: number, over: Partial<Readable> = {}): Readable {
  return {
    readable: true,
    seq,
    at: "2026-11-08T10:00:00.000Z",
    principal: "support-agent",
    intent_id: null,
    action: "paypal.refund",
    action_words: "Refund",
    amount: usd(2_400),
    target: null,
    order_number: null,
    sender: null,
    claim: null,
    claim_words: null,
    decision: "allow",
    reasons: [],
    matched_rules: [],
    status: null,
    ...over,
  };
}

const reason = (code: string) => ({ code, words: code, detail: code });

const unreadable = (seq: number): DecisionRow => ({
  readable: false,
  seq,
  at: "2026-11-08T09:00:00.000Z",
  problem: "It isn't JSON.",
});

const intact = {
  ok: true as const,
  value: { intact: true, entry_count: 12, head: { seq: 12, hash: "ab12" }, problems: [] },
};

const all = (rows: DecisionRow[]): RiskDecisions => ({ rows, total: rows.length, complete: true });

describe("riskView: money protected", () => {
  it("adds up the amounts of denied actions only, and says how many", () => {
    const view = riskView(
      all([
        row(5, {
          decision: "deny",
          amount: usd(24_000),
          reasons: [reason("TICKET_NOT_FROM_PAYER")],
        }),
        row(4, { decision: "deny", amount: usd(9_550), reasons: [reason("APPROVAL_DENIED")] }),
        row(3, { decision: "step_up", amount: usd(50_000), reasons: [reason("ABOVE_AUTO_LIMIT")] }),
        row(2, { decision: "allow", amount: usd(1_800) }),
        row(1, { decision: "deny", amount: null, reasons: [reason("NO_MATCHING_RULE")] }),
      ]),
      intact,
      NOW,
    );
    expect(view.money.value).toBe("$335.50");
    expect(view.money.totals).toEqual([
      { currency: "USD", minor: 33_550, display: "$335.50", count: 2 },
    ]);
    expect(view.money.line).toBe(RISK_COPY.moneyLine(2));
    expect(view.money.line).toContain("2 denied actions");
  });

  it("shows $0.00 when nothing was denied", () => {
    const view = riskView(all([row(1)]), intact, NOW);
    expect(view.money.value).toBe("$0.00");
    expect(view.money.line).toBe("No money action has been denied yet.");
  });

  it("keeps each currency apart, USD first, and leaves the others out of charted amounts", () => {
    const kes = { minor: 150_000, currency: "KES", display: "KES 1,500.00" };
    const view = riskView(
      all([
        row(2, { decision: "deny", amount: kes }),
        row(1, { decision: "deny", amount: usd(1_000) }),
      ]),
      intact,
      NOW,
    );
    expect(view.money.totals.map((line) => [line.currency, line.minor])).toEqual([
      ["USD", 1_000],
      ["KES", 150_000],
    ]);
    expect(view.money.value).toBe(`$10.00 + ${formatMinor(150_000, "KES")}`);
    const kesRow = view.rows.find((each) => each.seq === 2);
    expect(kesRow?.amount).toBeNull();
    expect(kesRow?.protectedAmount).toBe(0);
    expect(kesRow?.amountDisplay).toBe("KES 1,500.00");
    expect(view.rows.find((each) => each.seq === 1)?.protectedAmount).toBe(10);
    expect(view.notes).toEqual([
      "1 decision in a currency other than USD is left out of the charted amounts.",
    ]);
  });
});

describe("riskView: decisions by reason code", () => {
  it("counts each decision under each of its codes, by decision, most common first", () => {
    const view = riskView(
      all([
        row(6, { decision: "deny", reasons: [reason("SHIPMENT_DELIVERED")] }),
        row(5, {
          decision: "deny",
          reasons: [reason("SHIPMENT_DELIVERED"), reason("TICKET_NOT_FROM_PAYER")],
        }),
        row(4, { decision: "step_up", reasons: [reason("ABOVE_AUTO_LIMIT")] }),
        row(3, { decision: "deny", reasons: [reason("ABOVE_AUTO_LIMIT")] }),
        row(2, { decision: "allow" }),
        // A code given twice counts once.
        row(1, {
          decision: "deny",
          reasons: [reason("NO_MATCHING_RULE"), reason("NO_MATCHING_RULE")],
        }),
      ]),
      intact,
      NOW,
    );
    expect(view.reasons).toEqual([
      { code: "ABOVE_AUTO_LIMIT", allow: 0, step_up: 1, deny: 1, total: 2 },
      { code: "SHIPMENT_DELIVERED", allow: 0, step_up: 0, deny: 2, total: 2 },
      { code: "NO_MATCHING_RULE", allow: 0, step_up: 0, deny: 1, total: 1 },
      { code: RISK_COPY.noReason, allow: 1, step_up: 0, deny: 0, total: 1 },
      { code: "TICKET_NOT_FROM_PAYER", allow: 0, step_up: 0, deny: 1, total: 1 },
    ]);
    expect(view.reasonPairs.filter((pair) => pair.seq === 5)).toEqual([
      { seq: 5, decision: "Denied", reasonCode: "SHIPMENT_DELIVERED" },
      { seq: 5, decision: "Denied", reasonCode: "TICKET_NOT_FROM_PAYER" },
    ]);
    expect(view.reasonPairs.filter((pair) => pair.seq === 1)).toHaveLength(1);
  });
});

describe("riskView: rows, notes and window", () => {
  it("flattens readable decisions and leaves unreadable ones out, with a note", () => {
    const view = riskView(
      all([
        row(2, {
          decision: "deny",
          amount: usd(24_000),
          claim_words: "Not received",
          reasons: [reason("TICKET_NOT_FROM_PAYER")],
        }),
        unreadable(1),
      ]),
      intact,
      NOW,
    );
    expect(view.rows).toEqual([
      {
        seq: 2,
        at: "2026-11-08T10:00:00.000Z",
        when: "2h ago",
        day: "2026-11-08",
        principal: "support-agent",
        action: "Refund",
        actionName: "paypal.refund",
        decision: "Denied",
        reasonCode: "TICKET_NOT_FROM_PAYER",
        claim: "Not received",
        amountDisplay: "$240.00",
        amountMinor: 24_000,
        amount: 240,
        protectedAmount: 240,
      },
    ]);
    expect(view.notes).toEqual(["1 decision couldn't be read and isn't counted."]);
    expect(view.window).toBe("Read from all 2 decisions in the audit log.");
  });

  it("says when it read only the newest decisions", () => {
    const view = riskView({ rows: [row(2), row(1)], total: 1_234, complete: false }, intact, NOW);
    expect(view.window).toBe("Read from the newest 2 decisions of 1,234 in the audit log.");
  });
});

describe("riskView: chain status", () => {
  it("is intact only on the gate's intact verdict", () => {
    const view = riskView(all([]), intact, NOW);
    expect(view.chain.tone).toBe("positive");
    expect(view.chain.badge).toBe("Intact");
    expect(view.chain.heading).toBe("Chain intact: 12 entries. Head #12 ab12.");
  });

  it("is broken with each problem when the gate finds one", () => {
    const view = riskView(
      all([]),
      {
        ok: true,
        value: {
          intact: false,
          entry_count: 12,
          head: null,
          problems: [{ seq: 7, code: "HASH_MISMATCH", detail: "The hash doesn't match." }],
        },
      },
      NOW,
    );
    expect(view.chain.badge).toBe("Broken");
    expect(view.chain.tone).toBe("danger");
    expect(view.chain.problems).toEqual([
      { seq: 7, code: "HASH_MISMATCH", detail: "The hash doesn't match." },
    ]);
  });

  it("is not checked, never intact, when the check can't be read", () => {
    const view = riskView(all([]), { ok: false, status: 502, message: "The gate is down." }, NOW);
    expect(view.chain.badge).toBe("Not checked");
    expect(view.chain.tone).toBe("neutral");
    expect(view.chain.heading).toBe("The gate is down.");
  });
});

// --- Loading ---------------------------------------------------------------------------------

type Page = { rows: DecisionRow[]; next_before: number | null };

// A gate that answers `/audit/decisions` from `pages`, keyed by the `before` cursor ("" first).
function gate(pages: Record<string, Page | number>, total: number) {
  const calls: URL[] = [];
  const fetchFake = (async (url: URL | string) => {
    const at = new URL(String(url));
    calls.push(at);
    const page = pages[at.searchParams.get("before") ?? ""];
    if (page === undefined) return Response.json({ message: "Not here." }, { status: 404 });
    if (typeof page === "number") return Response.json({ message: "No." }, { status: page });
    return Response.json({
      ...page,
      counts: { all: total, allowed: total, stepped_up: 0, denied: 0 },
    });
  }) as typeof fetch;
  return { calls, deps: { env, fetch: fetchFake } };
}

const rowsFrom = (top: number, count: number) =>
  Array.from({ length: count }, (_, i) => row(top - i));

describe("loadRiskDecisions", () => {
  it("reads page after page until the oldest decision", async () => {
    const { calls, deps } = gate(
      {
        "": { rows: rowsFrom(5, 2), next_before: 4 },
        "4": { rows: rowsFrom(3, 2), next_before: 2 },
        "2": { rows: [row(1)], next_before: null },
      },
      5,
    );
    const answer = await loadRiskDecisions(KEY, deps);
    expect(answer).toMatchObject({ ok: true, value: { total: 5, complete: true } });
    expect(answer.ok && answer.value.rows.map((each) => each.seq)).toEqual([5, 4, 3, 2, 1]);
    expect(calls.map((url) => url.searchParams.get("limit"))).toEqual(
      Array(3).fill(String(RISK_PAGE_SIZE)),
    );
    expect(calls.map((url) => url.searchParams.get("before"))).toEqual([null, "4", "2"]);
  });

  it(`stops after ${RISK_MAX_PAGES} pages and says it's incomplete`, async () => {
    const pages: Record<string, Page> = {};
    let before = "";
    for (let page = 0; page < RISK_MAX_PAGES + 2; page++) {
      const top = 100 - page * 10;
      pages[before] = { rows: rowsFrom(top, 10), next_before: top - 9 };
      before = String(top - 9);
    }
    const { calls, deps } = gate(pages, 100);
    const answer = await loadRiskDecisions(KEY, deps);
    expect(calls).toHaveLength(RISK_MAX_PAGES);
    expect(answer).toMatchObject({ ok: true, value: { total: 100, complete: false } });
    expect(answer.ok && answer.value.rows).toHaveLength(RISK_MAX_PAGES * 10);
  });

  it("stops, incomplete, when the cursor doesn't move on, and never counts a row twice", async () => {
    const { calls, deps } = gate(
      {
        "": { rows: rowsFrom(5, 2), next_before: 4 },
        "4": { rows: rowsFrom(5, 2), next_before: 4 },
      },
      5,
    );
    const answer = await loadRiskDecisions(KEY, deps);
    expect(calls).toHaveLength(2);
    expect(answer).toMatchObject({ ok: true, value: { complete: false } });
    expect(answer.ok && answer.value.rows.map((each) => each.seq)).toEqual([5, 4]);
  });

  it("refuses the whole read when any page is refused", async () => {
    const { deps } = gate({ "": { rows: rowsFrom(5, 2), next_before: 4 }, "4": 502 }, 5);
    const answer = await loadRiskDecisions(KEY, deps);
    expect(answer.ok).toBe(false);
  });

  it("refuses a signed-out key as the gate does", async () => {
    const { deps } = gate({ "": 401 }, 0);
    const answer = await loadRiskDecisions(KEY, deps);
    expect(answer).toMatchObject({ ok: false, status: 401 });
  });
});
