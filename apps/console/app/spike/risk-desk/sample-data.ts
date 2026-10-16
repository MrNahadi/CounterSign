import type { AgDataSourcesDefinition, AgReportState } from "ag-studio";
import type { CountersignRegistry } from "./registry";

// Spike S9 sample data: 48 made-up gate decisions for the Risk desk to chart. Labeled as sample
// data on the page. Phase 16 replaces it with the audit log.

const reasons = [
  { decision: "deny", reason: "SHIPMENT_DELIVERED", claim: "not_received" },
  { decision: "deny", reason: "TICKET_NOT_FROM_PAYER", claim: "not_received" },
  { decision: "deny", reason: "NO_MATCHING_RULE", claim: "other" },
  { decision: "step_up", reason: "OVER_AUTO_CAP", claim: "damaged" },
  { decision: "allow", reason: "LOST_IN_TRANSIT", claim: "not_received" },
  { decision: "allow", reason: "DAMAGED_UNDER_CAP", claim: "damaged" },
] as const;

const decisions = Array.from({ length: 48 }, (_, i) => {
  const r = reasons[(i * 7) % reasons.length] ?? reasons[0];
  const day = 1 + ((i * 5) % 15);
  const amount = [12, 18, 24, 36, 48, 60, 72, 96][(i * 3) % 8] ?? 24;
  return {
    id: `dec-${String(i + 1).padStart(3, "0")}`,
    decidedAt: `2026-10-${String(day).padStart(2, "0")}`,
    principal: i % 5 === 0 ? "ops-agent" : "support-agent",
    action: i % 5 === 0 ? "payout" : "refund",
    decision: r.decision,
    reasonCode: r.reason,
    claim: r.claim,
    amount,
    protectedAmount: r.decision === "deny" ? amount : 0,
  };
});

export const riskDeskData: AgDataSourcesDefinition<CountersignRegistry> = {
  description:
    "Sample Countersign gate decisions (made up, for spike S9). Each row is one money action an AI agent proposed, and the decision the gate made from records. Amounts are USD.",
  sources: [
    {
      id: "decisions",
      description: "One row per proposed money action and its decision.",
      data: decisions,
      fields: [
        { id: "id", name: "Decision ID", format: "textFormat" },
        { id: "decidedAt", name: "Decided", format: "dateFormat" },
        { id: "principal", name: "Agent", format: "textFormat" },
        { id: "action", name: "Action", format: "textFormat" },
        { id: "decision", name: "Decision", format: "textFormat" },
        { id: "reasonCode", name: "Reason code", format: "textFormat" },
        { id: "claim", name: "Customer claim", format: "textFormat" },
        { id: "amount", name: "Amount", format: "currencyFormat" },
        { id: "protectedAmount", name: "Money protected", format: "currencyFormat" },
      ],
    },
  ],
};

export const riskDeskReport: AgReportState<CountersignRegistry> = {
  selectedPageId: "overview",
  pages: [
    {
      id: "overview",
      widgets: {
        protected: {
          type: "money-protected",
          dataMapping: { value: [{ id: "decisions.protectedAmount", aggregation: "sum" }] },
        },
        count: {
          type: "value",
          dataMapping: { value: [{ id: "decisions.id", aggregation: "countd" }] },
          format: { title: { enabled: true, text: "Decisions" } },
        },
        byReason: {
          type: "column-chart-stacked",
          dataMapping: {
            categoryKey: [{ id: "decisions.reasonCode" }],
            valueKey: [{ id: "decisions.amount", aggregation: "sum" }],
            legendKey: [{ id: "decisions.decision" }],
          },
          format: { title: { enabled: true, text: "Amount by reason code" } },
        },
        recent: {
          type: "grid",
          dataMapping: {
            cols: [
              { id: "decisions.decidedAt" },
              { id: "decisions.principal" },
              { id: "decisions.action" },
              { id: "decisions.decision" },
              { id: "decisions.reasonCode" },
              { id: "decisions.amount", aggregation: "sum" },
            ],
          },
          format: { title: { enabled: true, text: "Decisions" } },
        },
      },
      widgetLayout: {
        protected: { xTrack: 0, yTrack: 0, xSpan: 8, ySpan: 8 },
        count: { xTrack: 8, yTrack: 0, xSpan: 8, ySpan: 8 },
        byReason: { xTrack: 0, yTrack: 8, xSpan: 24, ySpan: 18 },
        recent: { xTrack: 0, yTrack: 26, xSpan: 24, ySpan: 20 },
      },
    },
  ],
};
