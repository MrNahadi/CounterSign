import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { REASONS } from "@countersign/mandate";
import { describe, expect, it } from "vitest";
import { loadCase } from "../src/case-file";
import { AgentResponseSchema, decide } from "../src/decide";
import { EXIT_BAD_INPUT, EXIT_DECIDED, runDecideCli, USAGE } from "../src/decide-cli";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const casesDir = fileURLToPath(new URL("../fixtures/cases/", import.meta.url));
const beat3 = join(casesDir, "beat-3-attack-email.json");
const entry = fileURLToPath(new URL("../src/decide-main.ts", import.meta.url));

function blocks(stdout: string): string[] {
  return stdout.split(/\n(?=Proposal \d+ of \d+\n)/).slice(1);
}

function tempCase(contents: string): string {
  const path = join(mkdtempSync(join(tmpdir(), "decide-cli-")), "case.json");
  writeFileSync(path, contents);
  return path;
}

describe("the decide CLI's readable output", () => {
  const result = runDecideCli([beat3]);
  const proposalBlocks = blocks(result.stdout);

  it("exits 0 and prints one block per proposal", () => {
    expect(result.exitCode).toBe(EXIT_DECIDED);
    expect(result.stderr).toBe("");
    expect(proposalBlocks).toHaveLength(5);
  });

  it("shows 4 denials for TICKET_NOT_FROM_PAYER and 1 step-up for SHIPMENT_DELIVERED", () => {
    const denied = proposalBlocks.filter(
      (block) =>
        block.includes("  Decision  Deny\n") &&
        block.includes(`    ${REASONS.TICKET_NOT_FROM_PAYER.words} (TICKET_NOT_FROM_PAYER)\n`),
    );
    const held = proposalBlocks.filter(
      (block) =>
        block.includes("  Decision  Step-up\n") &&
        block.includes(`    ${REASONS.SHIPMENT_DELIVERED.words} (SHIPMENT_DELIVERED)\n`),
    );
    expect(denied).toHaveLength(4);
    expect(held).toHaveLength(1);
  });

  it("shows each proposal's amount, intent ID, intent hash, reason details and trace", () => {
    const loaded = loadCase(beat3);
    if (!loaded.ok) throw new Error(loaded.error);
    const { mandate, principal, records, now, proposals } = loaded.decisionCase;
    proposals.forEach(({ proposal }, index) => {
      const { record } = decide({ mandate, principal, proposal, records, now });
      const block = proposalBlocks[index] ?? "";
      expect(block).toContain(`  Intent    ${record.intentId}\n`);
      expect(block).toContain(`  Hash      ${record.intentHash}\n`);
      expect(block).toMatch(/ {2}Amount {4}\$\d+\.\d{2} on capture CAP-\d+\n/);
      for (const reason of record.reasons) expect(block).toContain(`      ${reason.detail}\n`);
      const traceLines = block.split("\n").slice(block.split("\n").indexOf("  Verifier trace") + 1);
      expect(record.trace.length).toBeGreaterThan(0);
      record.trace.forEach((traceEntry, line) => {
        const text = traceLines[line] ?? "";
        expect(text.trim().split(/\s+/).slice(0, 2)).toEqual([
          traceEntry.verifier,
          traceEntry.result,
        ]);
        for (const ref of traceEntry.records) expect(text).toContain(`${ref.call} ${ref.id}`);
      });
    });
  });

  it("says so when a proposal never became an intent", () => {
    const path = tempCase(
      JSON.stringify({
        ...JSON.parse(readFileSync(beat3, "utf8")),
        mandate: join(repoRoot, "packages/mandate/fixtures/kikapu-studio-v3.json"),
        proposals: [
          { proposal: { tool: "create_refund" }, expect: { decision: "deny", reasons: [] } },
        ],
      }),
    );
    const [block = ""] = blocks(runDecideCli([path]).stdout);
    expect(block).toContain("  Amount    None, the proposal didn't become an intent\n");
    expect(block).toContain(`    ${REASONS.INVALID_PROPOSAL.words} (INVALID_PROPOSAL)\n`);
    expect(block).toContain("  Verifier trace  None ran");
  });
});

describe("the decide CLI with --json", () => {
  it("prints agent responses that validate against the agent response schema", () => {
    const result = runDecideCli(["--json", beat3]);
    expect(result.exitCode).toBe(EXIT_DECIDED);
    const responses = AgentResponseSchema.array().parse(JSON.parse(result.stdout));
    expect(responses.map((response) => response.decision)).toEqual([
      "denied",
      "denied",
      "denied",
      "denied",
      "pending_approval",
    ]);
  });
});

describe("the decide CLI on a day whose total can't be counted", () => {
  it("exits 0 with a step-up for DAILY_LIMIT_UNKNOWN", () => {
    const result = runDecideCli([join(casesDir, "usage-overflow.json")]);
    expect(result.exitCode).toBe(EXIT_DECIDED);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain(`${REASONS.DAILY_LIMIT_UNKNOWN.words} (DAILY_LIMIT_UNKNOWN)`);
  });
});

describe("the decide CLI on a case file it can't use", () => {
  it.each([
    [
      "a missing file",
      [join(casesDir, "no-such-case.json")],
      /^Can't read .*no-such-case\.json\n$/,
    ],
    ["a file that isn't JSON", [tempCase("{ not json")], /^.*case\.json isn't valid JSON\n$/],
    [
      "a file that fails the schema",
      [tempCase(JSON.stringify({ description: "x" }))],
      /^Case file\.now: .+\n$/,
    ],
    ["no case file", [], new RegExp(`^${USAGE.replace(/[[\]]/g, "\\$&")}\n$`)],
    ["two case files", [beat3, beat3], /^Usage: .+\n$/],
    ["an unknown option", ["--yaml", beat3], /^Unknown option --yaml\. Usage: .+\n$/],
  ])("exits 2 with a one-line error for %s", (_name, args, error) => {
    const result = runDecideCli(args);
    expect(result.exitCode).toBe(EXIT_BAD_INPUT);
    expect(result.stdout).toBe("");
    expect(result.stderr).toMatch(error);
    expect(result.stderr.trimEnd()).not.toContain("\n");
  });
});

describe("the decide entry point", () => {
  function run(args: string[]) {
    return spawnSync(process.execPath, ["--import", "tsx", entry, ...args], {
      cwd: repoRoot,
      encoding: "utf8",
    });
  }

  it("is what the root decide script runs", () => {
    const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
    expect(pkg.scripts.decide).toBe("tsx apps/gate/src/decide-main.ts");
  });

  it("prints the responses and exits 0 as a child process", () => {
    const child = run(["apps/gate/fixtures/cases/beat-3-attack-email.json", "--json"]);
    expect(child.stderr).toBe("");
    expect(child.status).toBe(0);
    expect(AgentResponseSchema.array().parse(JSON.parse(child.stdout))).toHaveLength(5);
  });

  it("exits 0 with no stack trace as a child process when today's total can't be counted", () => {
    const child = run(["apps/gate/fixtures/cases/usage-overflow.json", "--json"]);
    expect(child.stderr).toBe("");
    expect(child.status).toBe(0);
    const [response] = AgentResponseSchema.array().parse(JSON.parse(child.stdout));
    expect(response?.decision).toBe("pending_approval");
  });

  it("exits 2 as a child process when the case file can't be read", () => {
    const child = run(["apps/gate/fixtures/cases/no-such-case.json"]);
    expect(child.status).toBe(2);
    expect(child.stderr).toMatch(/^Can't read .*no-such-case\.json\n$/);
  });
});
