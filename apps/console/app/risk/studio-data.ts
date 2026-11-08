import type { AgReportState } from "ag-studio";
import { RISK_CHART_CURRENCY, RISK_COPY, type RiskView } from "../../src/risk-view";
import type { CountersignRegistry } from "./registry";

// The Risk desk's AG Studio data and starting report, built from the audit log's decisions (see
// src/risk-view.ts). Pure, so a test can check it without a browser.

/** A data source as the desk builds it: rows of plain values and the fields they have. */
export type RiskStudioSource = {
  id: string;
  description: string;
  data: Record<string, string | number | null>[];
  fields: { id: string; name: string; format: "textFormat" | "dateFormat" | "currencyFormat" }[];
};

export type RiskStudioData = { description: string; sources: RiskStudioSource[] };

/** Studio's two data sources: one row per decision, and one per decision and reason code. */
export function riskStudioData(view: RiskView): RiskStudioData {
  return {
    description: `Countersign gate decisions from the audit log. Each row is one money action an AI agent proposed, and the decision the gate made from records. Amounts are ${RISK_CHART_CURRENCY}. ${view.window}`,
    sources: [
      {
        id: "decisions",
        description: "One row per proposed money action and its decision.",
        data: view.rows.map((row) => ({
          seq: `#${row.seq}`,
          day: row.day,
          principal: row.principal,
          action: row.action,
          decision: row.decision,
          reasonCode: row.reasonCode,
          claim: row.claim,
          amount: row.amount,
          protectedAmount: row.protectedAmount,
        })),
        fields: [
          { id: "seq", name: "Entry", format: "textFormat" },
          { id: "day", name: "Decided", format: "dateFormat" },
          { id: "principal", name: "Agent", format: "textFormat" },
          { id: "action", name: "Action", format: "textFormat" },
          { id: "decision", name: "Decision", format: "textFormat" },
          { id: "reasonCode", name: "First reason code", format: "textFormat" },
          { id: "claim", name: "Customer claim", format: "textFormat" },
          { id: "amount", name: "Amount", format: "currencyFormat" },
          { id: "protectedAmount", name: "Money protected", format: "currencyFormat" },
        ],
      },
      {
        id: "reasons",
        description: "One row per decision and each of its reason codes.",
        data: view.reasonPairs.map((pair) => ({
          seq: `#${pair.seq}`,
          decision: pair.decision,
          reasonCode: pair.reasonCode,
        })),
        fields: [
          { id: "seq", name: "Entry", format: "textFormat" },
          { id: "decision", name: "Decision", format: "textFormat" },
          { id: "reasonCode", name: "Reason code", format: "textFormat" },
        ],
      },
    ],
  };
}

/** The desk's four widgets, then the decisions themselves. */
export const riskStudioReport: AgReportState<CountersignRegistry> = {
  selectedPageId: "overview",
  pages: [
    {
      id: "overview",
      widgets: {
        protected: {
          type: "money-protected",
          dataMapping: { value: [{ id: "decisions.protectedAmount", aggregation: "sum" }] },
        },
        chain: { type: "chain-status", dataMapping: { value: [] } },
        spike: { type: "refund-spike", dataMapping: { value: [] } },
        byReason: {
          type: "column-chart-stacked",
          dataMapping: {
            categoryKey: [{ id: "reasons.reasonCode" }],
            valueKey: [{ id: "reasons.seq", aggregation: "countd" }],
            legendKey: [{ id: "reasons.decision" }],
          },
          format: { title: { enabled: true, text: RISK_COPY.reasonsTitle } },
        },
        recent: {
          type: "grid",
          dataMapping: {
            cols: [
              { id: "decisions.seq" },
              { id: "decisions.day" },
              { id: "decisions.principal" },
              { id: "decisions.action" },
              { id: "decisions.decision" },
              { id: "decisions.reasonCode" },
              { id: "decisions.amount", aggregation: "sum" },
            ],
          },
          format: { title: { enabled: true, text: RISK_COPY.decisionsTitle } },
        },
      },
      widgetLayout: {
        protected: { xTrack: 0, yTrack: 0, xSpan: 8, ySpan: 8 },
        chain: { xTrack: 8, yTrack: 0, xSpan: 8, ySpan: 8 },
        spike: { xTrack: 16, yTrack: 0, xSpan: 8, ySpan: 8 },
        byReason: { xTrack: 0, yTrack: 8, xSpan: 24, ySpan: 18 },
        recent: { xTrack: 0, yTrack: 26, xSpan: 24, ySpan: 20 },
      },
    },
  ],
};
