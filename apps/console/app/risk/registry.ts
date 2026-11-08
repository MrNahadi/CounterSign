import type {
  AgBaseWidgetDefinition,
  AgDefaultRegistry,
  AgDefaultWidgetDefinition,
  AgWidgetData,
  AgWidgetDataFormat,
  AgWidgetFieldReference,
} from "ag-studio";

// Studio's widget registry with the Risk desk's custom widgets added beside the defaults: money
// protected (a total read through Studio's data API) and chain status (the gate's chain check).
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

export interface CountersignRegistry extends Omit<AgDefaultRegistry, "widgets"> {
  widgets: readonly (
    | AgDefaultWidgetDefinition
    | MoneyProtectedDefinition
    | ChainStatusDefinition
  )[];
}
