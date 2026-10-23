// The audit CLI: shows one decision's claims vs records and trail, and writes the evidence file
// for an intent or a capture (ADR 0034). Read-only: nothing here appends to the audit log. No AI.
// Returns the output and exit code rather than writing them.

import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  type Database,
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
import type { Mandate } from "@countersign/mandate";
import { CaptureIdText, IntentIdText } from "./audit-api";
import {
  type DecisionDetail,
  disputeResultWords,
  readDecisionDetail,
  type TrailEntry,
  type TrailParts,
} from "./audit-reader";
import type { ClaimPair } from "./claims";
import { VERDICT_WORDS } from "./claims";
import type { CliResult } from "./decide-cli";
import { exportEvidence } from "./evidence-export";
import { loadPrincipals } from "./principals";

export const AUDIT_USAGE =
  "Usage: npm run audit -- show <seq> | export (--intent <id> | --capture <id>) [--out <file>] [--json] [--pglite <dir>]";

export const EXIT_OK = 0;
export const EXIT_BROKEN = 1;
export const EXIT_CANT_RUN = 2;

export type AuditCliDeps = {
  // The export's `exported_at` and the time step-ups are worked out at. Defaults to the system
  // clock, read at this edge only.
  now?: () => Date;
  // The mandates the checks that decided are narrowed by. Defaults to the shipped support agent's.
  mandates?: readonly Mandate[];
  // Where the default file name is resolved. Defaults to the current directory.
  cwd?: string;
};

const cantRun = (error: string): CliResult => ({
  exitCode: EXIT_CANT_RUN,
  stdout: "",
  stderr: `${error.replace(/\s*\n\s*/g, " ")}\n`,
});

const ok = (stdout: string, exitCode = EXIT_OK): CliResult => ({ exitCode, stdout, stderr: "" });
const jsonOut = (value: unknown, exitCode = EXIT_OK) =>
  ok(`${JSON.stringify(value, null, 2)}\n`, exitCode);

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

type Command =
  | { kind: "show"; seq: number }
  | { kind: "export"; scope: { kind: "intent" | "capture"; id: string }; out: string | undefined };

type Parsed =
  | { ok: true; command: Command; json: boolean; pgliteDir: string | undefined }
  | { ok: false; error: string };

const usageError = (what: string): Parsed => ({ ok: false, error: `${what} ${AUDIT_USAGE}` });

function parseArgs(args: readonly string[]): Parsed {
  const option = takePgliteOption(args);
  if (!option.ok) return usageError(option.error);
  let json = false;
  const values: Record<"intent" | "capture" | "out", string | undefined> = {
    intent: undefined,
    capture: undefined,
    out: undefined,
  };
  const words: string[] = [];
  for (let i = 0; i < option.rest.length; i += 1) {
    const arg = option.rest[i] as string;
    if (arg === "--json") json = true;
    else if (arg === "--intent" || arg === "--capture" || arg === "--out") {
      const name = arg.slice(2) as "intent" | "capture" | "out";
      const value = option.rest[i + 1];
      if (value === undefined || value.startsWith("-")) return usageError(`${arg} needs a value.`);
      if (values[name] !== undefined) return usageError(`${arg} is given twice.`);
      values[name] = value;
      i += 1;
    } else if (arg.startsWith("-")) return usageError(`Unknown option ${arg}.`);
    else words.push(arg);
  }
  const [name, seqText, ...extra] = words;
  const pgliteDir = option.pgliteDir;
  if (name === undefined) return usageError("Say what to do.");
  if (name === "show") {
    if (extra.length > 0) return usageError(`Unexpected argument ${extra[0]}.`);
    if (values.intent !== undefined || values.capture !== undefined || values.out !== undefined) {
      return usageError("--intent, --capture and --out only go with export.");
    }
    if (seqText === undefined) return usageError("show needs a decision's entry number.");
    if (!/^[1-9][0-9]{0,15}$/.test(seqText)) {
      return { ok: false, error: `${seqText} isn't an entry number.` };
    }
    return { ok: true, command: { kind: "show", seq: Number(seqText) }, json, pgliteDir };
  }
  if (name === "export") {
    if (seqText !== undefined) return usageError(`Unexpected argument ${seqText}.`);
    if ((values.intent === undefined) === (values.capture === undefined)) {
      return usageError("export needs exactly one of --intent or --capture.");
    }
    const scope =
      values.intent !== undefined
        ? { kind: "intent" as const, id: values.intent, schema: IntentIdText }
        : { kind: "capture" as const, id: values.capture as string, schema: CaptureIdText };
    if (!scope.schema.safeParse(scope.id).success) {
      return { ok: false, error: `${scope.id} isn't a valid ${scope.kind} ID.` };
    }
    return {
      ok: true,
      command: { kind: "export", scope: { kind: scope.kind, id: scope.id }, out: values.out },
      json,
      pgliteDir,
    };
  }
  return usageError(`Unknown command ${name}.`);
}

// --- show ----------------------------------------------------------------------------------

function decisionWords(detail: DecisionDetail): string {
  const label = { allow: "Allowed", step_up: "Step-up", deny: "Denied" }[detail.decision];
  const why =
    detail.reasons.length > 0
      ? detail.reasons.map(({ words, code }) => `${words} (${code})`).join("; ")
      : detail.matched_rules.length > 0
        ? `Allowed by rule ${detail.matched_rules.join(", ")}`
        : "";
  return why === "" ? label : `${label}: ${why}`;
}

function sourceText(pair: ClaimPair): string[] {
  return pair.record.sources.map(({ words, call, id }) => `${words}, ${call}, ${id}`);
}

function pairLines(pairs: readonly ClaimPair[]): string[] {
  const claims: string[] = ["What the message claims"];
  const records: string[] = ["What the records say"];
  pairs.forEach((pair, index) => {
    const n = index + 1;
    const verdict = VERDICT_WORDS[pair.verdict];
    claims.push(`  ${n}. ${verdict}: ${pair.claim === null ? "No claim" : pair.claim.text}`);
    if (pair.claim?.quote) {
      claims.push(`     "${pair.claim.quote}"${pair.claim.simulated ? " (simulated)" : ""}`);
    }
    const value = pair.record.value === null ? "" : ` (${pair.record.value})`;
    records.push(`  ${n}. ${pair.record.words}${value}`);
    if (pair.record.detail !== "") records.push(`     ${pair.record.detail}`);
    for (const source of sourceText(pair)) records.push(`     Source: ${source}`);
  });
  return [...claims, "", ...records];
}

function trailLine(item: TrailEntry): string {
  const head = `  #${item.seq} ${item.at}  `;
  if (!item.readable) return `${head}${item.type}: this entry can't be read (${item.problem})`;
  return `${head}${trailWords(item.parts)}`;
}

function trailWords(parts: TrailParts): string {
  switch (parts.kind) {
    case "decision":
      return `Decided: ${parts.decision}.`;
    case "approval":
      return parts.outcome === "rejected"
        ? `Answer rejected (${parts.code ?? "no code"}) on ${parts.channel}.`
        : `${parts.outcome === "approved" ? "Approved" : "Denied"} step-up ${parts.step_up_seq} on ${parts.channel}.`;
    case "execution.requested":
      return `Asked PayPal for ${parts.amount.display}${parts.replay ? " (a re-send)" : ""}.`;
    case "execution.result": {
      if (parts.outcome === "failed") {
        return `PayPal refused it: ${parts.error?.name ?? "no reason given"}.`;
      }
      if (parts.outcome === "unknown") return "PayPal hasn't confirmed it yet.";
      if (parts.refund) return `PayPal refunded it: ${parts.refund.id} ${parts.refund.status}.`;
      if (parts.invoice)
        return `The invoice was sent: ${parts.invoice.id} ${parts.invoice.status}.`;
      if (parts.dispute) return disputeResultWords(parts.dispute);
      return "PayPal carried it out.";
    }
    case "reconciliation":
      return `Matched ${parts.event ? `webhook ${parts.event.id}` : "a poll"} to refund ${parts.refund.id} (${parts.refund.status}).`;
    case "mandate.version":
      return `Mandate ${parts.id} version ${parts.version}.`;
  }
}

function showText(detail: DecisionDetail): string {
  const order = detail.order_number ?? detail.target?.id ?? "no target";
  const money = detail.amount ? ` ${detail.amount.display}` : "";
  const lines = [
    `#${detail.seq}  ${detail.action_words ?? "Unreadable proposal"}${money} on ${order}`,
    decisionWords(detail),
    "",
    ...pairLines(detail.claims),
    "",
    "What happened",
    ...(detail.trail.length === 0 ? ["  Nothing yet."] : detail.trail.map(trailLine)),
  ];
  return `${lines.join("\n")}\n`;
}

// --- Running -------------------------------------------------------------------------------

type Context = {
  db: Database;
  command: Command;
  json: boolean;
  now: Date;
  mandates: readonly Mandate[];
  cwd: string;
};

async function runCommand({ db, command, json, now, mandates, cwd }: Context): Promise<CliResult> {
  if (command.kind === "show") {
    const detail = await readDecisionDetail(db, command.seq, now, mandates);
    if (detail === null) return cantRun("There's no decision with that entry number.");
    if (!detail.readable) {
      return cantRun(`Entry ${command.seq} can't be read: ${detail.problem}`);
    }
    return json ? jsonOut(detail) : ok(showText(detail));
  }
  const exported = await exportEvidence(db, command.scope, now);
  if (exported.kind === "not_found") return cantRun("There's nothing to export for that.");
  const { file } = exported;
  const path = resolve(
    cwd,
    command.out ?? join(`countersign-evidence-${command.scope.kind}-${command.scope.id}.json`),
  );
  try {
    // `wx` fails when the file exists, so an export never overwrites anything.
    writeFileSync(path, `${JSON.stringify(file, null, 2)}\n`, { flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      return cantRun(
        `${path} already exists. Nothing was written. Choose another name with --out.`,
      );
    }
    return cantRun(`Couldn't write ${path}.`);
  }
  const count = file.entries.length;
  const exitCode = file.chain.intact ? EXIT_OK : EXIT_BROKEN;
  if (json) {
    return jsonOut(
      {
        path,
        entry_count: count,
        chain_intact: file.chain.intact,
        problem_count: file.chain.problem_count,
      },
      exitCode,
    );
  }
  const lines = [`Wrote ${path} with ${plural(count, "entry", "entries")}.`];
  if (!file.chain.intact) {
    lines.push(
      `The audit log is broken: ${plural(file.chain.problem_count, "problem", "problems")}. The file says so.`,
    );
  }
  return ok(`${lines.join("\n")}\n`, exitCode);
}

/** Runs the audit CLI. Exit 0 on success, 1 when the chain was broken at export, 2 when it can't run. */
export async function runAudit(
  args: readonly string[],
  env: Environment,
  deps: AuditCliDeps = {},
): Promise<CliResult> {
  const parsed = parseArgs(args);
  if (!parsed.ok) return cantRun(parsed.error);
  const { command, json, pgliteDir } = parsed;
  const clock = deps.now ?? (() => new Date());
  const mandates = deps.mandates ?? loadPrincipals({ env }).mandates;
  const cwd = deps.cwd ?? process.cwd();

  const target = resolveDatabaseTarget(env, pgliteDir);
  let handle: DatabaseHandle;
  try {
    handle = await openDatabase(target);
  } catch (error) {
    return cantRun(openFailure(error, target));
  }
  try {
    let present: boolean;
    try {
      present = await hasAuditLogTable(handle.db);
    } catch (error) {
      return cantRun(openFailure(error, target));
    }
    if (!present) {
      return cantRun(
        `The database at ${targetName(target)} has no audit_log table. Run npm run db:migrate first.`,
      );
    }
    return await runCommand({ db: handle.db, command, json, now: clock(), mandates, cwd });
  } catch (error) {
    return cantRun(
      `Couldn't use the audit log at ${targetName(target)}: ${failureReason(error, target)}`,
    );
  } finally {
    await handle.close().catch(() => {});
  }
}
