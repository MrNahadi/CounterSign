import { studioTheme } from "ag-studio";

// AG Studio themed with Graphite (ADR 0006). Every value reads a Graphite CSS variable, so Studio
// follows the page's light or dark theme with no switching of its own.
const token = (name: string) => `var(--${name})`;
const line = (name: string) => ({ width: 1, color: token(name) });

// Chart series use step 9 of each Radix hue: DESIGN.md allows it for chart lines and dots, since
// no semantic series token exists.
const series = ["blue-9", "green-9", "orange-9", "tomato-9", "gray-9"];
const palette = Object.fromEntries(
  series.flatMap((step, i) => [
    [`chartPaletteFills${i + 1}Color`, token(step)],
    [`chartPaletteStrokes${i + 1}Color`, token(step)],
  ]),
);

export const graphiteStudioTheme = studioTheme.withParams({
  fontFamily: token("font-sans"),
  fontSize: 13,
  textColor: token("color-primary-foreground"),
  foregroundColor: token("color-primary-foreground"),
  subtleTextColor: token("color-secondary-foreground"),
  backgroundColor: token("color-container"),
  borderColor: token("color-border-default"),
  accentColor: token("color-brand-solid"),
  iconColor: token("color-secondary-foreground"),
  rowHoverColor: token("color-transparent-hover"),
  browserColorScheme: "inherit",

  // The canvas is the container itself; widgets are Graphite cards on it.
  studioWrapperBorder: false,
  studioWrapperBorderRadius: 0,
  studioWrapperSpacing: 0,
  studioWrapperBackgroundColor: token("color-container"),
  studioCanvasBorder: false,
  studioCanvasBorderRadius: 0,
  studioCanvasShadow: false,
  studioCanvasBackgroundColor: token("color-container"),
  studioCanvasPadding: 16,
  studioCanvasFontFamily: token("font-sans"),

  studioWidgetBackgroundColor: token("color-container"),
  studioWidgetBorder: line("color-border-default"),
  studioWidgetBorderRadius: 12,
  studioWidgetPadding: 12,
  studioWidgetTitleFontFamily: token("font-sans"),
  studioWidgetTitleFontSize: 13,
  studioWidgetTitleFontWeight: 500,
  studioWidgetTitleTextColor: token("color-primary-foreground"),
  studioWidgetSubtitleFontFamily: token("font-sans"),
  studioWidgetSubtitleFontSize: 13,
  studioWidgetSubtitleTextColor: token("color-secondary-foreground"),
  studioWidgetCaptionFontFamily: token("font-sans"),
  studioWidgetCaptionFontSize: 12,
  studioWidgetCaptionTextColor: token("color-tertiary-foreground"),
  studioWidgetResizeBorderColor: token("color-brand-border-focus"),

  studioPanelContainerBackgroundColor: token("color-container"),
  studioPanelContainerBorder: line("color-border-default"),
  studioPanelDividerColor: token("color-border-default"),
  studioPanelDividerActiveColor: token("color-brand-border-focus"),
  studioPanelSectionBorderColor: token("color-border-subtle"),
  studioPanelHeaderFontFamily: token("font-sans"),
  studioPanelHeaderFontWeight: 500,

  gridFontFamily: token("font-sans"),
  gridFontSize: 13,
  gridCellTextColor: token("color-primary-foreground"),
  gridHeaderBackgroundColor: token("color-container"),
  gridHeaderTextColor: token("color-tertiary-foreground"),
  gridHeaderFontWeight: 500,
  gridHeaderFontSize: 11,
  gridRowHeight: 40,
  gridRowBorder: line("color-border-subtle"),
  gridHeaderRowBorder: line("color-border-default"),
  gridRowHoverColor: token("color-transparent-hover"),
  gridWrapperBorder: false,

  chartFontFamily: token("font-sans"),
  chartTextColor: token("color-primary-foreground"),
  chartSubtleTextColor: token("color-secondary-foreground"),
  chartAxisLineColor: token("color-border-default"),
  chartGridLineColor: token("color-border-subtle"),
  ...palette,
});
