import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// `Graphite Design/tokens.json` mirrors the light block of `graphite-tokens.css` (ADR 0045,
// DESIGN.md is the authority). A drift in a type style, a space, a control height or a layout
// token fails here.

const dir = join(import.meta.dirname, "..", "..", "..", "Graphite Design");
const css = readFileSync(join(dir, "graphite-tokens.css"), "utf8");
const root = css.slice(css.indexOf(":root"), css.indexOf(".dark,"));
const raw = readFileSync(join(dir, "tokens.json"), "utf8");

type Named = { name: string; value: string };
type Style = { name: string; fontSize: string; lineHeight: string };
type Tokens = {
  type: { groups: { styles: Style[] }[] };
  spacing: { tokens: Named[] };
  size: { tokens: Named[] };
  layout: { tokens: Named[] };
};

const tokens = (): Tokens => JSON.parse(raw) as Tokens;

const cssValue = (name: string): string | undefined =>
  new RegExp(`--${name}:\\s*([^;]+);`).exec(root)?.[1]?.trim();

describe("tokens.json", () => {
  it("parses and keeps its one-space indent", () => {
    expect(() => JSON.parse(raw)).not.toThrow();
    expect(raw.split("\n")[1]).toMatch(/^ "/);
  });

  it("has every type style at the size and line height of the CSS", () => {
    const styles = tokens().type.groups.flatMap((g) => g.styles);
    const checked = styles.filter((s) => !/^(display|pixel)/.test(s.name));
    expect(checked.length).toBeGreaterThan(10);
    for (const s of checked) {
      // caption-upper is set in caption-base's size.
      const key = s.name === "caption-upper" ? "caption-base" : s.name;
      expect(s.fontSize, `${s.name} size`).toBe(cssValue(`text-${key}`));
      const leading = cssValue(`leading-${key}`);
      if (leading) expect(s.lineHeight, `${s.name} line height`).toBe(leading);
    }
  });

  it("has every space token at its CSS value", () => {
    const names = tokens().spacing.tokens.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["space", "space-20", "space-24"]));
    for (const t of tokens().spacing.tokens) {
      expect(t.value, t.name).toBe(cssValue(t.name));
    }
  });

  it("has the five control heights at their CSS values", () => {
    const sizes = tokens().size.tokens;
    expect(sizes.map((t) => t.name)).toEqual([
      "control-xs",
      "control-sm",
      "control-md",
      "control-lg",
      "control-xl",
    ]);
    for (const t of sizes) expect(t.value, t.name).toBe(cssValue(t.name));
  });

  it("has a layout group with the nine layout tokens at their CSS values", () => {
    const layout = tokens().layout.tokens;
    expect(layout.map((t) => t.name).sort()).toEqual(
      [
        "card-padding",
        "content-max",
        "grid-gap",
        "menu-item-height",
        "nav-item-height",
        "section-gap",
        "sidebar-width",
        "table-header-height",
        "table-row-height",
      ].sort(),
    );
    for (const t of layout) expect(t.value, t.name).toBe(cssValue(t.name));
  });

  it("never calls the system dense or sets table headers in uppercase", () => {
    expect(raw).not.toMatch(/dense/i);
    // The old wording listed table headers among the uppercase captions.
    expect(raw).not.toMatch(/and table headers/i);
  });
});
