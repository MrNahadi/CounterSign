import type {
  AgBaseWidgetDefinition,
  AgDefaultRegistry,
  AgDefaultWidgetDefinition,
  AgWidgetData,
  AgWidgetDataFormat,
  AgWidgetFieldReference,
} from "ag-studio";

// Studio's widget registry with the Risk desk's custom widgets added beside the defaults: money
// protected (a total read through Studio's data API), chain status (the gate's chain check) and
// the refund-spike alert (counted by the page from the audit log).
export interface MoneyProtectedWidgetState
  extends AgWidgetData<{ value: AgWidgetFieldReference[] }, AgWidgetDataFormat<unknown>> {
  type: "money-protected";
}

export type MoneyProtectedDefinition = AgBaseWidgetDefinition<
  "money-protected",
  MoneyProtectedWidgetState
>;

export interface ChainStatusWidgetState
  extends AgWidgetData<{ value: AgWidgetFieldReference[] }, AgWidgetDataFormat<unknown>> {
  type: "chain-status";
}

export type ChainStatusDefinition = AgBaseWidgetDefinition<"chain-status", ChainStatusWidgetState>;

export interface RefundSpikeWidgetState
  extends AgWidgetData<{ value: AgWidgetFieldReference[] }, AgWidgetDataFormat<unknown>> {
  type: "refund-spike";
}

export type RefundSpikeDefinition = AgBaseWidgetDefinition<"refund-spike", RefundSpikeWidgetState>;

export interface CountersignRegistry extends Omit<AgDefaultRegistry, "widgets"> {
  widgets: readonly (
    | AgDefaultWidgetDefinition
    | MoneyProtectedDefinition
    | ChainStatusDefinition
    | RefundSpikeDefinition
  )[];
}
