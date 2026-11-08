import { GRAPHITE_SIZES } from "@countersign/graphite/sizes";
import { themeQuartz } from "ag-grid-community";

// AG Grid Community themed with Graphite, for the Risk desk without an AG Studio licence (brief §5
// cut line). The same tokens as the Studio theme in packages/graphite/src/ag-theme.ts, so the
// grids follow the page's light or dark theme with no switching of their own.
const token = (name: string) => `var(--${name})`;
const line = (name: string) => ({ width: 1, color: token(name) });

export const graphiteGridTheme = themeQuartz.withParams({
  fontFamily: token("font-sans"),
  fontSize: GRAPHITE_SIZES.uiText,
  textColor: token("color-primary-foreground"),
  foregroundColor: token("color-primary-foreground"),
  subtleTextColor: token("color-secondary-foreground"),
  backgroundColor: token("color-container"),
  borderColor: token("color-border-default"),
  accentColor: token("color-brand-solid"),
  iconColor: token("color-secondary-foreground"),
  rowHoverColor: token("color-transparent-hover"),
  browserColorScheme: "inherit",
  headerBackgroundColor: token("color-container"),
  headerTextColor: token("color-secondary-foreground"),
  headerFontWeight: 500,
  headerFontSize: GRAPHITE_SIZES.captionText,
  headerHeight: GRAPHITE_SIZES.tableHeader,
  rowHeight: GRAPHITE_SIZES.tableRow,
  cellHorizontalPadding: GRAPHITE_SIZES.cellPadding,
  rowBorder: line("color-border-subtle"),
  headerRowBorder: line("color-border-default"),
  wrapperBorder: false,
  wrapperBorderRadius: 0,
});
