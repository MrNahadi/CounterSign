"use client";

import { Link2, Link2Off } from "lucide-react";
import { MONO } from "../../src/controls";
import { RISK_COPY, type RiskView } from "../../src/risk-view";
import { Badge } from "../ui";

// The chain's status, from the check the gate ran when the page loaded: a badge, the gate's
// sentence and each problem. Used as an AG Studio widget and as a card in the Community view.
export function ChainStatus({ chain }: { chain: RiskView["chain"] }) {
  const Icon = chain.tone === "danger" ? Link2Off : Link2;
  return (
    <div className="flex h-full min-w-0 flex-col gap-3">
      <div className="flex items-center gap-2">
        <span className="flex items-center gap-1.5 text-body-sm font-medium text-secondary-foreground">
          <Icon size={14} strokeWidth={1.5} aria-hidden="true" />
          {RISK_COPY.chainTitle}
        </span>
        <Badge tone={chain.tone}>{chain.badge}</Badge>
      </div>
      <p role="status" className="min-w-0 text-body-sm break-all text-primary-foreground">
        {chain.heading}
      </p>
      {chain.problems.length > 0 ? (
        <ul className="flex flex-col gap-1 text-body-sm text-secondary-foreground">
          {chain.problems.map((problem) => (
            <li key={`${problem.seq}-${problem.code}`}>
              <span className={MONO}>{`#${problem.seq}`}</span>{" "}
              <span className={MONO}>{problem.code}</span> {problem.detail}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
