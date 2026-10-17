// The decide CLI: runs every proposal in a case file through decide() and prints each decision
// with its reasons, verifier trace and intent, or the agent responses with --json. Returns the
// output and exit code rather than writing them, so tests can call it directly.

import { type Decision, formatMoney, REASONS, type TraceEntry } from "@countersign/mandate";
import { loadCase } from "./case-file";
import { type Decided, decide } from "./decide";

export type CliResult = { exitCode: number; stdout: string; stderr: string };

export const USAGE = "Usage: npm run decide -- <case file> [--json]";

// Exit codes: any decision is a successful run; a case file we can't use is not.
export const EXIT_DECIDED = 0;
export const EXIT_BAD_INPUT = 2;

const DECISION_WORDS: Record<Decision, string> = {
  allow: "Allow",
  step_up: "Step-up",
  deny: "Deny",
};

function failure(error: string): CliResult {
  return { exitCode: EXIT_BAD_INPUT, stdout: "", stderr: `${error.replace(/\s*\n\s*/g, " ")}\n` };
}

function traceLine(entry: TraceEntry, width: number): string {
  const records =
    entry.records.length === 0
      ? "no record read"
      : entry.records.map((record) => `${record.call} ${record.id ?? "(no ID)"}`).join(", ");
  return `    ${entry.verifier.padEnd(width)}  ${entry.result.padEnd(7)}  ${records}`;
}

function readable({ record }: Decided, index: number, count: number): string[] {
  const { intent } = record;
  const lines = [
    `Proposal ${index + 1} of ${count}`,
    `  Decision  ${DECISION_WORDS[record.decision]}`,
    `  Amount    ${intent ? `${formatMoney(intent.amount)} on capture ${intent.target.captureId}` : "None, the proposal didn't become an intent"}`,
    `  Intent    ${record.intentId ?? "None"}`,
    `  Hash      ${record.intentHash ?? "None"}`,
  ];
  if (record.reasons.length === 0) lines.push("  Reasons   None");
  else {
    lines.push("  Reasons");
    for (const reason of record.reasons) {
      lines.push(`    ${REASONS[reason.code].words} (${reason.code})`, `      ${reason.detail}`);
    }
  }
  if (record.trace.length === 0) lines.push("  Verifier trace  None ran");
  else {
    const width = Math.max(...record.trace.map((entry) => entry.verifier.length));
    lines.push("  Verifier trace", ...record.trace.map((entry) => traceLine(entry, width)));
  }
  return lines;
}

export function runDecideCli(args: readonly string[]): CliResult {
  const json = args.includes("--json");
  const rest = args.filter((arg) => arg !== "--json");
  const unknown = rest.find((arg) => arg.startsWith("-"));
  if (unknown) return failure(`Unknown option ${unknown}. ${USAGE}`);
  const [path, ...extra] = rest;
  if (path === undefined || extra.length > 0) return failure(USAGE);

  const loaded = loadCase(path);
  if (!loaded.ok) return failure(loaded.error);
  const { description, mandate, principal, records, now, proposals } = loaded.decisionCase;
  const decided = proposals.map(({ proposal }) =>
    decide({ mandate, principal, proposal, records, now }),
  );

  if (json) {
    const responses = decided.map(({ response }) => response);
    return {
      exitCode: EXIT_DECIDED,
      stdout: `${JSON.stringify(responses, null, 2)}\n`,
      stderr: "",
    };
  }
  const lines = [
    description,
    `Mandate ${mandate.id} version ${mandate.version}, decided at ${now.toISOString()}`,
  ];
  decided.forEach((result, index) => {
    lines.push("", ...readable(result, index, decided.length));
  });
  return { exitCode: EXIT_DECIDED, stdout: `${lines.join("\n")}\n`, stderr: "" };
}
