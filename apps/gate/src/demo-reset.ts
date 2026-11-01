// The demo reset's core (ADR 0042, ADR 0044): refuses while anything is in flight, replaces the
// seeded orders a scenario touched, and only then clears the log and Resolve's tables in one
// locked transaction, starting the new log with `demo.reset`. No HTTP and no AI here.

import {
  auditLog,
  clearDemoTables,
  countUnfinishedWork,
  type Database,
  eq,
  lockDemoTables,
  seedOrders,
} from "@countersign/db";
import { withAuditLog } from "@countersign/ledger";
import { type PayPalClient, parsePayPalEnv } from "@countersign/rail-paypal";
import {
  DEMO_ORDERS,
  type DemoOrder,
  newRunId,
  randomRunSuffix,
  readVaultTokens,
  runSeed,
  SEED_CONCURRENCY,
  type SeedReport,
  StoredRowSchema,
} from "@countersign/seed";
import { z } from "zod";
import {
  countUnansweredRequests,
  type Reader,
  type RequestedCapturesRead,
  requestedCaptureIds,
} from "./execution-log";
import type { NudgeFetch } from "./nudge";
import type { Environment } from "./principals";

export const DEMO_RESET_VAR = "COUNTERSIGN_DEMO_RESET";
export const demoResetEnabled = (env: Environment): boolean => env[DEMO_RESET_VAR] === "on";

/** The least time between two resets, read from the log so it holds across processes. */
export const RESET_COOLDOWN_MS = 60_000;
/** How far back an execution request with no result blocks a reset: far longer than any call. */
export const EXECUTION_WINDOW_MS = 600_000;

export const RESET_MESSAGES = {
  running: "A reset is already running.",
  executing: "Countersign is carrying out an approved action. Try again in a minute.",
  resolveBusy: "Resolve is still working on a message. Try again in a minute.",
  justReset: "The demo was reset less than a minute ago. Try again in a minute.",
  changed: "A scenario ran during the reset. Reset again.",
  locksBusy: "Countersign is busy writing. Try again in a minute.",
  noDatabase: "The gate has no database, so the demo can't be reset.",
  noPayPal: "PayPal isn't set up on the gate, so the demo can't be reset.",
  noVault: (missing: readonly string[]) =>
    `Set ${missing.join(" and ")} on the gate to reset the demo.`,
  notCleared: "The demo couldn't be reset. Nothing was cleared.",
} as const;

type Refusal = Exclude<keyof typeof RESET_MESSAGES, "noVault">;

const SEED_THREW = "the seed run failed unexpectedly";

const Count = z.int().min(0);

export const DemoResetPayloadSchema = z.strictObject({
  previous_head: z
    .object({ seq: z.int().positive(), hash: z.string().regex(/^[0-9a-f]{64}$/) })
    .nullable(),
  cleared: z.strictObject({
    entries: Count,
    tickets: Count,
    attachments: Count,
    runs: Count,
    drafts: Count,
    documents: Count,
  }),
});

export type Reseed = (input: {
  orders: readonly DemoOrder[];
  runId: string;
  seededAt: string;
}) => Promise<SeedReport>;

export type ResetDeps = {
  db?: Database;
  rail: () => PayPalClient;
  env: Environment;
  clock: () => Date;
  reseed?: Reseed;
  nudgeFetch?: NudgeFetch;
  randomSuffix?: () => string;
};

export type ResetReport = {
  complete: boolean;
  resetAt: string;
  tookMs: number;
  orders: {
    kept: number;
    replaced: string[];
    runId: string | null;
    failed: { orderNumber: string; call: string; reason: string }[];
  };
  cleared: {
    previousHead: { seq: number; hash: string } | null;
    entries: number;
    tickets: number;
    attachments: number;
    runs: number;
    drafts: number;
    documents: number;
  } | null;
  disputes:
    | { recorded: number; alreadyRecorded: number; problems: number }
    | { error: string }
    | null;
};

export type ResetResult =
  | { ok: true; report: ResetReport }
  | { ok: false; status: 409 | 503; message: string };

class ResetRefused extends Error {
  readonly refusal: Refusal;
  constructor(refusal: Refusal) {
    super(RESET_MESSAGES[refusal]);
    this.refusal = refusal;
  }
}

const refused = (status: 409 | 503, refusal: Refusal): ResetResult => ({
  ok: false,
  status,
  message: RESET_MESSAGES[refusal],
});

// Why the reset can't run now, or null. Run before the order check and again inside the lock.
async function busyRefusal(reader: Reader, now: Date): Promise<Refusal | null> {
  const unfinished = await countUnfinishedWork(reader);
  if (unfinished.runs > 0 || unfinished.drafts > 0) return "resolveBusy";
  const since = new Date(now.getTime() - EXECUTION_WINDOW_MS).toISOString();
  const unanswered = await countUnansweredRequests(reader, since);
  if (!unanswered.known || unanswered.count > 0) return "executing";
  const [first] = await reader
    .select({ entryType: auditLog.entryType, at: auditLog.at })
    .from(auditLog)
    .where(eq(auditLog.seq, 1))
    .limit(1);
  // A time that doesn't parse, or one ahead of the clock, counts as too recent.
  if (
    first?.entryType === "demo.reset" &&
    !(now.getTime() - Date.parse(first.at) >= RESET_COOLDOWN_MS)
  )
    return "justReset";
  return null;
}

// Runs `work` over `items` with at most `limit` in flight, keeping the input order.
async function inPool<T, R>(
  items: readonly T[],
  limit: number,
  work: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await work(items[index] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

export type OrderCheck = { kept: DemoOrder[]; replaced: DemoOrder[] };

/**
 * The order check: each catalog order is kept only when its seed row exists and reads, has the
 * catalog's buyer, its capture is named by no execution request (an unknown history names every
 * capture), and the capture reads `COMPLETED`. The capture is read only when the earlier rules
 * keep the order, at most 3 at once. A read that throws replaces the order.
 */
export async function checkSeedOrders(input: {
  rows: readonly unknown[];
  requested: RequestedCapturesRead;
  getCapture: (captureId: string) => Promise<{ status: string }>;
}): Promise<OrderCheck> {
  const { requested } = input;
  const rows = new Map<string, unknown>();
  for (const row of input.rows) {
    const orderNumber = z.object({ orderNumber: z.string() }).safeParse(row);
    if (orderNumber.success) rows.set(orderNumber.data.orderNumber, row);
  }
  const keep = await inPool(DEMO_ORDERS, SEED_CONCURRENCY, async (demo) => {
    const row = StoredRowSchema.safeParse(rows.get(demo.orderNumber));
    if (!row.success || row.data.buyer !== demo.buyer) return false;
    if (!requested.known || requested.captureIds.has(row.data.paypalCaptureId)) return false;
    try {
      return (await input.getCapture(row.data.paypalCaptureId)).status === "COMPLETED";
    } catch {
      return false;
    }
  });
  return {
    kept: DEMO_ORDERS.filter((_, index) => keep[index]),
    replaced: DEMO_ORDERS.filter((_, index) => !keep[index]),
  };
}

// The Postgres code for a lock not granted within `lock_timeout`.
const LOCK_NOT_AVAILABLE = "55P03";

const ErrorCode = z.object({ code: z.string() });

function isLockTimeout(error: unknown): boolean {
  const own = ErrorCode.safeParse(error);
  if (own.success && own.data.code === LOCK_NOT_AVAILABLE) return true;
  const cause = z.object({ cause: ErrorCode }).safeParse(error);
  return cause.success && cause.data.cause.code === LOCK_NOT_AVAILABLE;
}

// Set while a reset runs in this process; the cooldown read from the log covers other processes.
let running = false;

export async function resetDemo(deps: ResetDeps): Promise<ResetResult> {
  const start = deps.clock();
  const resetAt = start.toISOString();
  if (running) return refused(409, "running");
  running = true;
  try {
    return await reset(deps, start, resetAt);
  } finally {
    running = false;
  }
}

async function reset(deps: ResetDeps, start: Date, resetAt: string): Promise<ResetResult> {
  const { db, env } = deps;
  // 1. The checks that need no lock, before any write, one at a time.
  if (!db) return refused(503, "noDatabase");
  if (!parsePayPalEnv(env).ok) return refused(503, "noPayPal");
  const vault = readVaultTokens(env);
  if (!vault.ok) return { ok: false, status: 503, message: RESET_MESSAGES.noVault(vault.missing) };
  let rail: PayPalClient;
  try {
    rail = deps.rail();
  } catch {
    return refused(503, "noPayPal");
  }
  const busy = await busyRefusal(db, start);
  if (busy) return refused(409, busy);

  // 2. The order check.
  const rows = await db.select().from(seedOrders);
  const { kept, replaced } = await checkSeedOrders({
    rows,
    requested: await requestedCaptureIds(db),
    getCapture: (captureId) => rail.getCapture(captureId),
  });

  // 3. One seed run for exactly the orders to replace.
  const failed: ResetReport["orders"]["failed"] = [];
  let runId: string | null = null;
  if (replaced.length > 0) {
    runId = newRunId(resetAt, (deps.randomSuffix ?? randomRunSuffix)());
    const reseed: Reseed =
      deps.reseed ??
      ((input) =>
        runSeed({
          paypal: rail,
          db,
          orders: input.orders,
          runId: input.runId,
          vaultTokens: vault.tokens,
          clock: () => input.seededAt,
        }));
    const failAll = (reason: string) => {
      const already = new Set(failed.map((f) => f.orderNumber));
      for (const demo of replaced) {
        if (!already.has(demo.orderNumber))
          failed.push({ orderNumber: demo.orderNumber, call: "seed", reason });
      }
    };
    try {
      const seeded = await reseed({ orders: replaced, runId, seededAt: resetAt });
      for (const { orderNumber, call, reason } of seeded.failures)
        failed.push({ orderNumber, call, reason });
      if (seeded.problem) failAll(seeded.problem);
    } catch {
      failAll(SEED_THREW);
    }
    failed.sort((a, b) => a.orderNumber.localeCompare(b.orderNumber));
  }
  const orders = {
    kept: kept.length,
    replaced: replaced.map((demo) => demo.orderNumber),
    runId,
    failed,
  };
  if (failed.length > 0) {
    return {
      ok: true,
      report: {
        complete: false,
        resetAt,
        tookMs: deps.clock().getTime() - start.getTime(),
        orders,
        cleared: null,
        disputes: null,
      },
    };
  }

  // 4. The clear, in one locked transaction. A refusal or failure here clears nothing; the
  // replacement orders stay, and the next reset keeps them.
  let cleared: NonNullable<ResetReport["cleared"]>;
  try {
    cleared = await withAuditLog(db, async (log) => {
      await lockDemoTables(log.tx);
      const refusal = await busyRefusal(log.tx, deps.clock());
      if (refusal) throw new ResetRefused(refusal);
      const tables = await clearDemoTables(log.tx);
      const { head, ...counts } = tables;
      const payload = DemoResetPayloadSchema.parse({ previous_head: head, cleared: counts });
      await log.append({ entryType: "demo.reset", refId: null, at: resetAt, payload });
      return { previousHead: head, ...counts };
    });
  } catch (error) {
    if (error instanceof ResetRefused) return refused(409, error.refusal);
    if (isLockTimeout(error)) return refused(409, "locksBusy");
    return refused(503, "notCleared");
  }

  // Dispute sync follows the clear (T-008); until it runs, the reset isn't complete.
  const disputes: ResetReport["disputes"] = null;
  return {
    ok: true,
    report: {
      complete: disputes !== null,
      resetAt,
      tookMs: deps.clock().getTime() - start.getTime(),
      orders,
      cleared,
      disputes,
    },
  };
}
