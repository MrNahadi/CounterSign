// The decide CLI: runs every proposal in a case file through decide() and prints each decision
// with its reasons, verifier trace and intent, or the agent responses with --json. With --record
// it then writes every proposal to the audit log. Returns the output and exit code rather than
// writing them, so tests can call it directly.

import {
  type DatabaseHandle,
  type Environment,
  failureReason,
  hasAuditLogTable,
  openDatabase,
  openFailure,
  resolveDatabaseTarget,
  takePgliteOption,
  targetName,
} from "@countersign/db";
import {
  type Decision,
  describeTarget,
  formatMoney,
  REASONS,
  type TraceEntry,
} from "@countersign/mandate";
import { type DecisionCase, loadCase } from "./case-file";
import { type Decided, decide } from "./decide";
import { recordDecision } from "./record";

export type CliResult = { exitCode: number; stdout: string; stderr: string };

export const USAGE = "Usage: npm run decide -- <case file> [--json]";
export const RECORD_USAGE =
  "Usage: npm run decide -- <case file> --record [--json] [--pglite <dir>]";

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

export function decisionLines({ record }: Decided, index: number, count: number): string[] {
  const { intent } = record;
  const lines = [
    `Proposal ${index + 1} of ${count}`,
    `  Decision  ${DECISION_WORDS[record.decision]}`,
    `  Amount    ${intent ? `${formatMoney(intent.amount)} on ${describeTarget(intent.target)}` : "None, the proposal didn't become an intent"}`,
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

type Prepared = { ok: true; json: boolean; decisionCase: DecisionCase; decided: Decided[] };

// Reads the case file and decides every proposal in it, the same way with or without --record.
function prepare(args: readonly string[], usage: string): Prepared | CliResult {
  const json = args.includes("--json");
  const rest = args.filter((arg) => arg !== "--json");
  const unknown = rest.find((arg) => arg.startsWith("-"));
  if (unknown) return failure(`Unknown option ${unknown}. ${usage}`);
  const [path, ...extra] = rest;
  if (path === undefined || extra.length > 0) return failure(usage);

  const loaded = loadCase(path);
  if (!loaded.ok) return failure(loaded.error);
  const { decisionCase } = loaded;
  const { mandate, principal, records, now, proposals } = decisionCase;
  const decided = proposals.map(({ proposal }) =>
    decide({ mandate, principal, proposal, records, now }),
  );
  return { ok: true, json, decisionCase, decided };
}

function isPrepared(result: Prepared | CliResult): result is Prepared {
  return "ok" in result;
}

function render({ json, decisionCase, decided }: Prepared): string {
  if (json)
    return `${JSON.stringify(
      decided.map(({ response }) => response),
      null,
      2,
    )}\n`;
  const { description, mandate, now } = decisionCase;
  const lines = [
    description,
    `Mandate ${mandate.id} version ${mandate.version}, decided at ${now.toISOString()}`,
  ];
  decided.forEach((result, index) => {
    lines.push("", ...decisionLines(result, index, decided.length));
  });
  return `${lines.join("\n")}\n`;
}

export function runDecideCli(args: readonly string[]): CliResult {
  const prepared = prepare(args, USAGE);
  if (!isPrepared(prepared)) return prepared;
  return { exitCode: EXIT_DECIDED, stdout: render(prepared), stderr: "" };
}

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

type Recorded = { entries: number; head: { seq: number; hash: string } };

// Records each proposal in turn. A mandate version logged with a different hash is found on the
// first proposal, since a case file has one mandate, so nothing from the file is written then.
async function recordAll(
  handle: DatabaseHandle,
  { decisionCase, decided }: Prepared,
): Promise<Recorded | string> {
  const { mandate, principal, proposals } = decisionCase;
  let entries = 0;
  let head = { seq: 0, hash: "" };
  for (const [index, result] of decided.entries()) {
    const recorded = await recordDecision(handle.db, {
      proposal: proposals[index]?.proposal,
      principal,
      mandate,
      decided: result,
    });
    if (!recorded.ok) {
      const earlier =
        entries === 0
          ? "Nothing was recorded."
          : `${plural(entries, "entry", "entries")} recorded first.`;
      return `Couldn't record proposal ${index + 1}: ${recorded.problem} ${recorded.detail}. ${earlier}`;
    }
    entries += recorded.mandateEntry === null ? 1 : 2;
    head = { seq: recorded.decision.seq, hash: recorded.decision.hash };
  }
  return { entries, head };
}

/**
 * The decide CLI as `npm run decide` runs it. Without --record this is runDecideCli. With it,
 * every proposal is also written to the audit log after deciding, in the database the ledger CLI
 * would open (DATABASE_URL, else --pglite <dir>, else .countersign/pglite).
 */
export async function runDecide(args: readonly string[], env: Environment): Promise<CliResult> {
  if (!args.includes("--record")) return runDecideCli(args);
  const option = takePgliteOption(args.filter((arg) => arg !== "--record"));
  if (!option.ok) return failure(`${option.error} ${RECORD_USAGE}`);
  const prepared = prepare(option.rest, RECORD_USAGE);
  if (!isPrepared(prepared)) return prepared;
  const target = resolveDatabaseTarget(env, option.pgliteDir);

  let handle: DatabaseHandle;
  try {
    handle = await openDatabase(target);
  } catch (error) {
    return failure(openFailure(error, target));
  }
  try {
    let present: boolean;
    try {
      present = await hasAuditLogTable(handle.db);
    } catch (error) {
      return failure(openFailure(error, target));
    }
    if (!present) {
      return failure(
        `The database at ${targetName(target)} has no audit_log table. Run npm run db:migrate first.`,
      );
    }
    const recorded = await recordAll(handle, prepared);
    if (typeof recorded === "string") return failure(recorded);
    const summary = `Recorded ${plural(recorded.entries, "entry", "entries")}. Head #${recorded.head.seq} ${recorded.head.hash}.\n`;
    const output = render(prepared);
    return prepared.json
      ? { exitCode: EXIT_DECIDED, stdout: output, stderr: summary }
      : { exitCode: EXIT_DECIDED, stdout: `${output}\n${summary}`, stderr: "" };
  } catch (error) {
    return failure(
      `Couldn't write to the audit log at ${targetName(target)}: ${failureReason(error, target)}`,
    );
  } finally {
    await handle.close().catch(() => {});
  }
}
