import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createDatabaseShipmentStore, createMockCarrier } from "@countersign/carrier-mock";
import { asc, auditLog, type Database, openPgliteDirectory } from "@countersign/db";
import { runLedgerCli } from "@countersign/ledger";
import {
  createPayPalClient,
  PAYPAL_ENV_NAMES,
  type PayPalClient,
  PayPalError,
  SANDBOX_BASE_URL,
} from "@countersign/rail-paypal";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { EXIT_MATCHED, runAgent } from "../src/agent-cli";
import { createApp } from "../src/app";
import { APPROVER_KEY_VAR } from "../src/approver";
import { ExecutionResultPayloadSchema, ReconciliationPayloadSchema } from "../src/execution-log";
import {
  loadPrincipals,
  OPS_AGENT_KEY_VAR,
  type PrincipalName,
  readPrincipalMandate,
} from "../src/principals";
import { EXIT_RECONCILED, runReconcile } from "../src/reconcile-cli";
import { createFakeSandbox } from "./fake-sandbox";
import { trackedTempDirs } from "./temp-dirs";

// A supplier payout end to end, as the README's "Pay a supplier" runs it: the ops agent proposes
// from ops-payouts.json over a listening gate, the merchant approves the card through the
// approval API, the gate sends the payout once, and `npm run reconcile` reads its item until it
// reconciles. `npm test` runs it against the fake sandbox. Under LIVE=1 with the PayPal variables
// it runs once against the PayPal sandbox, with a fresh bill reference. The keys are made-up test
// keys; nothing here prints a secret. Illustrative suppliers.

const SLOW = 120_000;
const OPS_KEY = "test-ops-agent-key-0123456789abcdef0123";
const APPROVER_KEY = "test-approver-key-0123456789abcdef01234";
const GATE_ENV = { [OPS_AGENT_KEY_VAR]: OPS_KEY, [APPROVER_KEY_VAR]: APPROVER_KEY };
const AGENT_ENV = { [OPS_AGENT_KEY_VAR]: OPS_KEY };
const PAYEE = "dyeworks@example.com";

const opsPayouts = fileURLToPath(new URL("../proposals/ops-payouts.json", import.meta.url));
const tempDir = trackedTempDirs();

const present = z.string().min(1);
const LiveEnvSchema = z.object({
  LIVE: z.literal("1"),
  PAYPAL_BASE_URL: present,
  PAYPAL_CLIENT_ID: present,
  PAYPAL_CLIENT_SECRET: present,
  PAYPAL_LIVE_PAYEE_EMAIL: z.email().optional(),
});
const live = LiveEnvSchema.safeParse(process.env);
const needs = `needs ${["LIVE=1", ...PAYPAL_ENV_NAMES].join(", ")}`;

const CardSchema = z.object({
  step_up_id: z.number().int(),
  intent_id: z.string(),
  intent_hash: z.string(),
  action: z.string(),
  params: z.object({ kind: z.string(), reference: z.string().nullable() }).nullable(),
});
const ListSchema = z.object({ open: z.array(CardSchema) });

type Run = {
  rail: PayPalClient;
  clock: () => Date;
  // The proposals file the agent runs.
  file: string;
  // The bill the card should show, and the ops mandate the gate decides with.
  reference: string;
  readMandate?: (name: PrincipalName) => unknown;
  // Run between approving and reconciling, for the fake sandbox to move the item on.
  beforeReconcile?: () => void;
  // Reconcile again (live only) until the item is in one of these statuses.
  settled: readonly string[];
  attempts: number;
};

async function listen(run: Run, db: Database) {
  const server: Server = createApp({
    db,
    rail: () => run.rail,
    carrier: createMockCarrier(createDatabaseShipmentStore(db)),
    env: GATE_ENV,
    clock: run.clock,
    principals: loadPrincipals({
      env: GATE_ENV,
      ...(run.readMandate ? { readMandate: run.readMandate } : {}),
    }),
  }).listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const { port } = server.address() as AddressInfo;
  return { server, url: `http://127.0.0.1:${port}` };
}

async function readLog(dir: string) {
  const handle = await openPgliteDirectory(dir);
  try {
    return await handle.db.select().from(auditLog).orderBy(asc(auditLog.seq));
  } finally {
    await handle.close();
  }
}

// The item status the log knows last: the latest payout reconciliation's, else the result's.
function latestStatus(rows: Awaited<ReturnType<typeof readLog>>): string | null {
  let status: string | null = null;
  for (const row of rows) {
    if (row.entryType === "execution.result") {
      const payload = ExecutionResultPayloadSchema.parse(JSON.parse(row.payload));
      status = ("payout" in payload ? payload.payout?.item?.status : null) ?? null;
    }
    if (row.entryType === "reconciliation") {
      const payload = ReconciliationPayloadSchema.parse(JSON.parse(row.payload));
      if ("payout" in payload && payload.payout) status = payload.payout.status;
    }
  }
  return status;
}

// Proposes, approves and reconciles one payout, and answers the intent and the reconcile output.
async function payASupplier(run: Run) {
  const dir = tempDir("payouts-live-");
  const handle = await openPgliteDirectory(dir);
  const { server, url } = await listen(run, handle.db);
  let intentId: string;
  try {
    const proposed = await runAgent([run.file, "--url", `${url}/mcp`], AGENT_ENV, {
      db: handle.db,
      now: run.clock,
    });
    expect(proposed.stderr).toBe("");
    expect(proposed.exitCode).toBe(EXIT_MATCHED);
    expect(proposed.stdout).toContain("as ops-agent");
    expect(proposed.stdout).not.toContain(OPS_KEY);

    const headers = { Authorization: `Bearer ${APPROVER_KEY}` };
    const list = ListSchema.parse(await (await fetch(`${url}/approvals`, { headers })).json());
    expect(list.open).toHaveLength(1);
    const [card] = list.open;
    if (!card) throw new Error("No card.");
    expect(card.action).toBe("paypal.payout");
    expect(card.params).toMatchObject({ kind: "payout", reference: run.reference });
    intentId = card.intent_id;

    const res = await fetch(`${url}/approvals/${card.step_up_id}`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ answer: "approve", intent_hash: card.intent_hash }),
    });
    const text = await res.text();
    expect(res.status).toBe(200);
    expect(text).not.toContain(APPROVER_KEY);
    const answer = z
      .object({ execution: z.object({ outcome: z.string() }).nullable() })
      .parse(JSON.parse(text));
    expect(answer.execution?.outcome).toBe("executed");
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await handle.close();
  }

  run.beforeReconcile?.();
  const reconcileEnv = {
    PAYPAL_BASE_URL: SANDBOX_BASE_URL,
    PAYPAL_CLIENT_ID: "unused-with-a-rail",
    PAYPAL_CLIENT_SECRET: "unused-with-a-rail",
  };
  const outputs: string[] = [];
  for (let attempt = 1; attempt <= run.attempts; attempt += 1) {
    const reconciled = await runReconcile(["--pglite", dir], reconcileEnv, {
      rail: run.rail,
      now: run.clock,
    });
    expect(reconciled.stderr).toBe("");
    expect(reconciled.exitCode).toBe(EXIT_RECONCILED);
    outputs.push(reconciled.stdout);
    const status = latestStatus(await readLog(dir));
    if (status !== null && run.settled.includes(status)) break;
    if (attempt < run.attempts) await new Promise((resolve) => setTimeout(resolve, 3_000));
  }

  const rows = await readLog(dir);
  const verify = await runLedgerCli(["verify", "--pglite", dir], {});
  expect(verify.exitCode).toBe(0);
  return { intentId, rows, outputs };
}

describe("a supplier payout from ops-payouts.json against the fake sandbox", () => {
  it(
    "steps up, is approved and sent once, then reconciles to SUCCESS",
    async () => {
      const rail = createFakeSandbox();
      const NOW = new Date("2026-10-17T09:00:00+03:00");
      const { intentId, rows, outputs } = await payASupplier({
        rail,
        clock: () => NOW,
        file: opsPayouts,
        reference: "KDW-2026-0412",
        beforeReconcile: () => {
          for (const [id, item] of rail.payoutItems) {
            rail.payoutItems.set(id, { ...item, status: "SUCCESS" });
          }
        },
        settled: ["SUCCESS"],
        attempts: 1,
      });

      // Sent once, exactly as the card showed it.
      expect(rail.payoutsSent).toHaveLength(1);
      expect(rail.payoutsSent[0]).toMatchObject({
        senderBatchId: intentId,
        receiver: PAYEE,
        amount: { minor: 4500, currency: "USD" },
        senderItemId: "KDW-2026-0412",
        note: "Dye for the October batch.",
      });

      const types = rows.map((row) => row.entryType);
      expect(types.filter((type) => type === "execution.requested")).toHaveLength(1);
      const result = rows.find((row) => row.entryType === "execution.result");
      expect(ExecutionResultPayloadSchema.parse(JSON.parse(result?.payload ?? "{}"))).toMatchObject(
        {
          outcome: "executed",
          payout: {
            batchId: "FAKEBATCH0001",
            batchStatus: "PENDING",
            item: { id: "FAKEITEM0001", status: "UNCLAIMED" },
          },
        },
      );
      const reconciliations = rows.filter((row) => row.entryType === "reconciliation");
      expect(reconciliations).toHaveLength(1);
      expect(reconciliations[0]?.refId).toBe(intentId);
      expect(
        ReconciliationPayloadSchema.parse(JSON.parse(reconciliations[0]?.payload ?? "{}")),
      ).toEqual({
        source: "poll",
        payout: {
          batchId: "FAKEBATCH0001",
          itemId: "FAKEITEM0001",
          status: "SUCCESS",
          amount: { minor: 4500, currency: "USD" },
        },
        resultSeq: result?.seq,
      });
      expect(outputs.join("")).toContain(`Payout ${intentId} to ${PAYEE}: SUCCESS.`);
    },
    SLOW,
  );
});

describe.skipIf(!live.success)(`live payouts (${needs})`, { timeout: SLOW * 3 }, () => {
  it("steps up the ops agent's payout, approves it, sends it once and reconciles it", async () => {
    if (!live.success) return;
    try {
      const runId = randomBytes(5).toString("hex");
      const reference = `KDW-LIVE-${runId}`;
      const payee = live.data.PAYPAL_LIVE_PAYEE_EMAIL?.trim().toLowerCase() ?? PAYEE;

      // One $1.00 payout with a fresh bill, so each run is a new intent and a new batch.
      const file = JSON.parse(readFileSync(opsPayouts, "utf8"));
      const [first] = file.proposals;
      first.args = {
        ...first.args,
        receiver: payee,
        amount: { value: "1.00", currency_code: "USD" },
        reference,
      };
      file.proposals = [first];
      delete file.mandate;
      const path = join(tempDir("payouts-live-file-"), "ops-payouts.json");
      writeFileSync(path, JSON.stringify(file));

      // A sandbox personal account is added to a copy of the ops mandate's payee list, so a run
      // with one can end SUCCESS. Without one, the listed example.com supplier ends UNCLAIMED.
      const readMandate = (name: PrincipalName) => {
        const mandate = readPrincipalMandate(name) as {
          payees?: { email: string; name: string }[];
        };
        if (name !== "ops-agent" || payee === PAYEE) return mandate;
        return {
          ...mandate,
          payees: [
            ...(mandate.payees ?? []),
            { email: payee, name: "Live sandbox payee (illustrative)" },
          ],
        };
      };

      const rail = createPayPalClient({ env: process.env });
      const { intentId, rows, outputs } = await payASupplier({
        rail,
        clock: () => new Date(),
        file: path,
        reference,
        readMandate,
        settled: ["UNCLAIMED", "SUCCESS"],
        attempts: 10,
      });

      const types = rows.map((row) => row.entryType);
      expect(types.filter((type) => type === "execution.requested")).toHaveLength(1);
      expect(types.filter((type) => type === "execution.result")).toHaveLength(1);
      expect(["UNCLAIMED", "SUCCESS"]).toContain(latestStatus(rows));
      expect(outputs.join("")).toContain(`Payout ${intentId} to ${payee}: `);
    } catch (error) {
      if (error instanceof Error && error.name === "AssertionError") throw error;
      if (error instanceof PayPalError) throw new Error(error.message);
      throw new Error(
        `Live check failed with ${error instanceof Error ? error.name : "a non-error"}.`,
      );
    }
  });
});
