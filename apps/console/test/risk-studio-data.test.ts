import { describe, expect, it } from "vitest";
import { riskStudioData, riskStudioReport } from "../app/risk/studio-data";
import type { DecisionRow } from "../src/audit-schemas";
import { riskView } from "../src/risk-view";

// The Risk desk's AG Studio data: built from the audit log's decisions, never sample data, and
// every field the starting report maps is a field the data has.

const NOW = new Date("2026-11-08T12:00:00.000Z");

const decision = (
  seq: number,
  kind: "allow" | "step_up" | "deny",
  minor: number,
  codes: string[],
): DecisionRow => ({
  readable: true,
  seq,
  at: "2026-11-07T10:00:00.000Z",
  principal: "support-agent",
  intent_id: null,
  action: "paypal.refund",
  action_words: "Refund",
  amount: { minor, currency: "USD", display: `$${(minor / 100).toFixed(2)}` },
  target: null,
  order_number: null,
  sender: null,
  claim: null,
  claim_words: null,
  decision: kind,
  reasons: codes.map((code) => ({ code, words: code, detail: code })),
  matched_rules: [],
  status: null,
});

const view = riskView(
  {
    rows: [
      decision(3, "deny", 24_000, ["TICKET_NOT_FROM_PAYER", "SHIPMENT_DELIVERED"]),
      decision(2, "step_up", 12_000, ["ABOVE_AUTO_LIMIT"]),
      decision(1, "allow", 1_800, []),
    ],
    total: 3,
    complete: true,
  },
  { ok: true, value: { intact: true, entry_count: 3, head: null, problems: [] } },
  NOW,
);

describe("riskStudioData", () => {
  it("has one decisions row per decision, in major units, with money protected on denials", () => {
    const data = riskStudioData(view);
    const decisions = data.sources.find((source) => source.id === "decisions");
    expect(decisions?.data).toEqual([
      {
        seq: "#3",
        day: "2026-11-07",
        principal: "support-agent",
        action: "Refund",
        decision: "Denied",
        reasonCode: "TICKET_NOT_FROM_PAYER",
        claim: "None",
        amount: 240,
        protectedAmount: 240,
      },
      expect.objectContaining({ seq: "#2", decision: "Step-up", amount: 120, protectedAmount: 0 }),
      expect.objectContaining({ seq: "#1", decision: "Allowed", amount: 18, protectedAmount: 0 }),
    ]);
    expect(data.description).toContain("Read from all 3 decisions in the audit log.");
    expect(data.description).not.toMatch(/sample|made up/i);
  });

  it("has one reasons row per decision and reason code", () => {
    const reasons = riskStudioData(view).sources.find((source) => source.id === "reasons");
    expect(reasons?.data).toEqual([
      { seq: "#3", decision: "Denied", reasonCode: "TICKET_NOT_FROM_PAYER" },
      { seq: "#3", decision: "Denied", reasonCode: "SHIPMENT_DELIVERED" },
      { seq: "#2", decision: "Step-up", reasonCode: "ABOVE_AUTO_LIMIT" },
      { seq: "#1", decision: "Allowed", reasonCode: "NO_REASON_CODE" },
    ]);
  });

  it("gives every row each field its source declares, and nothing else", () => {
    for (const source of riskStudioData(view).sources) {
      const fields = source.fields.map((field) => field.id).sort();
      for (const row of source.data) {
        expect(Object.keys(row).sort()).toEqual(fields);
      }
    }
  });
});

describe("riskStudioReport", () => {
  it("maps only fields the data has, and lays out every widget", () => {
    const known = new Set(
      riskStudioData(view).sources.flatMap((source) =>
        source.fields.map((field) => `${source.id}.${field.id}`),
      ),
    );
    for (const page of riskStudioReport.pages) {
      const widgets = Object.entries(page.widgets ?? {});
      expect(widgets.map(([id]) => id).sort()).toEqual(Object.keys(page.widgetLayout ?? {}).sort());
      for (const [, widget] of widgets) {
        const mapping = (widget as { dataMapping: Record<string, { id: string }[]> }).dataMapping;
        for (const refs of Object.values(mapping)) {
          for (const ref of refs) expect(known, ref.id).toContain(ref.id);
        }
      }
    }
  });

  it("has the three desk widgets: money protected, decisions by reason code, chain status", () => {
    const types = Object.values(riskStudioReport.pages[0]?.widgets ?? {}).map(
      (widget) => (widget as { type: string }).type,
    );
    expect(types).toEqual(
      expect.arrayContaining(["money-protected", "column-chart-stacked", "chain-status"]),
    );
  });
});
