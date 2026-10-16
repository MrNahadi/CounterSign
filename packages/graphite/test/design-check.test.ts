import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";

// The Graphite design check (brief §8, ADR 0006). Every UI styles with semantic tokens only:
// no raw colors, no Tailwind default palette, no palette steps, no emojis.

const repo = join(import.meta.dirname, "..", "..", "..");
const graphite = join(repo, "packages", "graphite");

const uiRoots = ["apps/console", "apps/storefront", "packages/graphite"];
const sourceRoots = ["apps", "packages"];
const extensions = /\.(?:ts|tsx|js|jsx|mjs|cjs|css|html)$/;
const skippedDirs = new Set(["node_modules", ".next", "test"]);

function sourceFiles(root: string): string[] {
  const dir = join(repo, root);
  let entries: string[];
  try {
    entries = readdirSync(dir, { recursive: true, encoding: "utf8" });
  } catch {
    return [];
  }
  return entries
    .filter((path) => extensions.test(path))
    .filter((path) => !path.split(sep).some((part) => skippedDirs.has(part)))
    .filter((path) => !/\.test\.[jt]sx?$/.test(path))
    .filter((path) => !path.endsWith("graphite-tokens.css"))
    .map((path) => join(dir, path));
}

type Rule = { name: string; pattern: RegExp; roots: string[]; exempt?: (file: string) => boolean };

const palette =
  "slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose";
const colorUtilities =
  "bg|text|border|border-[trblxy]|ring|ring-offset|outline|fill|stroke|from|via|to|divide|placeholder|accent|caret|decoration|shadow|inset-shadow|drop-shadow";

const rules: Rule[] = [
  {
    name: "raw hex color",
    pattern: /(?<![\w.&])#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})\b/,
    roots: uiRoots,
  },
  {
    name: "raw color function",
    pattern: /\b(?:rgba?|hsla?|oklch|oklab|lab|lch|hwb)\(/,
    roots: uiRoots,
  },
  {
    name: "Tailwind default palette class",
    pattern: new RegExp(
      `\\b(?:${colorUtilities})-(?:(?:${palette})-(?:50|[1-9]00|950)|white|black)\\b`,
    ),
    roots: uiRoots,
  },
  {
    name: "palette step where a semantic token should be used",
    pattern: /var\(--(?:gray|blue|green|orange|tomato|black|white)-a?\d{1,2}\)/,
    roots: uiRoots,
    // The Graphite package maps chart series to step 9, which DESIGN.md allows.
    exempt: (file) => file.startsWith(graphite),
  },
  {
    name: "emoji",
    pattern: /\p{Emoji_Presentation}|\p{Extended_Pictographic}️/u,
    roots: sourceRoots,
  },
];

describe("Graphite design check", () => {
  for (const rule of rules) {
    it(`finds no ${rule.name}`, () => {
      const hits: string[] = [];
      for (const file of rule.roots.flatMap(sourceFiles)) {
        if (rule.exempt?.(file)) continue;
        readFileSync(file, "utf8")
          .split("\n")
          .forEach((line, i) => {
            if (rule.pattern.test(line)) {
              hits.push(`${relative(repo, file)}:${i + 1}: ${line.trim()}`);
            }
          });
      }
      expect(hits, `Use Graphite semantic tokens instead:\n${hits.join("\n")}`).toEqual([]);
    });
  }

  it("keeps the tokens byte-identical to Graphite Design/graphite-tokens.css", () => {
    const source = readFileSync(join(repo, "Graphite Design", "graphite-tokens.css"));
    const copy = readFileSync(join(graphite, "graphite-tokens.css"));
    expect(
      copy.equals(source),
      "Copy Graphite Design/graphite-tokens.css over the package copy",
    ).toBe(true);
  });

  it("maps every semantic token to a Tailwind utility", () => {
    const tokens = readFileSync(join(graphite, "graphite-tokens.css"), "utf8");
    const light = tokens.slice(tokens.indexOf(":root"), tokens.indexOf(".dark,"));
    const names = new Set(
      [
        ...light.matchAll(
          /(--(?:color|text|font|tracking|leading|radius|shadow|ease)-[a-z0-9-]+)\s*:/g,
        ),
      ].map((match) => match[1]),
    );
    const tailwind = readFileSync(join(graphite, "tailwind.css"), "utf8");
    const missing = [...names].filter((name) => !tailwind.includes(`${name}: var(${name});`));
    expect(missing, "Register these tokens in packages/graphite/tailwind.css").toEqual([]);
  });
});
