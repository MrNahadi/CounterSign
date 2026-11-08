"use client";

import { graphiteStudioTheme } from "@countersign/graphite/ag-theme";
import {
  type AgDataSourcesDefinition,
  type AgWidgetParams,
  enableStudioDevValidations,
} from "ag-studio";
import { AgStudio, AgStudioProvider, createWidgets } from "ag-studio-react";
import { useEffect, useMemo, useSyncExternalStore } from "react";
import type { RiskView } from "../../src/risk-view";
import { ChainStatus } from "./chain-status";
import { MoneyProtectedWidget } from "./money-protected-widget";
import type { CountersignRegistry } from "./registry";
import { riskStudioData, riskStudioReport } from "./studio-data";

if (process.env.NODE_ENV !== "production") enableStudioDevValidations();

const noSubscription = () => () => {};

// The chain isn't rows of data, so its widget shows the check the page already ran.
function ChainStatusWidget({ widgetApi, chain }: AgWidgetParams & { chain: RiskView["chain"] }) {
  useEffect(() => {
    widgetApi.setDisplayState("displayed");
  }, [widgetApi]);
  return (
    <div className="h-full p-1">
      <ChainStatus chain={chain} />
    </div>
  );
}

// The Risk desk in AG Studio with the Graphite theme (ADR 0006), from the audit log's decisions.
// Studio only renders in the browser: Node 26 has a server-side localStorage (ADR 0008).
export function RiskStudio({ licenseKey, view }: { licenseKey: string; view: RiskView }) {
  const inBrowser = useSyncExternalStore(
    noSubscription,
    () => true,
    () => false,
  );
  const data = useMemo<AgDataSourcesDefinition<CountersignRegistry>>(
    () => riskStudioData(view),
    [view],
  );
  const chain = view.chain;

  const widgets = useMemo(
    () =>
      createWidgets<CountersignRegistry>({
        additionalTypes: [
          {
            id: "money-protected",
            label: "Money protected",
            dataMapping: {
              value: {
                type: "field",
                supportedRoles: ["numeric"],
                requires: { cardinality: "one" },
                required: true,
              },
            },
            form: (params) =>
              params.createDefaults({ dataMappingItems: [{ key: "value", label: "Value" }] }),
            comp: MoneyProtectedWidget,
            defaultSize: { width: 320, height: 160 },
            minSize: { width: 200, height: 120 },
            ai: { description: "The total money the gate refused to move." },
          },
          {
            id: "chain-status",
            label: "Chain status",
            dataMapping: {
              value: {
                type: "field",
                supportedRoles: ["numeric"],
                requires: { cardinality: "one" },
                required: false,
              },
            },
            form: (params) => params.createDefaults({ dataMappingItems: [] }),
            comp: (params: AgWidgetParams) => <ChainStatusWidget {...params} chain={chain} />,
            defaultSize: { width: 320, height: 160 },
            minSize: { width: 200, height: 120 },
            ai: { description: "Whether the audit log's hash chain is intact." },
          },
        ],
      }),
    [chain],
  );

  if (!inBrowser) return null;
  return (
    <AgStudioProvider licenseKey={licenseKey}>
      <AgStudio<CountersignRegistry>
        style={{ height: "100%", width: "100%" }}
        theme={graphiteStudioTheme}
        data={data}
        initialState={riskStudioReport}
        widgets={widgets}
        mode="edit"
      />
    </AgStudioProvider>
  );
}
