"use client";

import { graphiteStudioTheme } from "@countersign/graphite/ag-theme";
import {
  type AgAiHarnessSetup,
  type AgAiPromptStarter,
  AgStudioAiModule,
  createAiHarness,
  enableStudioDevValidations,
} from "ag-studio";
import { AgStudio, AgStudioProvider, createWidgets } from "ag-studio-react";
import { useMemo, useSyncExternalStore } from "react";
import { geminiProxyAdapter } from "./gemini-adapter";
import { MoneyProtectedWidget } from "./money-protected-widget";
import type { CountersignRegistry } from "./registry";
import { riskDeskData, riskDeskReport } from "./sample-data";

if (process.env.NODE_ENV !== "production") enableStudioDevValidations();

const promptStarters: AgAiPromptStarter[] = [
  { label: "Denied by reason", prompt: "Add a chart of denied refunds by reason code." },
  { label: "Agents compared", prompt: "Compare decisions by agent as a table." },
];

const noSubscription = () => () => {};

// Studio only renders in the browser: Node 26 has a server-side localStorage (ADR 0008).
export function RiskDeskSpike({
  licenseKey,
  aiEnabled,
}: {
  licenseKey?: string;
  aiEnabled: boolean;
}) {
  const inBrowser = useSyncExternalStore(
    noSubscription,
    () => true,
    () => false,
  );

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
        ],
      }),
    [],
  );

  const ai = useMemo<AgAiHarnessSetup | undefined>(
    () =>
      aiEnabled
        ? ({ api }) =>
            createAiHarness(api, {
              adapter: geminiProxyAdapter("/api/risk-desk/turn"),
              promptStarters,
            })
        : undefined,
    [aiEnabled],
  );

  if (!inBrowser) return null;
  return (
    <AgStudioProvider licenseKey={licenseKey} modules={ai ? [AgStudioAiModule] : undefined}>
      <AgStudio<CountersignRegistry>
        style={{ height: "100%", width: "100%" }}
        theme={graphiteStudioTheme}
        data={riskDeskData}
        initialState={riskDeskReport}
        widgets={widgets}
        ai={ai}
        mode="edit"
      />
    </AgStudioProvider>
  );
}
