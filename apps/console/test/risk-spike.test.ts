import { describe, expect, it } from "vitest";
import type { DecisionRow } from "../src/audit-schemas";
import { refundSpike, SPIKE_RULE, type SpikeInput } from "../src/risk-spike";
import { formatMinor, RISK_COPY, type RiskDecisions, riskView } from "../src/risk-view";

// The refund-spike alert (PLAN D2): refunds proposed in the last 24 hours against the daily
// average of the 7 days before, from the audit log's decisions, and how it says "Not checked".

const NOW = new Date("2026-11-08T12:00:00.000Z");
const hoursAgo = (hours: number) => new Date(NOW.getTime() - hours * 3_600_000).toISOString();
const full = { complete: true, unreadableAt: [] };

const refund = (hours: number, over: Partial<SpikeInput> = {}): SpikeInput => ({
  at: hoursAgo(hours),
  actionName: "paypal.refund",
  decision: "deny",
  usdMinor: 1_000,
  ...over,
});
const many = (count: number, hours: number, over: Partial<SpikeInput> = {}) =>
  Array.from({ length: count }, () => refund(hours, over));

describe("refundSpike", () => {
  it("alerts at 5 refunds in 24 hours with a quiet week before", () => {
    const spike = refundSpike(many(5, 2), full, NOW);
    expect(spike).toMatchObject({ status: "spike", recent: 5, baseline: 0, unknownWhy: null });
  });

  it("stays normal below the minimum, however quiet the week", () => {
    expect(refundSpike(many(4, 2), full, NOW).status).toBe("normal");
  });

  it("needs 3 times the week's daily average: 6 against 14 in 7 days is a spike, 5 against 14 isn't", () => {
    const week = many(14, 24 * 3);
    expect(refundSpike([...many(6, 1), ...week], full, NOW)).toMatchObject({
      status: "spike",
      recent: 6,
      baseline: 14,
      baselineDaily: "2.0",
    });
    expect(refundSpike([...many(5, 1), ...week], full, NOW).status).toBe("normal");
  });

  it("counts only refunds, only inside the 8 days, and nothing from the future", () => {
    const rows = [
      ...many(6, 1, { actionName: "paypal.payout" }),
      ...many(6, 1, { actionName: null }),
      refund(24 * 8 + 1),
      refund(-1),
      refund(23),
      refund(25),
    ];
    expect(refundSpike(rows, full, NOW)).toMatchObject({
      recent: 1,
      baseline: 1,
      status: "normal",
    });
  });

  it("puts the 24-hour edge in the baseline and the 8-day edge outside", () => {
    expect(refundSpike([refund(24), refund(24 * 8)], full, NOW)).toMatchObject({
      recent: 0,
      baseline: 1,
    });
  });

  it("adds up what recent refunds asked for, with how many were denied and held", () => {
    const rows = [
      refund(1, { decision: "deny", usdMinor: 2_500 }),
      refund(2, { decision: "step_up", usdMinor: 10_000 }),
      refund(3, { decision: "allow", usdMinor: 1_200 }),
      refund(4, { decision: "deny", usdMinor: null }),
    ];
    expect(refundSpike(rows, full, NOW)).toMatchObject({
      recent: 4,
      recentUsdMinor: 13_700,
      recentDenied: 2,
      recentHeld: 1,
    });
  });

  it("isn't normal when the read stops short of 8 days back", () => {
    const short = { complete: false, unreadableAt: [] };
    const spike = refundSpike([refund(1), refund(30)], short, NOW);
    expect(spike.status).toBe("unknown");
    expect(spike.unknownWhy).toBe("The decisions the desk read don't reach back 8 days.");
    // A short read that does reach back 8 days is enough.
    expect(refundSpike([refund(1), refund(24 * 9)], short, NOW).status).toBe("normal");
  });

  it("isn't normal with an unreadable decision in the 8 days, or a time it can't read", () => {
    const unreadable = refundSpike(
      [refund(1)],
      { complete: true, unreadableAt: [hoursAgo(50)] },
      NOW,
    );
    expect(unreadable).toMatchObject({
      status: "unknown",
      unknownWhy: "A decision in the last 8 days couldn't be read.",
    });
    const older = refundSpike(
      [refund(1)],
      { complete: true, unreadableAt: [hoursAgo(24 * 9)] },
      NOW,
    );
    expect(older.status).toBe("normal");
    const badTime = refundSpike([refund(1), { ...refund(1), at: "yesterday" }], full, NOW);
    expect(badTime).toMatchObject({
      status: "unknown",
      unknownWhy: "A decision has a time the desk can't read.",
    });
  });

  it("still alerts on a spike in what it read, keeping the caveat", () => {
    const spike = refundSpike(many(5, 1), { complete: false, unreadableAt: [] }, NOW);
    expect(spike.status).toBe("spike");
    expect(spike.unknownWhy).not.toBeNull();
  });

  it("states its rule from the constants", () => {
    expect(SPIKE_RULE).toEqual({ windowHours: 24, baselineDays: 7, minRefunds: 5, factor: 3 });
    expect(RISK_COPY.spikeRule).toBe(
      "Alerts at 5 or more in 24 hours and 3 times the daily average. It only alerts: the gate decides every refund.",
    );
  });
});

describe("riskView: the spike card", () => {
  type Readable = Extract<DecisionRow, { readable: true }>;
  const row = (seq: number, hours: number, over: Partial<Readable> = {}): Readable => ({
    readable: true,
    seq,
    at: hoursAgo(hours),
    principal: "support-agent",
    intent_id: null,
    action: "paypal.refund",
    action_words: "Refund",
    amount: { minor: 4_000, currency: "USD", display: formatMinor(4_000, "USD") },
    target: null,
    order_number: null,
    sender: null,
    claim: null,
    claim_words: null,
    decision: "deny",
    reasons: [],
    matched_rules: [],
    status: null,
    ...over,
  });
  const verdict = { ok: false as const, status: 502 as const, message: "x" };
  const all = (rows: DecisionRow[]): RiskDecisions => ({
    rows,
    total: rows.length,
    complete: true,
  });

  it("words a spike in danger, with what was asked for", () => {
    const rows = Array.from({ length: 6 }, (_, i) => row(i + 1, i + 1));
    const { spike } = riskView(all(rows), verdict, NOW);
    expect(spike).toMatchObject({
      status: "spike",
      tone: "danger",
      badge: "Spike",
      heading: "6 refunds proposed in the last 24 hours, against 0.0 a day over the 7 days before.",
      asked: "$240.00 asked for: 6 denied, 0 held for approval.",
    });
  });

  it("words a quiet day as normal, and leaves other currencies out of the amount", () => {
    const { spike } = riskView(
      all([
        row(2, 1, { decision: "allow" }),
        row(1, 2, { amount: { minor: 900, currency: "EUR", display: "€9.00" } }),
      ]),
      verdict,
      NOW,
    );
    expect(spike).toMatchObject({
      status: "normal",
      tone: "positive",
      badge: "Normal",
      heading: "2 refunds proposed in the last 24 hours, against 0.0 a day over the 7 days before.",
      asked: "$40.00 asked for: 1 denied, 0 held for approval.",
    });
  });

  it("says not checked when the desk read only the newest decisions and they're all recent", () => {
    const { spike } = riskView({ rows: [row(1, 1)], total: 5_000, complete: false }, verdict, NOW);
    expect(spike).toMatchObject({ status: "unknown", tone: "neutral", badge: "Not checked" });
  });

  it("counts an unreadable decision in the 8 days against calling it normal", () => {
    const { spike } = riskView(
      all([row(2, 1), { readable: false, seq: 1, at: hoursAgo(3), problem: "It isn't JSON." }]),
      verdict,
      NOW,
    );
    expect(spike.status).toBe("unknown");
  });

  it("keeps the gate's action name on each row and the read time on the view", () => {
    const view = riskView(all([row(1, 1, { action: "paypal.payout" })]), verdict, NOW);
    expect(view.rows[0]?.actionName).toBe("paypal.payout");
    expect(view.asOf).toBe(NOW.toISOString());
  });
});
