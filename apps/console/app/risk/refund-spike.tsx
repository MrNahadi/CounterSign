"use client";

import { Activity, TriangleAlert } from "lucide-react";
import { SUB_LINE } from "../../src/controls";
import { RISK_COPY, type RiskView } from "../../src/risk-view";
import { Badge } from "../ui";

// The refund-spike alert, from the counts the page worked out (src/risk-spike.ts): a badge, the
// last 24 hours against the week before, what those refunds asked for, and the rule. Used as an
// AG Studio widget and as a card in the Community view. It only reports.
export function RefundSpike({ spike }: { spike: RiskView["spike"] }) {
  const Icon = spike.status === "spike" ? TriangleAlert : Activity;
  return (
    <div className="flex h-full min-w-0 flex-col gap-3">
      <div className="flex items-center gap-2">
        <span className="flex items-center gap-1.5 text-body-sm font-medium text-secondary-foreground">
          <Icon size={14} strokeWidth={1.5} aria-hidden="true" />
          {RISK_COPY.spikeTitle}
        </span>
        <Badge tone={spike.tone}>{spike.badge}</Badge>
      </div>
      <p role="status" className="min-w-0 text-body-sm text-primary-foreground">
        {spike.heading}
        <span className={SUB_LINE}>{spike.asked}</span>
      </p>
      {spike.unknownWhy !== null ? (
        <p className="text-caption-lg text-secondary-foreground">{spike.unknownWhy}</p>
      ) : null}
      <p className="text-caption-lg text-secondary-foreground">{spike.rule}</p>
    </div>
  );
}
