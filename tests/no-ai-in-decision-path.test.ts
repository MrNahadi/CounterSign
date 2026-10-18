import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Brief §8: no AI in the decision path. The packages that decide and record never depend on,
// or import, an AI SDK.

const repo = join(import.meta.dirname, "..");
const decisionPackages = ["mandate", "verifiers", "ledger", "db", "rail-paypal", "carrier-mock"];
const aiModule =
  /^(?:@anthropic-ai\/|@google\/genai|@google\/generative-ai|@google-cloud\/vertexai|openai$|ai$|@ai-sdk\/|langchain|@langchain\/|ollama|cohere-ai|@mistralai\/|groq-sdk)/;
const importSpecifier = /(?:from\s+|import\s*\(\s*|require\s*\(\s*|import\s+)["']([^"']+)["']/g;

describe("no AI in the decision path", () => {
  for (const name of decisionPackages) {
    const dir = join(repo, "packages", name);

    it(`@countersign/${name} declares no AI SDK dependency`, () => {
      const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
      const deps = Object.keys({
        ...manifest.dependencies,
        ...manifest.devDependencies,
        ...manifest.peerDependencies,
        ...manifest.optionalDependencies,
      });
      expect(deps.filter((dep) => aiModule.test(dep))).toEqual([]);
    });

    it(`@countersign/${name} imports no AI SDK`, () => {
      const hits: string[] = [];
      const files = readdirSync(join(dir, "src"), { recursive: true, encoding: "utf8" }).filter(
        (path) => /\.[cm]?[jt]sx?$/.test(path),
      );
      for (const file of files) {
        const text = readFileSync(join(dir, "src", file), "utf8");
        for (const [, specifier] of text.matchAll(importSpecifier)) {
          if (specifier && aiModule.test(specifier)) hits.push(`${file}: ${specifier}`);
        }
      }
      expect(hits).toEqual([]);
    });
  }

  // The modules that decide, record and execute, and the MCP surface and principal keys that
  // reach them, import no AI SDK (phases 6 and 7).
  const gateModules = [
    "app.ts",
    "decide.ts",
    "executable.ts",
    "execution-log.ts",
    "live-records.ts",
    "mcp.ts",
    "principals.ts",
    "proposal.ts",
    "propose-cli.ts",
    "propose-main.ts",
    "propose.ts",
    "reads.ts",
    "reconcile-cli.ts",
    "reconcile-main.ts",
    "record.ts",
    "webhook.ts",
  ];
  it("the gate's decide and execute modules import no AI SDK", () => {
    const hits: string[] = [];
    for (const file of gateModules) {
      const text = readFileSync(join(repo, "apps", "gate", "src", file), "utf8");
      for (const [, specifier] of text.matchAll(importSpecifier)) {
        if (specifier && aiModule.test(specifier)) hits.push(`${file}: ${specifier}`);
      }
    }
    expect(hits).toEqual([]);
  });
});
