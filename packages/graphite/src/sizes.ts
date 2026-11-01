// The pixel sizes AG Studio needs as numbers (it measures rows in JavaScript). Each one mirrors a
// Graphite token, and test/sizes.test.ts checks it against graphite-tokens.css (ADR 0045).
export const GRAPHITE_SIZES = {
  uiText: 14, // --text-body-sm
  captionText: 13, // --text-caption-lg
  cardTitle: 16, // --text-body-base
  tableRow: 56, // --table-row-height
  tableHeader: 44, // --table-header-height
  cellPadding: 16, // --space-4
  cardPadding: 24, // --card-padding
  gridGap: 24, // --grid-gap
  cardRadius: 16, // --radius-3xl
} as const;
