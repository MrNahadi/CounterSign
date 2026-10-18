import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { asc, auditLog, openPgliteDirectory, sql } from "@countersign/db";
import { appendEntries, runLedgerCli } from "@countersign/ledger";
import { SANDBOX_BASE_URL } from "@countersign/rail-paypal";
import { describe, expect, it } from "vitest";
import {
  executionRequestedEntry,
  executionResultEntry,
  ReconciliationPayloadSchema,
} from "../src/execution-log";
import {
  EXIT_CANT_RUN,
  EXIT_OPEN,
  EXIT_RECONCILED,
  RECONCILE_USAGE,
  runReconcile,
} from "../src/reconcile-cli";
import { createFakeSandbox, type FakeSandbox, httpError } from "./fake-sandbox";

// Each PGlite start takes a couple of seconds.
const SLOW = 60_000;
const NOW = new Date("2026-10-17T12:00:00.000Z");
const SECRET = "fake-client-secret-not-real";
const ENV = {
  PAYPAL_BASE_URL: SANDBOX_BASE_URL,
  PAYPAL_CLIENT_ID: "fake-client-id",
  PAYPAL_CLIENT_SECRET: SECRET,
};
const entry = fileURLToPath(new URL("../src/reconcile-main.ts", import.meta.url));
const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const usd = (minor: number) => ({ minor, currency: "USD" as const });
const intentId = (n: number) => `int_${String(n).repeat(24)}`;

type Seeded = {
  n: number;
  at?: string;
  outcome?: "executed" | "unknown" | "failed" | null;
  amount?: number;
};

// A PGlite directory whose audit log holds these requests, each followed by its result.
async function logWith(items: readonly Seeded[]): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "reconcile-cli-"));
  const handle = await openPgliteDirectory(dir);
  try {
    let seq = 0;
    for (const {
      n,
      at = "2026-10-17T09:00:00.000Z",
      outcome = "executed",
      amount = 1800,
    } of items) {
      const requestSeq = seq + 1;
      const inputs = [
        executionRequestedEntry({
          at,
          intentId: intentId(n),
          intentHash: String(n).repeat(64),
          principal: "support-agent",
          rail: "paypal",
          action: "paypal.refund",
          captureId: `CAP-${n}`,
          amount: usd(amount),
          decisionSeq: 1,
        }),
      ];
      if (outcome === "executed") {
        inputs.push(
          executionResultEntry({
            at,
            intentId: intentId(n),
            requestSeq,
            outcome,
            refund: { id: `REFUND-${n}`, status: "COMPLETED" },
          }),
        );
      } else if (outcome === "unknown") {
        inputs.push(executionResultEntry({ at, intentId: intentId(n), requestSeq, outcome }));
      } else if (outcome === "failed") {
        inputs.push(
          executionResultEntry({
            at,
            intentId: intentId(n),
            requestSeq,
            outcome,
            error: { name: "UNPROCESSABLE_ENTITY", issues: [], debugId: null },
          }),
        );
      }
      const written = await appendEntries(handle.db, inputs);
      if (!written.ok) throw new Error(written.rejection.detail);
      seq += inputs.length;
    }
  } finally {
    await handle.close();
  }
  return dir;
}

function sandboxWith(
  refunds: Record<string, { status?: "COMPLETED" | "CANCELLED"; minor?: number }>,
) {
  const rail = createFakeSandbox();
  for (const [n, { status = "COMPLETED", minor = 1800 }] of Object.entries(refunds)) {
    rail.refunds.set(`REFUND-${n}`, {
      id: `REFUND-${n}`,
      status,
      amount: usd(minor),
      captureId: `CAP-${n}`,
    });
  }
  return rail;
}

const run = (dir: string, rail: FakeSandbox, args: string[] = []) =>
  runReconcile(["--pglite", dir, ...args], ENV, { rail, now: () => NOW });

async function reconciliations(dir: string) {
  const handle = await openPgliteDirectory(dir);
  try {
    const rows = await handle.db.select().from(auditLog).orderBy(asc(auditLog.seq));
    return rows
      .filter((row) => row.entryType === "reconciliation")
      .map((row) => ({
        refId: row.refId,
        at: row.at,
        payload: ReconciliationPayloadSchema.parse(JSON.parse(row.payload)),
      }));
  } finally {
    await handle.close();
  }
}

describe("runReconcile", () => {
  it(
    "reconciles an executed refund once, with source poll, and a second run adds nothing",
    async () => {
      const dir = await logWith([{ n: 1 }]);
      const rail = sandboxWith({ 1: {} });

      const first = await run(dir, rail);
      expect(first.exitCode).toBe(EXIT_RECONCILED);
      expect(first.stdout).toContain("Reconciled 1 refund.");
      expect(first.stdout).toContain(`${intentId(1)}  REFUND-1  COMPLETED  $18.00`);
      const [row, ...rest] = await reconciliations(dir);
      expect(rest).toHaveLength(0);
      expect(row?.refId).toBe(intentId(1));
      expect(row?.at).toBe(NOW.toISOString());
      expect(row?.payload).toEqual({
        source: "poll",
        refund: { id: "REFUND-1", captureId: "CAP-1", status: "COMPLETED", amount: usd(1800) },
        resultSeq: 2,
      });

      const reads = rail.calls.length;
      const second = await run(dir, rail);
      expect(second.exitCode).toBe(EXIT_RECONCILED);
      expect(second.stdout).toContain("No refunds to reconcile.");
      expect(rail.calls).toHaveLength(reads);
      expect(await reconciliations(dir)).toHaveLength(1);

      const verify = await runLedgerCli(["verify", "--pglite", dir], {});
      expect(verify.exitCode).toBe(0);
    },
    SLOW,
  );

  it(
    "exits 1 and lists a cancelled refund or one whose amount differs, still on the next run",
    async () => {
      const dir = await logWith([{ n: 1 }, { n: 2 }, { n: 3 }]);
      const rail = sandboxWith({ 1: { status: "CANCELLED" }, 2: { minor: 900 }, 3: {} });

      const first = await run(dir, rail);
      expect(first.exitCode).toBe(EXIT_OPEN);
      expect(first.stdout).toContain("Reconciled 3 refunds.");
      expect(first.stdout).toContain("Refund REFUND-1 for");
      expect(first.stdout).toContain("is CANCELLED");
      expect(first.stdout).toContain("is $9.00, but the request was $18.00");
      expect(first.stdout).not.toContain("Refund REFUND-3 for");
      expect(await reconciliations(dir)).toHaveLength(3);

      const second = await run(dir, rail);
      expect(second.exitCode).toBe(EXIT_OPEN);
      expect(second.stdout).toContain("No refunds to reconcile.");
      expect(second.stdout).toContain("is CANCELLED");
      expect(await reconciliations(dir)).toHaveLength(3);
    },
    SLOW,
  );

  it(
    "lists requests with no result or an unknown result, oldest first with their age, and exits 1",
    async () => {
      const dir = await logWith([
        { n: 1, at: "2026-10-17T10:00:00.000Z", outcome: "unknown" },
        { n: 2, at: "2026-10-14T09:00:00.000Z", outcome: null },
        { n: 3, outcome: "failed" },
      ]);
      const result = await run(dir, sandboxWith({}));

      expect(result.exitCode).toBe(EXIT_OPEN);
      const out = result.stdout;
      expect(out).toContain(`${intentId(2)}  capture CAP-2  3 days old`);
      expect(out).toContain(`${intentId(1)}  capture CAP-1  2 hours old`);
      expect(out.indexOf(intentId(2))).toBeLessThan(out.indexOf(intentId(1)));
      expect(out).not.toContain(intentId(3));
    },
    SLOW,
  );

  it(
    "reports a refund it can't re-read, writes nothing for it and exits 1",
    async () => {
      const dir = await logWith([{ n: 1 }, { n: 2 }]);
      const rail = sandboxWith({ 2: {} });
      const result = await run(dir, rail);

      expect(result.exitCode).toBe(EXIT_OPEN);
      expect(result.stdout).toContain("Reconciled 1 refund.");
      expect(result.stdout).toContain("Couldn't re-read refund REFUND-1");
      expect(await reconciliations(dir)).toHaveLength(1);

      rail.failures.getRefund = httpError("get-refund", 503);
      const again = await run(dir, rail);
      expect(again.exitCode).toBe(EXIT_OPEN);
      expect(again.stdout + again.stderr).not.toContain(SECRET);
    },
    SLOW,
  );

  it("exits 2 naming the missing variables, never their values", async () => {
    const result = await runReconcile(["--pglite", "unused"], { PAYPAL_CLIENT_ID: "fake-id" });
    expect(result.exitCode).toBe(EXIT_CANT_RUN);
    expect(result.stderr).toContain("PAYPAL_CLIENT_SECRET");
    expect(result.stderr).not.toContain("fake-id");
  });

  it("exits 2 on an unreachable DATABASE_URL and never shows it", async () => {
    const url = "postgres://countersign:pw-not-real@127.0.0.1:1/countersign";
    const result = await runReconcile([], { ...ENV, DATABASE_URL: url }, {});
    expect(result.exitCode).toBe(EXIT_CANT_RUN);
    expect(result.stderr).toMatch(/^Couldn't open the database at DATABASE_URL: .+\n$/);
    expect(result.stderr).not.toContain("pw-not-real");
  });

  it("exits 2 on bad arguments", async () => {
    const result = await runReconcile(["--nope"], ENV);
    expect(result.exitCode).toBe(EXIT_CANT_RUN);
    expect(result.stderr).toContain(RECONCILE_USAGE);
  });

  it(
    "exits 2 when the database has no audit_log table",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "reconcile-empty-"));
      const handle = await openPgliteDirectory(dir);
      await handle.db.execute(sql`DROP TABLE audit_log`);
      await handle.close();
      const result = await run(dir, createFakeSandbox());
      expect(result.exitCode).toBe(EXIT_CANT_RUN);
      expect(result.stderr).toContain("db:migrate");
    },
    SLOW,
  );

  it(
    "runs as a child process and exits 2 without PayPal variables",
    () => {
      const child = spawnSync("node", ["--import", "tsx", entry], {
        cwd: repoRoot,
        env: { PATH: process.env.PATH ?? "" },
        encoding: "utf8",
      });
      expect(child.status).toBe(EXIT_CANT_RUN);
      expect(child.stderr).toContain("PAYPAL_CLIENT_ID");
    },
    SLOW,
  );
});
