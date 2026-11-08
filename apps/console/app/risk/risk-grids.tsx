"use client";

import { AllCommunityModule, type ColDef } from "ag-grid-community";
import { AgGridReact } from "ag-grid-react";
import { type ReactNode, useSyncExternalStore } from "react";
import { TABLE_CARD } from "../../src/controls";
import { type ReasonRow, RISK_COPY, type RiskRow, type RiskView } from "../../src/risk-view";
import { CardHeading } from "../ui";
import { graphiteGridTheme } from "./grid-theme";

// The Risk desk's grids in AG Grid Community, used when there's no AG Studio licence key (brief §5
// cut line). Rendered in the browser only, like Studio (ADR 0008).

const modules = [AllCommunityModule];
const noSubscription = () => () => {};
const PAGE_SIZE = 20;
// A cell class replaces the column type's own, so numbers keep AG Grid's right alignment here.
const NUMBER_CELL = "ag-right-aligned-cell tabular-nums";
const CODE_CELL = "font-mono text-code-sm";

const count = (field: keyof ReasonRow, headerName: string): ColDef<ReasonRow> => ({
  field,
  headerName,
  type: "numericColumn",
  width: 120,
  cellClass: NUMBER_CELL,
});

const reasonColumns: ColDef<ReasonRow>[] = [
  { field: "code", headerName: "Reason code", flex: 1, minWidth: 220, cellClass: CODE_CELL },
  count("allow", "Allowed"),
  count("step_up", "Step-up"),
  count("deny", "Denied"),
  count("total", "Total"),
];

const decisionColumns: ColDef<RiskRow>[] = [
  {
    field: "seq",
    headerName: "Entry",
    width: 96,
    type: "numericColumn",
    cellClass: NUMBER_CELL,
  },
  {
    field: "at",
    headerName: "When",
    width: 130,
    valueFormatter: ({ data }) => data?.when ?? "",
    tooltipField: "at",
  },
  { field: "principal", headerName: "Agent", width: 150 },
  { field: "action", headerName: "Action", flex: 1, minWidth: 160 },
  { field: "decision", headerName: "Decision", width: 120 },
  {
    field: "reasonCode",
    headerName: "First reason code",
    flex: 1,
    minWidth: 220,
    cellClass: CODE_CELL,
  },
  {
    field: "amountMinor",
    headerName: "Amount",
    width: 130,
    type: "numericColumn",
    cellClass: NUMBER_CELL,
    valueFormatter: ({ data }) => data?.amountDisplay ?? "",
  },
];

function GridCard({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <section data-graphite="table" className={TABLE_CARD} aria-label={title}>
      <div className="px-5 pt-5 pb-4">
        <CardHeading title={title} description={description} />
      </div>
      {children}
    </section>
  );
}

export function RiskGrids({ view }: { view: RiskView }) {
  const inBrowser = useSyncExternalStore(
    noSubscription,
    () => true,
    () => false,
  );
  if (!inBrowser) return null;
  return (
    <>
      <GridCard title={RISK_COPY.reasonsTitle} description={RISK_COPY.reasonsLine}>
        <AgGridReact<ReasonRow>
          modules={modules}
          theme={graphiteGridTheme}
          rowData={view.reasons}
          columnDefs={reasonColumns}
          domLayout="autoHeight"
          suppressCellFocus
          overlayNoRowsTemplate="No decisions yet."
        />
      </GridCard>
      <GridCard title={RISK_COPY.decisionsTitle} description={RISK_COPY.communityNote}>
        <AgGridReact<RiskRow>
          modules={modules}
          theme={graphiteGridTheme}
          rowData={view.rows}
          columnDefs={decisionColumns}
          domLayout="autoHeight"
          pagination={view.rows.length > PAGE_SIZE}
          paginationPageSize={PAGE_SIZE}
          paginationPageSizeSelector={false}
          suppressCellFocus
          overlayNoRowsTemplate="No decisions yet."
        />
      </GridCard>
    </>
  );
}
