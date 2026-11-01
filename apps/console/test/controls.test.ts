import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import * as controls from "../src/controls";
import { type ButtonSize, type ButtonVariant, button } from "../src/controls";

const VARIANTS: ButtonVariant[] = [
  "primary",
  "secondary",
  "tertiary",
  "transparent",
  "danger-subtle",
];
const SIZES: ButtonSize[] = ["sm", "md", "lg", "xl"];
const ICONS = [undefined, "leading", "only"] as const;

// Every recipe: each exported string, each string value of each exported object, and every button.
function allRecipes(): { name: string; value: string }[] {
  const out: { name: string; value: string }[] = [];
  for (const [name, value] of Object.entries(controls)) {
    if (typeof value === "string") out.push({ name, value });
    else if (value && typeof value === "object") {
      for (const [key, inner] of Object.entries(value)) {
        if (typeof inner === "string") out.push({ name: `${name}.${key}`, value: inner });
      }
    }
  }
  for (const variant of VARIANTS) {
    for (const size of SIZES) {
      for (const icon of ICONS) {
        out.push({
          name: `button(${variant}, ${size}, ${icon ?? "none"})`,
          value: button(variant, size, icon ? { icon } : {}),
        });
      }
    }
  }
  return out;
}

const recipes = allRecipes();

// Splits a class into its variant prefix (`hover:`, `md:`, ...) and its utility, ignoring colons
// inside brackets or parentheses.
function split(cls: string): { prefix: string; utility: string } {
  let depth = 0;
  let cut = -1;
  for (let i = 0; i < cls.length; i++) {
    const ch = cls[i];
    if (ch === "[" || ch === "(") depth++;
    else if (ch === "]" || ch === ")") depth--;
    else if (ch === ":" && depth === 0) cut = i;
  }
  return { prefix: cls.slice(0, cut + 1), utility: cls.slice(cut + 1) };
}

const classes = (value: string) => value.split(/\s+/).filter(Boolean);

const GROUPS: [string, RegExp][] = [
  ["height", /^(?:h|size)-/],
  // Inline padding, by side: `pl-*` and `pr-*` together are one start and one end, not a conflict.
  ["start padding", /^(?:px|pl|p)-/],
  ["end padding", /^(?:px|pr|p)-/],
  ["radius", /^rounded(?:-|$)/],
  ["gap", /^gap-/],
  ["font size", /^text-(?:body|caption|code|heading)-/],
];

function heights(value: string): number[] {
  const base = classes(value)
    .filter((cls) => split(cls).prefix === "")
    .join(" ");
  const found = [...base.matchAll(/(?:^|\s)(?:h|size|min-h)-(\d+(?:\.\d+)?)(?=\s|$)/g)].map(
    (match) => Number(match[1]) * 4,
  );
  if (/(?:^|\s)h-\(--table-header-height\)(?=\s|$)/.test(base)) found.push(44);
  if (/(?:^|\s)h-\(--table-row-height\)(?=\s|$)/.test(base)) found.push(56);
  return found;
}

describe("controls", () => {
  it("covers every exported recipe and all 60 buttons", () => {
    expect(recipes.filter((recipe) => recipe.name.startsWith("button(")).length).toBe(60);
    for (const name of [
      "INPUT",
      "TH",
      "TD",
      "CARD",
      "TOOLBAR",
      "SEGMENT",
      "INPUT_HEIGHT.default",
    ]) {
      expect(recipes.map((recipe) => recipe.name)).toContain(name);
    }
  });

  it("sizes buttons by DESIGN.md's table", () => {
    const heightBySize = { sm: "h-7", md: "h-8", lg: "h-9", xl: "h-11" };
    const padBySize = { sm: "px-2.5", md: "px-3.5", lg: "px-4", xl: "px-5" };
    const squareBySize = { sm: "size-7", md: "size-8", lg: "size-9", xl: "size-11" };
    const leadingBySize = {
      sm: ["pr-2.5", "pl-2"],
      md: ["pr-3.5", "pl-2.5"],
      lg: ["pr-4", "pl-3"],
      xl: ["pr-5", "pl-4"],
    };
    for (const variant of VARIANTS) {
      for (const size of SIZES) {
        const plain = classes(button(variant, size));
        expect(plain).toContain(heightBySize[size]);
        expect(plain).toContain(padBySize[size]);

        const only = classes(button(variant, size, { icon: "only" }));
        expect(only).toContain(squareBySize[size]);
        expect(only.filter((cls) => /^(?:px|pl|pr|h)-/.test(cls))).toEqual([]);

        const leading = classes(button(variant, size, { icon: "leading" }));
        expect(leading).toContain(heightBySize[size]);
        for (const pad of leadingBySize[size]) expect(leading).toContain(pad);
        expect(leading.filter((cls) => cls.startsWith("px-"))).toEqual([]);
      }
    }
    expect(button("primary")).toBe(button("primary", "md"));
    expect(classes(button("primary", "xl", { icon: "only" }))).toContain("rounded-xl");
  });

  it("keeps every recipe with a height at 28px or more", () => {
    const short = recipes
      .map((recipe) => ({ name: recipe.name, heights: heights(recipe.value) }))
      .filter((recipe) => recipe.heights.some((height) => height < 28));
    expect(short).toEqual([]);
    expect(heights(controls.TH)).toEqual([44]);
    expect(heights(controls.TD)).toEqual([56]);
  });

  it("never sets one property group twice under the same prefix", () => {
    const conflicts: string[] = [];
    for (const recipe of recipes) {
      const seen = new Map<string, string>();
      for (const cls of classes(recipe.value)) {
        const { prefix, utility } = split(cls);
        for (const [group, pattern] of GROUPS) {
          if (!pattern.test(utility)) continue;
          const key = `${prefix}${group}`;
          const earlier = seen.get(key);
          if (earlier) conflicts.push(`${recipe.name}: ${earlier} and ${cls}`);
          else seen.set(key, cls);
        }
      }
    }
    expect(conflicts).toEqual([]);
  });

  it("sizes table rows from the table height tokens", () => {
    expect(classes(controls.TH)).toContain("h-(--table-header-height)");
    expect(classes(controls.TD)).toContain("h-(--table-row-height)");
  });

  it("has no uppercase text and no tertiary text except placeholders", () => {
    for (const recipe of recipes) {
      for (const cls of classes(recipe.value)) {
        const { prefix, utility } = split(cls);
        expect(utility, recipe.name).not.toBe("uppercase");
        expect(utility, recipe.name).not.toBe("tracking-caption-upper");
        if (utility === "text-tertiary-foreground")
          expect(prefix, recipe.name).toBe("placeholder:");
      }
    }
  });

  it("has no imports", () => {
    const source = readFileSync(new URL("../src/controls.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/\bimport\b/);
  });
});
