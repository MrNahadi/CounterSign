"use client";

import type { AgWidgetField, AgWidgetParams } from "ag-studio";
import { ShieldCheck } from "lucide-react";
import { useEffect, useState } from "react";
import { RISK_CHART_CURRENCY } from "../../src/risk-view";

// The Risk desk's custom widget: the total of money the gate refused to move, as a Graphite stat
// tile, read through Studio's data API from the audit log's decisions.
export function MoneyProtectedWidget({ dataMapping, widgetApi }: AgWidgetParams) {
  const [total, setTotal] = useState<number | null>(null);
  // Studio passes the mapped fields already resolved, ready to query.
  const fields = (dataMapping as { value?: AgWidgetField[] }).value;

  useEffect(() => {
    if (!fields?.length) {
      widgetApi.setDisplayState("incompleteDataMapping");
      return;
    }
    let cancelled = false;
    widgetApi.setDisplayState("loading");
    widgetApi
      .getData({ fields })
      .then(({ results }) => {
        if (cancelled) return;
        const row = results.rows[0] ?? {};
        const value = Object.values(row).find((cell) => typeof cell === "number");
        setTotal(typeof value === "number" ? value : 0);
        widgetApi.setDisplayState("displayed");
      })
      .catch(() => {
        if (!cancelled) widgetApi.setDisplayState("noData");
      });
    return () => {
      cancelled = true;
    };
  }, [fields, widgetApi]);

  return (
    <div className="flex h-full flex-col justify-between p-1">
      <div className="flex items-center gap-1.5 text-body-sm font-medium text-secondary-foreground">
        <ShieldCheck size={14} strokeWidth={1.5} />
        Money protected
      </div>
      <div className="font-semibold text-heading-4 tabular-nums">
        {total === null
          ? ""
          : total.toLocaleString("en-US", { style: "currency", currency: RISK_CHART_CURRENCY })}
      </div>
      <div className="text-caption-lg text-secondary-foreground">
        Denied money actions, from the audit log
      </div>
    </div>
  );
}
