import type {
  AgBaseWidgetDefinition,
  AgDefaultRegistry,
  AgDefaultWidgetDefinition,
  AgWidgetData,
  AgWidgetDataFormat,
  AgWidgetFieldReference,
} from "ag-studio";

// Studio's widget registry with Countersign's custom widget added beside the defaults.
export interface MoneyProtectedWidgetState
  extends AgWidgetData<{ value: AgWidgetFieldReference[] }, AgWidgetDataFormat<unknown>> {
  type: "money-protected";
}

export type MoneyProtectedDefinition = AgBaseWidgetDefinition<
  "money-protected",
  MoneyProtectedWidgetState
>;

export interface CountersignRegistry extends Omit<AgDefaultRegistry, "widgets"> {
  widgets: readonly (AgDefaultWidgetDefinition | MoneyProtectedDefinition)[];
}
