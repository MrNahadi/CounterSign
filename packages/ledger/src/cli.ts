// The ledger CLI: `verify` re-walks the audit log and says whether it's intact, `tail`
// shows its last entries, and `check-export` re-hashes an evidence file with no database.
// Returns the output and exit code rather than writing them, so tests can call it directly. No message ever holds DATABASE_URL or a password.

import { readFile } from "node:fs/promises";
import {
  auditLog,
  type DatabaseHandle,
  type DatabaseTarget,
  desc,
  type Environment,
  failureReason,
  hasAuditLogTable,
  openDatabase,
  openFailure,
  resolveDatabaseTarget,
  sql,
  takePgliteOption,
  targetName,
} from "@countersign/db";
import { z } from "zod";
import type { ChainRow, ChainVerdict } from "./chain";
import { checkEvidence, type EvidenceCheck } from "./evidence";
import { verifyLog } from "./log";

export type LedgerCliResult = { exitCode: number; stdout: string; stderr: string };

export const LEDGER_USAGE =
  "Usage: npm run ledger -- verify | tail [count] | check-export <file> [--pglite <dir>]";

export const EXIT_OK = 0;
export const EXIT_BROKEN = 1;
export const EXIT_NO_DATABASE = 2;

export const DEFAULT_TAIL_COUNT = 10;
const HASH_PREFIX = 12;

const CommandSchema = z.discriminatedUnion("command", [
  z.object({ command: z.literal("verify"), extra: z.array(z.string()).length(0) }),
  z.object({
    command: z.literal("tail"),
    extra: z
      .array(z.string().regex(/^[1-9]\d*$/))
      .max(1)
      .transform(([count]) => (count === undefined ? DEFAULT_TAIL_COUNT : Number(count)))
      .pipe(z.int().positive()),
  }),
  z.object({
    command: z.literal("check-export"),
    extra: z.tuple([z.string().min(1)]),
  }),
]);

type Command =
  | { command: "verify" }
  | { command: "tail"; count: number }
  | { command: "check-export"; file: string };

const failure = (error: string): LedgerCliResult => ({
  exitCode: EXIT_NO_DATABASE,
  stdout: "",
  stderr: `${error}\n`,
});

function parseCommand(args: readonly string[]): Command | string {
  const unknown = args.find((arg) => arg.startsWith("-"));
  if (unknown !== undefined) return `Unknown option ${unknown}. ${LEDGER_USAGE}`;
  const [command, ...extra] = args;
  const parsed = CommandSchema.safeParse({ command, extra });
  if (!parsed.success) return LEDGER_USAGE;
  switch (parsed.data.command) {
    case "verify":
      return { command: "verify" };
    case "tail":
      return { command: "tail", count: parsed.data.extra };
    case "check-export":
      return { command: "check-export", file: parsed.data.extra[0] };
  }
}

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

// A stored value shown on one line: control characters and lone surrogates are escaped, so a
// tampered row can't break the line.
const printable = (value: string) => JSON.stringify(value).slice(1, -1);

export function formatVerdict(verdict: ChainVerdict): LedgerCliResult {
  const entries = plural(verdict.entries, "entry", "entries");
  if (verdict.intact) {
    const { seq, hash } = verdict.head;
    return {
      exitCode: EXIT_OK,
      stdout: `Audit log intact: ${entries}. Head #${seq} ${hash}.\n`,
      stderr: "",
    };
  }
  const lines = [
    `Audit log broken: ${plural(verdict.problems.length, "problem", "problems")} in ${entries}.`,
    ...verdict.problems.map(({ seq, problem, detail }) => `#${seq} ${problem} ${detail}`),
  ];
  return { exitCode: EXIT_BROKEN, stdout: `${lines.join("\n")}\n`, stderr: "" };
}

// What `check-export` prints for a checked file: the intact sentence and head, or one line per
// problem. A file that says the log was broken when it was exported also exits 1, with a line
// saying so, since its head can't be trusted.
export function formatEvidenceCheck(check: Extract<EvidenceCheck, { ok: true }>): LedgerCliResult {
  const { file, problems } = check;
  const lines = problems.map(({ seq, problem, detail }) => `#${seq} ${problem} ${detail}`);
  if (!file.chain.intact) {
    lines.push(
      `The audit log was broken when this was exported: ${plural(file.chain.problem_count, "problem", "problems")}.`,
    );
  }
  if (lines.length > 0) {
    return { exitCode: EXIT_BROKEN, stdout: `${lines.map(printable).join("\n")}\n`, stderr: "" };
  }
  const entries = plural(file.entries.length, "entry", "entries");
  const head =
    file.chain.head === null
      ? "The log was empty at export."
      : `The log's head at export was #${file.chain.head.seq} ${printable(file.chain.head.hash)}.`;
  return {
    exitCode: EXIT_OK,
    stdout: `Evidence intact: ${entries}, each matching its hash. ${head}\n`,
    stderr: "",
  };
}

async function checkExportFile(path: string): Promise<LedgerCliResult> {
  const name = printable(path);
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    const code =
      error instanceof Error && "code" in error && typeof error.code === "string"
        ? ` (${error.code})`
        : "";
    return failure(`Couldn't read ${name}${code}.`);
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return failure(`Couldn't read ${name}. It isn't JSON.`);
  }
  const check = checkEvidence(value);
  if (!check.ok) return failure(`Couldn't read ${name}. ${printable(check.error)}`);
  return formatEvidenceCheck(check);
}

const TailRowSchema = z.object({
  seq: z.int(),
  entryType: z.string(),
  refId: z.string().nullable(),
  at: z.string(),
  hash: z.string(),
});
type TailRow = Pick<ChainRow, "seq" | "entryType" | "refId" | "at" | "hash">;

export function formatTail(rows: readonly TailRow[], total: number): string {
  if (rows.length === 0) return "The audit log has no entries.\n";
  const cells = rows.map((row) => [
    `#${row.seq}`,
    printable(row.at),
    printable(row.entryType),
    row.refId === null ? "-" : printable(row.refId),
    printable(row.hash.slice(0, HASH_PREFIX)),
  ]);
  const widths = cells[0]?.map((_, column) =>
    Math.max(...cells.map((line) => line[column]?.length ?? 0)),
  );
  const lines = cells.map((line) =>
    line
      .map((cell, column) =>
        column === line.length - 1 ? cell : cell.padEnd(widths?.[column] ?? 0),
      )
      .join("  "),
  );
  const heading = `Last ${plural(rows.length, "entry", "entries")} of ${total}.`;
  return `${[heading, ...lines].join("\n")}\n`;
}

async function readTail(handle: DatabaseHandle, count: number): Promise<string> {
  const [counted] = await handle.db.select({ n: sql<number>`count(*)::int` }).from(auditLog);
  const total = z.int().nonnegative().parse(counted?.n);
  const rows = await handle.db
    .select({
      seq: auditLog.seq,
      entryType: auditLog.entryType,
      refId: auditLog.refId,
      at: auditLog.at,
      hash: auditLog.hash,
    })
    .from(auditLog)
    .orderBy(desc(auditLog.seq))
    .limit(count);
  const parsed = z.array(TailRowSchema).parse(rows);
  return formatTail(parsed.reverse(), total);
}

async function withTarget(
  target: DatabaseTarget,
  work: (handle: DatabaseHandle) => Promise<LedgerCliResult>,
): Promise<LedgerCliResult> {
  let handle: DatabaseHandle;
  try {
    handle = await openDatabase(target);
  } catch (error) {
    return failure(openFailure(error, target));
  }
  try {
    // The first query, so a database that can't be reached is reported as not opened.
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
    return await work(handle);
  } catch (error) {
    return failure(
      `Couldn't read the audit log at ${targetName(target)}: ${failureReason(error, target)}`,
    );
  } finally {
    await handle.close().catch(() => {});
  }
}

export async function runLedgerCli(
  args: readonly string[],
  env: Environment,
): Promise<LedgerCliResult> {
  const option = takePgliteOption(args);
  if (!option.ok) return failure(`${option.error} ${LEDGER_USAGE}`);
  const command = parseCommand(option.rest);
  if (typeof command === "string") return failure(command);
  if (command.command === "check-export") return checkExportFile(command.file);
  const target = resolveDatabaseTarget(env, option.pgliteDir);

  return withTarget(target, async (handle) => {
    if (command.command === "verify") return formatVerdict(await verifyLog(handle.db));
    return { exitCode: EXIT_OK, stdout: await readTail(handle, command.count), stderr: "" };
  });
}
