import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createMemoryShipmentStore, createMockCarrier } from "@countersign/carrier-mock";
import { asc, auditLog, openPgliteDirectory, writeTicket } from "@countersign/db";
import { parseMandate } from "@countersign/mandate";
import { SANDBOX_BASE_URL } from "@countersign/rail-paypal";
import { describe, expect, it } from "vitest";
import { APPROVALS_USAGE, EXIT_CANT_RUN, EXIT_NOT_DONE, runApprovals } from "../src/approvals-cli";
import { APPROVAL_WINDOW_MS } from "../src/decide";
import { propose } from "../src/propose";
import { createFakeSandbox, type FakeSandbox } from "./fake-sandbox";
import { trackedTempDirs } from "./temp-dirs";

// The approvals CLI through runApprovals(), with PGlite directories, the fake sandbox and an
// injected clock. Step-ups come from a real decision on beat 5. Illustrative IDs and people.

const SLOW = 60_000;
const NOW = new Date("2026-10-17T09:00:00+03:00");
const LATER = new Date(NOW.getTime() + 5 * 60 * 1000);
const PAST_EXPIRY = new Date(NOW.getTime() + APPROVAL_WINDOW_MS + 1);
const SECRET = "fake-client-secret-not-real";
const ENV = {
  PAYPAL_BASE_URL: SANDBOX_BASE_URL,
  PAYPAL_CLIENT_ID: "fake-client-id",
  PAYPAL_CLIENT_SECRET: SECRET,
};
const PAYER = "wanjiru.m@example.com";
const entry = fileURLToPath(new URL("../src/approvals-main.ts", import.meta.url));
const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const usd = (minor: number) => ({ minor, currency: "USD" as const });

const parsedMandate = parseMandate(
  JSON.parse(
    readFileSync(
      fileURLToPath(
        new URL("../../../packages/mandate/fixtures/kikapu-studio-v3.json", import.meta.url),
      ),
      "utf8",
    ),
  ),
);
if (!parsedMandate.ok) throw new Error(parsedMandate.error);
const mandate = parsedMandate.mandate;

function world() {
  const rail = createFakeSandbox();
  const captureId = "CAP-1037";
  const capture = { id: captureId, status: "COMPLETED", amount: usd(24000), orderId: "ORD-1037" };
  rail.captures.set(captureId, capture);
  rail.orders.set("ORD-1037", {
    id: "ORD-1037",
    status: "COMPLETED",
    payerEmail: PAYER,
    payerId: "PAYER1037",
    purchaseUnits: [
      {
        referenceId: "KIK-1037",
        customId: null,
        invoiceId: null,
        amount: usd(24000),
        captures: [capture],
        trackers: [
          { id: `${captureId}-TRK1037`, captureId, trackingNumber: "TRK1037", status: "SHIPPED" },
        ],
        refunds: [],
      },
    ],
  });
  const shipments = new Map<string, unknown>([
    [
      "TRK1037",
      {
        trackingNumber: "TRK1037",
        carrierName: "Illustrative Post",
        status: "delivered",
        scanEvents: [{ at: "2026-10-02T08:00:00Z", description: "Accepted", place: "Nairobi" }],
        updatedAt: "2026-10-05T08:00:00Z",
      },
    ],
  ]);
  return { rail, carrier: createMockCarrier(createMemoryShipmentStore(shipments)) };
}

const makeDir = trackedTempDirs();

// A PGlite directory holding beat 5's step-up: its seq and intent hash.
async function withStepUp(): Promise<{
  dir: string;
  seq: number;
  hash: string;
  rail: FakeSandbox;
}> {
  const dir = makeDir("approvals-cli-");
  const handle = await openPgliteDirectory(dir);
  try {
    await writeTicket(handle.db, {
      id: "TKT-1037",
      channel: "email",
      senderEmail: PAYER,
      senderPhone: null,
      subject: null,
      body: "Simulated ticket.",
      attachments: [{ id: "ATT-TKT-1037", contentType: "image/jpeg" }],
      receivedAt: "2026-10-17T08:00:00+03:00",
      simulated: true,
    });
    const w = world();
    const result = await propose({
      mandate,
      principal: "support-agent",
      proposal: {
        tool: "create_refund",
        args: { capture_id: "CAP-1037", amount: { value: "240.00", currency_code: "USD" } },
        justification: { ticket_id: "TKT-1037", claim: "damaged" },
      },
      now: NOW,
      ...w,
      db: handle.db,
      clock: () => NOW,
    });
    if (!result.ok || result.replay || result.record.intentHash === null) {
      throw new Error("not decided");
    }
    expect(result.record.decision).toBe("step_up");
    return { dir, seq: result.seqs.decision, hash: result.record.intentHash, rail: w.rail };
  } finally {
    await handle.close();
  }
}

async function approvalChannels(dir: string): Promise<string[]> {
  const handle = await openPgliteDirectory(dir);
  try {
    const rows = await handle.db.select().from(auditLog).orderBy(asc(auditLog.seq));
    return rows
      .filter((row) => row.entryType === "approval")
      .map((row) => JSON.parse(row.payload).channel);
  } finally {
    await handle.close();
  }
}

async function entryCount(dir: string): Promise<number> {
  const handle = await openPgliteDirectory(dir);
  try {
    return (await handle.db.select().from(auditLog)).length;
  } finally {
    await handle.close();
  }
}

const run = (
  args: string[],
  dir: string,
  rail: FakeSandbox,
  now: Date = LATER,
  env: Record<string, string> = ENV,
) => runApprovals([...args, "--pglite", dir], env, { rail, now: () => now, mandates: [mandate] });

describe("approvals CLI", { timeout: SLOW }, () => {
  it(
    "lists the open card with its reasons in words and codes, then approves it with the hash",
    async () => {
      const { dir, seq, hash, rail } = await withStepUp();

      const list = await run(["list"], dir, rail);
      expect(list.exitCode).toBe(0);
      expect(list.stdout).toContain("1 open card");
      expect(list.stdout).toContain(`${seq}  Refund $240.00`);
      expect(list.stdout).toContain("Expires in 10 min");
      expect(list.stdout).toMatch(/\([A-Z_]+\)/);

      const approve = await run(["approve", String(seq), "--hash", hash], dir, rail);
      expect(approve.exitCode).toBe(0);
      expect(approve.stdout).toMatch(/^Approved\. Refund \S+ is done\.\n$/);
      expect(rail.calls.filter((call) => call.call === "refundCapture")).toHaveLength(1);
      expect(await approvalChannels(dir)).toEqual(["cli"]);

      const after = await run(["list"], dir, rail);
      expect(after.stdout).toContain("No open cards.");
      expect(after.stdout).toContain("approved");
    },
    SLOW,
  );

  it(
    "shows one card, and prints answers as JSON with --json",
    async () => {
      const { dir, seq, hash, rail } = await withStepUp();

      const show = await run(["show", String(seq)], dir, rail);
      expect(show.exitCode).toBe(0);
      expect(show.stdout).toContain("Refund $240.00");
      expect(show.stdout).toContain(hash);
      expect(show.stdout).toContain("Why it's waiting");
      expect(show.stdout).toContain("What the records say");

      const card = JSON.parse((await run(["show", String(seq), "--json"], dir, rail)).stdout);
      expect(card.intent_hash).toBe(hash);
      const list = JSON.parse((await run(["list", "--json"], dir, rail)).stdout);
      expect(list.open).toHaveLength(1);

      const answer = await run(["approve", String(seq), "--hash", hash, "--json"], dir, rail);
      expect(answer.exitCode).toBe(0);
      const body = JSON.parse(answer.stdout);
      expect(body.outcome).toBe("approved");
      expect(body.execution.outcome).toBe("executed");
      expect(body.execution.refund.status).toBe("COMPLETED");
    },
    SLOW,
  );

  it(
    "denies without PayPal variables and without a rail call",
    async () => {
      const { dir, seq, rail } = await withStepUp();
      const deny = await run(["deny", String(seq)], dir, rail, LATER, {});
      expect(deny.exitCode).toBe(0);
      expect(deny.stdout).toBe("Denied. Nothing was sent.\n");
      expect(rail.calls.filter((call) => call.call === "refundCapture")).toHaveLength(0);
      expect(await approvalChannels(dir)).toEqual(["cli"]);
    },
    SLOW,
  );

  it(
    "exits 1 on a rejection, names the code and sends nothing",
    async () => {
      const { dir, seq, hash, rail } = await withStepUp();

      const wrong = await run(["approve", String(seq), "--hash", "0".repeat(64)], dir, rail);
      expect(wrong.exitCode).toBe(EXIT_NOT_DONE);
      expect(wrong.stdout).toContain("This card changed. Nothing was sent.");
      expect(wrong.stdout).toContain("HASH_MISMATCH");

      const late = await run(["approve", String(seq), "--hash", hash], dir, rail, PAST_EXPIRY);
      expect(late.exitCode).toBe(EXIT_NOT_DONE);
      expect(late.stdout).toContain("EXPIRED");
      expect(rail.calls.filter((call) => call.call === "refundCapture")).toHaveLength(0);

      const json = JSON.parse(
        (await run(["approve", String(seq), "--hash", hash, "--json"], dir, rail, PAST_EXPIRY))
          .stdout,
      );
      expect(json.outcome).toBe("rejected");
      expect(json.code).toBe("EXPIRED");
    },
    SLOW,
  );

  it(
    "exits 2 for an unknown ID, a missing hash, bad arguments and missing PayPal variables, naming them",
    async () => {
      const { dir, seq, hash, rail } = await withStepUp();
      const before = await entryCount(dir);

      const unknown = await run(["show", "999"], dir, rail);
      expect(unknown.exitCode).toBe(EXIT_CANT_RUN);
      expect(unknown.stderr).toContain("no step-up");
      expect((await run(["deny", "999"], dir, rail)).exitCode).toBe(EXIT_CANT_RUN);
      expect((await run(["approve", "999", "--hash", hash], dir, rail)).exitCode).toBe(
        EXIT_CANT_RUN,
      );

      const noHash = await run(["approve", String(seq)], dir, rail);
      expect(noHash.exitCode).toBe(EXIT_CANT_RUN);
      expect(noHash.stderr).toContain(APPROVALS_USAGE);
      expect((await run(["frobnicate"], dir, rail)).exitCode).toBe(EXIT_CANT_RUN);
      expect((await run(["show", "abc"], dir, rail)).exitCode).toBe(EXIT_CANT_RUN);
      expect((await run(["list", "--bogus"], dir, rail)).exitCode).toBe(EXIT_CANT_RUN);

      const noEnv = await run(["approve", String(seq), "--hash", hash], dir, rail, LATER, {
        PAYPAL_CLIENT_SECRET: SECRET,
      });
      expect(noEnv.exitCode).toBe(EXIT_CANT_RUN);
      expect(noEnv.stderr).toContain("PAYPAL_CLIENT_ID");
      expect(noEnv.stderr).not.toContain(SECRET);

      expect(await entryCount(dir)).toBe(before);
    },
    SLOW,
  );

  it(
    "runs as a child process and exits 2 when approving without PayPal variables",
    () => {
      const child = spawnSync("node", ["--import", "tsx", entry, "approve", "1", "--hash", "a"], {
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
