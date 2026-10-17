// The seed CLI: `npm run seed` runs a seed run, `--dry-run` prints the plan without a call, and
// `list` shows what's seeded. Returns the output and exit code rather than writing them, so tests
// can call it directly. No message ever holds a PayPal secret, a vault token or DATABASE_URL.

import { randomBytes } from "node:crypto";
import { createDatabaseShipmentStore, createMockCarrier } from "@countersign/carrier-mock";
import {
  asc,
  type DatabaseHandle,
  type DatabaseTarget,
  type Environment,
  failureReason,
  openDatabase,
  openFailure,
  resolveDatabaseTarget,
  seedOrders,
  sql,
  takePgliteOption,
  targetName,
} from "@countersign/db";
import {
  CURRENCIES,
  formatMoney,
  SHIPMENT_STATUSES,
  type ShipmentStatus,
  TimestampSchema,
} from "@countersign/mandate";
import { createPayPalClient, type FetchLike, parsePayPalEnv } from "@countersign/rail-paypal";
import { z } from "zod";
import { DEMO_ORDERS, productFor, RunIdSchema } from "./seed-catalog";
import { runSeed, type SeedReport } from "./seed-run";

export type SeedCliResult = { exitCode: number; stdout: string; stderr: string };

/** What the CLI reads from outside, injectable so tests need no network and no clock. */
export type SeedCliOptions = {
  fetch?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
  /** The time of seeding, as an ISO 8601 timestamp. */
  clock?: () => string;
  /** The random part of a new run ID: lowercase letters and digits. */
  randomSuffix?: () => string;
};

export const SEED_USAGE =
  "Usage: npm run seed -- [--run <run>] | --dry-run | list [--pglite <dir>]";

export const EXIT_OK = 0;
export const EXIT_PARTIAL = 1;
export const EXIT_CANT_RUN = 2;

export const VAULT_ENV_NAMES = ["PAYPAL_SEED_VAULT_TOKEN", "PAYPAL_SEED_VAULT_TOKEN_B"] as const;

const RUN_ID_RULE = "The run ID must be 4 to 24 lowercase letters and digits.";

// The arguments as read off the command line, before zod checks them.
type RawArgs = {
  commands: string[];
  dryRun: number;
  runs: string[];
  pglite: boolean;
  unknown: string[];
};

const ArgsSchema = z
  .object({
    commands: z
      .array(z.literal("list", { error: (issue) => `Unknown command ${String(issue.input)}.` }))
      .max(1, { error: "Give one command at most." }),
    dryRun: z.int().max(1, { error: "--dry-run is given twice." }),
    runs: z
      .array(z.string().refine((run) => RunIdSchema.safeParse(run).success, RUN_ID_RULE))
      .max(1, { error: "--run is given twice." }),
    pglite: z.boolean(),
    unknown: z
      .array(z.string())
      .max(0, { error: (issue) => `Unknown option ${String((issue.input as string[])[0])}.` }),
  })
  .superRefine((args, ctx) => {
    if (args.commands.length > 0 && (args.dryRun > 0 || args.runs.length > 0))
      ctx.addIssue({ code: "custom", message: "list takes only --pglite." });
    if (args.dryRun > 0 && (args.runs.length > 0 || args.pglite))
      ctx.addIssue({ code: "custom", message: "--dry-run takes no other options." });
  });

type Command = { mode: "seed"; runId: string | undefined } | { mode: "dry-run" } | { mode: "list" };

function readArgs(args: readonly string[], pglite: boolean): RawArgs {
  const raw: RawArgs = { commands: [], dryRun: 0, runs: [], pglite, unknown: [] };
  for (let index = 0; index < args.length; index++) {
    const arg = args[index] ?? "";
    if (arg === "--dry-run") raw.dryRun += 1;
    else if (arg === "--run") {
      const value = args[index + 1];
      // A missing value, or another option where the value should be, fails the run ID rule.
      if (value === undefined || value.startsWith("-")) raw.runs.push("");
      else {
        raw.runs.push(value);
        index++;
      }
    } else if (arg.startsWith("-")) raw.unknown.push(arg);
    else raw.commands.push(arg);
  }
  return raw;
}

function parseCommand(args: readonly string[], pglite: boolean): Command | string {
  const parsed = ArgsSchema.safeParse(readArgs(args, pglite));
  if (!parsed.success) {
    const messages = [...new Set(parsed.error.issues.map((issue) => issue.message))];
    return `${messages.join(" ")} ${SEED_USAGE}`;
  }
  const { commands, dryRun, runs } = parsed.data;
  if (commands.length > 0) return { mode: "list" };
  if (dryRun > 0) return { mode: "dry-run" };
  return { mode: "seed", runId: runs[0] };
}

const cantRun = (error: string): SeedCliResult => ({
  exitCode: EXIT_CANT_RUN,
  stdout: "",
  stderr: `${error}\n`,
});

const STATUS_WORDS: Record<ShipmentStatus, string> = {
  delivered: "delivered",
  in_transit: "in transit",
  stalled_10d: "stalled",
  lost: "lost",
};
const TOTALS_ORDER: readonly ShipmentStatus[] = ["delivered", "in_transit", "stalled_10d", "lost"];

const totals = (counts: Record<ShipmentStatus, number>) =>
  TOTALS_ORDER.map((status) => `${counts[status]} ${STATUS_WORDS[status]}`).join(", ");

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

// A stored value shown on one line: control characters are escaped, so a row can't break it.
const printable = (value: string) => JSON.stringify(value).slice(1, -1);

function table(cells: readonly (readonly string[])[]): string[] {
  const widths = cells[0]?.map((_, column) =>
    Math.max(...cells.map((line) => line[column]?.length ?? 0)),
  );
  return cells.map((line) =>
    line
      .map((cell, column) =>
        column === line.length - 1 ? cell : cell.padEnd(widths?.[column] ?? 0),
      )
      .join("  "),
  );
}

/** The plan: one line per demo order, then the status totals. No call, no database. */
export function formatPlan(): string {
  const orders = [...DEMO_ORDERS].sort((a, b) => a.orderNumber.localeCompare(b.orderNumber));
  const counts = Object.fromEntries(SHIPMENT_STATUSES.map((status) => [status, 0])) as Record<
    ShipmentStatus,
    number
  >;
  const cells = orders.map((demo) => {
    counts[demo.status] += 1;
    const product = productFor(demo);
    return [
      demo.orderNumber,
      product.name,
      formatMoney(product.price),
      demo.buyer,
      STATUS_WORDS[demo.status],
      demo.role,
    ];
  });
  return `${[
    `Dry run: the seed would create ${plural(orders.length, "order", "orders")}. Nothing is sent or written.`,
    ...table(cells),
    `Totals: ${totals(counts)}.`,
  ].join("\n")}\n`;
}

/** The summary of a seed run, with exit 0 only when every order is seeded. */
export function formatReport(report: SeedReport): SeedCliResult {
  const { runId, total, seeded, failures, problem } = report;
  if (!problem && failures.length === 0 && seeded === total) {
    return {
      exitCode: EXIT_OK,
      stdout: `Seeded ${seeded} of ${plural(total, "order", "orders")} in run ${runId}: ${totals(report.counts)}.\n`,
      stderr: "",
    };
  }
  const lines: string[] = [];
  if (problem)
    lines.push(`${problem}. Vault a second sandbox buyer for PAYPAL_SEED_VAULT_TOKEN_B.`);
  const heading = `Seeded ${seeded} of ${plural(total, "order", "orders")} in run ${runId}.`;
  lines.push(failures.length > 0 ? `${heading} ${failures.length} failed:` : heading);
  for (const failure of failures) {
    const debug = failure.debugId ? ` Debug ID ${failure.debugId}.` : "";
    lines.push(`${failure.orderNumber} ${failure.call} ${failure.reason}.${debug}`);
  }
  if (!problem) lines.push(`Run npm run seed -- --run ${runId} to retry them.`);
  return { exitCode: EXIT_PARTIAL, stdout: `${lines.join("\n")}\n`, stderr: "" };
}

const VaultEnvSchema = z.object({
  PAYPAL_SEED_VAULT_TOKEN: z.string().min(1),
  PAYPAL_SEED_VAULT_TOKEN_B: z.string().min(1),
});

// The PayPal and vault settings, or one line naming what's missing. Never a value.
function readSeedEnv(env: Environment) {
  const paypal = parsePayPalEnv(env);
  const vault = VaultEnvSchema.safeParse({
    PAYPAL_SEED_VAULT_TOKEN: env.PAYPAL_SEED_VAULT_TOKEN,
    PAYPAL_SEED_VAULT_TOKEN_B: env.PAYPAL_SEED_VAULT_TOKEN_B,
  });
  if (paypal.ok && vault.success) {
    return {
      ok: true as const,
      vaultTokens: {
        A: vault.data.PAYPAL_SEED_VAULT_TOKEN,
        B: vault.data.PAYPAL_SEED_VAULT_TOKEN_B,
      },
    };
  }
  const missing = [
    ...(paypal.ok ? [] : paypal.missing),
    ...VAULT_ENV_NAMES.filter((name) => !env[name]),
  ];
  const sentences = ["The seed can't start."];
  if (missing.length > 0) sentences.push(`Set ${missing.join(", ")} in .env.local.`);
  if (!paypal.ok) {
    const others = paypal.problems.filter((problem) => !problem.endsWith(" is missing."));
    sentences.push(...others);
  }
  return { ok: false as const, error: sentences.join(" ") };
}

const RandomSuffixSchema = z.string().regex(/^[a-z0-9]{4,10}$/);

const randomSuffix = () => {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  return [...randomBytes(6)].map((byte) => alphabet[byte % alphabet.length]).join("");
};

/** A new run ID: the seeding date and a random suffix, such as `20261017k3x9qa`. */
export function newRunId(seededAt: string, suffix: string): string {
  const date = TimestampSchema.parse(seededAt).slice(0, 10).replaceAll("-", "");
  return RunIdSchema.parse(`${date}${RandomSuffixSchema.parse(suffix)}`);
}

const TableSchema = z.array(z.object({ present: z.boolean() })).length(1);

// Whether `seed_orders` exists. Also the first query, so an unreachable database fails here.
async function hasSeedTables(handle: DatabaseHandle): Promise<boolean> {
  const rows = await handle.db
    .select({
      present: sql<boolean>`to_regclass('seed_orders') IS NOT NULL AND to_regclass('carrier_shipments') IS NOT NULL`,
    })
    .from(sql`(VALUES (1)) AS probe (n)`);
  return TableSchema.parse(rows)[0]?.present === true;
}

async function withTarget(
  target: DatabaseTarget,
  work: (handle: DatabaseHandle) => Promise<SeedCliResult>,
): Promise<SeedCliResult> {
  let handle: DatabaseHandle;
  try {
    handle = await openDatabase(target);
  } catch (error) {
    return cantRun(openFailure(error, target));
  }
  try {
    let present: boolean;
    try {
      present = await hasSeedTables(handle);
    } catch (error) {
      return cantRun(openFailure(error, target));
    }
    if (!present) {
      return cantRun(
        `The database at ${targetName(target)} has no seed tables. Run npm run db:migrate first.`,
      );
    }
    return await work(handle);
  } catch (error) {
    return cantRun(
      `Couldn't use the database at ${targetName(target)}: ${failureReason(error, target)}`,
    );
  } finally {
    await handle.close().catch(() => {});
  }
}

// A seed row as `list` shows it. One that fails this is listed as unreadable.
const ListedRowSchema = z.object({
  orderNumber: z.string().regex(/^KIK-\d{4}$/),
  paypalOrderId: z.string().min(1),
  paypalCaptureId: z.string().min(1),
  amountMinor: z.number().int().positive(),
  currency: z.enum(CURRENCIES),
  payerEmail: z.string().min(1),
  trackingNumber: z.string().min(1),
});

async function listSeeded(handle: DatabaseHandle): Promise<string> {
  const rows = await handle.db.select().from(seedOrders).orderBy(asc(seedOrders.orderNumber));
  if (rows.length === 0) return "No seeded orders yet.\n";
  const carrier = createMockCarrier(createDatabaseShipmentStore(handle.db));
  const cells: string[][] = [];
  for (const stored of rows) {
    const row = ListedRowSchema.safeParse(stored);
    if (!row.success) {
      cells.push([printable(String(stored.orderNumber)), "unreadable row"]);
      continue;
    }
    const { data } = row;
    const lookup = await carrier.getShipment(data.trackingNumber);
    const status =
      lookup.kind === "found"
        ? STATUS_WORDS[lookup.shipment.status]
        : lookup.kind === "not_found"
          ? "no shipment"
          : "unreadable shipment";
    cells.push([
      data.orderNumber,
      printable(data.paypalOrderId),
      printable(data.paypalCaptureId),
      formatMoney({ minor: data.amountMinor, currency: data.currency }),
      printable(data.payerEmail),
      printable(data.trackingNumber),
      status,
    ]);
  }
  const heading = `${plural(rows.length, "seeded order", "seeded orders")}.`;
  return `${[heading, ...table(cells)].join("\n")}\n`;
}

/** Runs the seed CLI. Exit 0 when done, 1 for a partial seed, 2 when it can't run. */
export async function runSeedCli(
  args: readonly string[],
  env: Environment,
  options: SeedCliOptions = {},
): Promise<SeedCliResult> {
  const option = takePgliteOption(args);
  if (!option.ok) return cantRun(`${option.error} ${SEED_USAGE}`);
  const command = parseCommand(option.rest, option.pgliteDir !== undefined);
  if (typeof command === "string") return cantRun(command);

  if (command.mode === "dry-run") return { exitCode: EXIT_OK, stdout: formatPlan(), stderr: "" };

  if (command.mode === "list") {
    const target = resolveDatabaseTarget(env, option.pgliteDir);
    return withTarget(target, async (handle) => ({
      exitCode: EXIT_OK,
      stdout: await listSeeded(handle),
      stderr: "",
    }));
  }

  const seedEnv = readSeedEnv(env);
  if (!seedEnv.ok) return cantRun(seedEnv.error);
  const seededAt = (options.clock ?? (() => new Date().toISOString()))();
  if (!TimestampSchema.safeParse(seededAt).success)
    return cantRun("The seeding time isn't an ISO 8601 timestamp.");
  const runId = command.runId ?? newRunId(seededAt, (options.randomSuffix ?? randomSuffix)());
  const paypal = createPayPalClient({
    env,
    ...(options.fetch ? { fetch: options.fetch } : {}),
    ...(options.sleep ? { sleep: options.sleep } : {}),
  });

  const target = resolveDatabaseTarget(env, option.pgliteDir);
  return withTarget(target, async (handle) => {
    const report = await runSeed({
      paypal,
      db: handle.db,
      orders: DEMO_ORDERS,
      runId,
      vaultTokens: seedEnv.vaultTokens,
      clock: () => seededAt,
      databaseReason: (error) => failureReason(error, target),
    });
    return formatReport(report);
  });
}
