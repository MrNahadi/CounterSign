import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { GRAPHITE_SIZES } from "../src/sizes";

// AG Studio measures rows in JavaScript, so its sizes are numbers. Each one must equal the
// Graphite token it names (ADR 0045), so a token change fails here instead of drifting.

const css = readFileSync(join(import.meta.dirname, "..", "graphite-tokens.css"), "utf8");
const root = css.slice(0, css.indexOf(".dark,"));

const TOKENS: Record<keyof typeof GRAPHITE_SIZES, string> = {
  uiText: "--text-body-sm",
  captionText: "--text-caption-lg",
  cardTitle: "--text-body-base",
  tableRow: "--table-row-height",
  tableHeader: "--table-header-height",
  cellPadding: "--space-4",
  cardPadding: "--card-padding",
  gridGap: "--grid-gap",
  cardRadius: "--radius-3xl",
};

describe("GRAPHITE_SIZES", () => {
  it("has a token for every key", () => {
    expect(Object.keys(TOKENS).sort()).toEqual(Object.keys(GRAPHITE_SIZES).sort());
  });

  for (const [key, token] of Object.entries(TOKENS)) {
    it(`${key} equals ${token}`, () => {
      const match = new RegExp(`${token}:\\s*(\\d+)px`).exec(root);
      expect(match, `${token} is in the :root block`).not.toBeNull();
      expect(GRAPHITE_SIZES[key as keyof typeof GRAPHITE_SIZES]).toBe(Number(match?.[1]));
    });
  }
});
