import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createDatabaseShipmentStore } from "@countersign/carrier-mock";
import { openPgliteDirectory, readTicket, seedOrders, sql, writeTicket } from "@countersign/db";
import { runLedgerCli } from "@countersign/ledger";
import { REASONS, type ShipmentStatus } from "@countersign/mandate";
import { SANDBOX_BASE_URL } from "@countersign/rail-paypal";
import { describe, expect, it } from "vitest";
import { AgentResponseSchema } from "../src/decide";
import {
  EXIT_CANT_RUN,
  EXIT_DIFFERED,
  EXIT_MATCHED,
  PROPOSE_USAGE,
  runPropose,
} from "../src/propose-cli";
import { createFakeSandbox, type FakeSandbox, httpError } from "./fake-sandbox";

// Each PGlite start takes a couple of seconds.
const SLOW = 60_000;
const NOW = new Date("2026-10-17T09:00:00+03:00");

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const proposalsDir = fileURLToPath(new URL("../proposals/", import.meta.url));
const beat3 = join(proposalsDir, "beat-3-attack-email.json");
const beat4 = join(proposalsDir, "beat-4-stalled-parcel.json");
const beat5 = join(proposalsDir, "beat-5-damaged.json");
const entry = fileURLToPath(new URL("../src/propose-main.ts", import.meta.url));

// Fake values: the rail client is the fake sandbox, but the CLI still requires the variables.
const SECRET = "fake-client-secret-not-real";
const ENV = {
  PAYPAL_BASE_URL: SANDBOX_BASE_URL,
  PAYPAL_CLIENT_ID: "fake-client-id",
  PAYPAL_CLIENT_SECRET: SECRET,
};

const BUYER_EMAIL = { A: "amina.k@example.com", B: "grace.w@example.com" } as const;
const usd = (minor: number) => ({ minor, currency: "USD" as const });

// The seed catalog's demo orders the proposal files use: buyer, price and shipment status.
type SeededOrder = { n: number; buyer: "A" | "B"; minor: number; status: ShipmentStatus };
const SEEDED: readonly SeededOrder[] = [
  { n: 1035, buyer: "A", minor: 1800, status: "stalled_10d" },
  { n: 1037, buyer: "A", minor: 24000, status: "delivered" },
  { n: 1038, buyer: "B", minor: 4800, status: "delivered" },
  { n: 1039, buyer: "B", minor: 3600, status: "delivered" },
  { n: 1040, buyer: "B", minor: 2400, status: "in_transit" },
  { n: 1041, buyer: "B", minor: 1800, status: "delivered" },
  { n: 1042, buyer: "A", minor: 4800, status: "delivered" },
];

const tempDir = (prefix: string) => mkdtempSync(join(tmpdir(), prefix));

// A PGlite directory as `npm run seed` leaves it, and a fake sandbox holding the same orders.
async function seededWorld(
  orders: readonly SeededOrder[] = SEEDED,
): Promise<{ dir: string; rail: FakeSandbox }> {
  const dir = tempDir("propose-cli-");
  const rail = createFakeSandbox();
  const handle = await openPgliteDirectory(dir);
  try {
    const store = createDatabaseShipmentStore(handle.db);
    for (const { n, buyer, minor, status } of orders) {
      const captureId = `CAP${n}`;
      const orderId = `ORD${n}`;
      const trackingNumber = `KC-run1-${n}`;
      const payerEmail = BUYER_EMAIL[buyer];
      await handle.db.insert(seedOrders).values({
        orderNumber: `KIK-${n}`,
        runId: "run1",
        paypalOrderId: orderId,
        paypalCaptureId: captureId,
        amountMinor: minor,
        currency: "USD",
        payerEmail,
        buyer,
        trackingNumber,
        role: "demo",
        seededAt: "2026-10-01T08:00:00Z",
      });
      await store.write({
        trackingNumber,
        carrierName: "Illustrative Post",
        status,
        scanEvents: [{ at: "2026-10-02T08:00:00Z", description: "Picked up", place: "Kisumu" }],
        updatedAt: "2026-10-05T08:00:00Z",
      });
      const capture = { id: captureId, status: "COMPLETED", amount: usd(minor), orderId };
      rail.captures.set(captureId, capture);
      rail.orders.set(orderId, {
        id: orderId,
        status: "COMPLETED",
        payerEmail,
        payerId: `PAYER${buyer}`,
        purchaseUnits: [
          {
            referenceId: `KIK-${n}`,
            customId: null,
            invoiceId: null,
            amount: usd(minor),
            captures: [capture],
            trackers: [
              {
                id: `${captureId}-${trackingNumber}`,
                captureId,
                trackingNumber,
                status: "SHIPPED",
              },
            ],
            refunds: [],
          },
        ],
      });
    }
  } finally {
    await handle.close();
  }
  return { dir, rail };
}

const options = (rail: FakeSandbox) => ({ rail, now: () => NOW, clock: () => NOW });

function blocks(stdout: string): string[] {
  return stdout.split(/\n(?=Proposal \d+ of \d+\n)/).slice(1);
}

function proposalFile(contents: unknown): string {
  const folder = tempDir("propose-file-");
  const path = join(folder, "proposals.json");
  writeFileSync(path, JSON.stringify(contents));
  return path;
}

const beat4File = () => JSON.parse(readFileSync(beat4, "utf8"));

// A copy of a demo file kept next to the original's mandate path.
function variant(original: unknown, change: (file: Record<string, unknown>) => void): string {
  const file = structuredClone(original) as Record<string, unknown>;
  file.mandate = join(repoRoot, "packages/mandate/fixtures/kikapu-studio-v3.json");
  change(file);
  return proposalFile(file);
}

const verify = (dir: string) => runLedgerCli(["verify", "--pglite", dir], {});

describe("npm run propose on the demo files", { timeout: SLOW }, () => {
  it("beat 4 is allowed, executes once, and a second run is a replay with no new refund", async () => {
    const { dir, rail } = await seededWorld();
    const first = await runPropose([beat4, "--pglite", dir], ENV, options(rail));
    expect(first.stderr).toBe("");
    expect(first.exitCode).toBe(EXIT_MATCHED);
    const [block = ""] = blocks(first.stdout);
    expect(block).toContain("  Decision  Allow\n");
    expect(block).toContain("  Amount    $18.00 on capture CAP1035\n");
    expect(block).toContain(
      `  For       KIK-1035, ticket TKT-1035 from ${BUYER_EMAIL.A} (simulated)\n`,
    );
    expect(block).toMatch(/ {2}Intent {4}int_[0-9a-z]+/);
    expect(block).toMatch(/ {2}Hash {6}[0-9a-f]{64}\n/);
    expect(block).toContain("  Verifier trace\n");
    expect(block).toContain("  Outcome   executed\n");
    expect(block).toContain("  Refund    FAKEREFUND000001 COMPLETED\n");
    expect(block).not.toContain("Replayed, no new refund.");
    const sent = rail.calls.filter((call) => call.call === "refundCapture");
    expect(sent).toHaveLength(1);
    expect(sent[0]?.arg).toMatchObject({ captureId: "CAP1035", amount: usd(1800) });

    const second = await runPropose([beat4, "--pglite", dir], ENV, options(rail));
    expect(second.exitCode).toBe(EXIT_MATCHED);
    const [again = ""] = blocks(second.stdout);
    expect(again).toContain("  Decision  Allow\n");
    expect(again).toContain("  Replayed, no new refund.\n");
    expect(again).toContain("  Refund    FAKEREFUND000001 COMPLETED\n");
    expect(rail.calls.filter((call) => call.call === "refundCapture")).toHaveLength(1);
    expect((await verify(dir)).exitCode).toBe(0);

    // The file's ticket is in the store, labelled simulated, and the second run kept it.
    const handle = await openPgliteDirectory(dir);
    try {
      expect(await readTicket(handle.db, "TKT-1035")).toMatchObject({
        id: "TKT-1035",
        senderEmail: BUYER_EMAIL.A,
        attachments: [],
        simulated: true,
      });
    } finally {
      await handle.close();
    }
  });

  // KIK-1040 is in transit in the seed catalog, so no rule covers it: denied before the payer
  // is checked.
  it("beat 3 denies the four orders the sender didn't pay for and steps up KIK-1042", async () => {
    const { dir, rail } = await seededWorld();
    const result = await runPropose([beat3, "--pglite", dir], ENV, options(rail));
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(EXIT_MATCHED);
    const proposalBlocks = blocks(result.stdout);
    expect(proposalBlocks).toHaveLength(5);
    const denied = (code: string) =>
      proposalBlocks.filter(
        (block) =>
          block.includes("  Decision  Deny\n") &&
          block.includes(`(${code})\n`) &&
          block.includes("  Execution None, nothing was sent\n"),
      );
    expect(denied("TICKET_NOT_FROM_PAYER")).toHaveLength(3);
    expect(denied("NO_MATCHING_RULE")).toHaveLength(1);
    expect(proposalBlocks[2]).toContain("(NO_MATCHING_RULE)\n");
    const held = proposalBlocks[4] ?? "";
    expect(held).toContain("  Decision  Step-up\n");
    expect(held).toContain(`    ${REASONS.SHIPMENT_DELIVERED.words} (SHIPMENT_DELIVERED)\n`);
    expect(result.stdout).not.toContain("Expected ");
    expect(rail.calls.filter((call) => call.call === "refundCapture")).toHaveLength(0);
  });

  it("beat 5 steps up for ABOVE_AUTO_LIMIT and sends nothing", async () => {
    const { dir, rail } = await seededWorld();
    const result = await runPropose([beat5, "--pglite", dir], ENV, options(rail));
    expect(result.exitCode).toBe(EXIT_MATCHED);
    const [block = ""] = blocks(result.stdout);
    expect(block).toContain("  Decision  Step-up\n");
    expect(block).toContain("(ABOVE_AUTO_LIMIT)\n");
    expect(rail.calls.filter((call) => call.call === "refundCapture")).toHaveLength(0);
  });

  it("--json prints each response with its outcome and refund ID", async () => {
    const { dir, rail } = await seededWorld();
    const result = await runPropose([beat4, "--json", "--pglite", dir], ENV, options(rail));
    expect(result.exitCode).toBe(EXIT_MATCHED);
    expect(result.stderr).toBe("");
    const [first] = JSON.parse(result.stdout);
    expect(AgentResponseSchema.parse(first.response).decision).toBe("allowed");
    expect(first.execution).toEqual({
      outcome: "executed",
      refund_id: "FAKEREFUND000001",
      refund_status: "COMPLETED",
      new_refund: true,
    });
    const again = await runPropose([beat4, "--json", "--pglite", dir], ENV, options(rail));
    expect(JSON.parse(again.stdout)[0].execution).toMatchObject({
      outcome: "executed",
      refund_id: "FAKEREFUND000001",
      new_refund: false,
    });
    const held = await runPropose([beat5, "--json", "--pglite", dir], ENV, options(rail));
    const [stepUp] = JSON.parse(held.stdout);
    expect(stepUp.response.decision).toBe("pending_approval");
    expect(stepUp.execution).toBeNull();
  });
});

describe("npm run propose when the result isn't the expected one", { timeout: SLOW }, () => {
  it("prints Expected … got … and exits 1", async () => {
    const { dir, rail } = await seededWorld();
    const path = variant(beat4File(), (file) => {
      const [proposal] = file.proposals as { expect: unknown }[];
      if (proposal) proposal.expect = { decision: "deny", reasons: ["TICKET_NOT_FROM_PAYER"] };
    });
    const result = await runPropose([path, "--pglite", dir], ENV, options(rail));
    expect(result.exitCode).toBe(EXIT_DIFFERED);
    expect(result.stdout).toContain("  Expected deny TICKET_NOT_FROM_PAYER, got allow.\n");
    expect(result.stdout).toContain("1 proposal differed from the file.\n");
  });

  it("exits 1 when the refund's outcome is unknown", async () => {
    const { dir, rail } = await seededWorld();
    rail.failures.refundCapture = httpError("refund-capture", 503);
    const result = await runPropose([beat4, "--pglite", dir], ENV, options(rail));
    expect(result.exitCode).toBe(EXIT_DIFFERED);
    expect(result.stdout).toContain("  Outcome   unknown\n");
    expect(result.stdout).toContain("1 refund with an unknown outcome. Run npm run reconcile.\n");
    expect(result.stdout).not.toContain("Expected ");
  });

  it("prints each read problem on its own line", async () => {
    const { dir, rail } = await seededWorld();
    rail.failures.listDisputes = httpError("list-disputes", 500);
    const result = await runPropose([beat4, "--pglite", dir], ENV, options(rail));
    const [block = ""] = blocks(result.stdout);
    expect(block).toMatch(/\n {2}Read problem {2}list-disputes: [^\n]+\n/);
    expect(block).toContain("  Expected allow, got deny DISPUTES_UNKNOWN.\n");
    expect(result.exitCode).toBe(EXIT_DIFFERED);
  });
});

describe("npm run propose when it can't run", { timeout: SLOW }, () => {
  it("exits 2 for an order that isn't seeded, before anything is written", async () => {
    const { dir, rail } = await seededWorld(SEEDED.filter(({ n }) => n !== 1035));
    const result = await runPropose([beat4, "--pglite", dir], ENV, options(rail));
    expect(result).toEqual({
      exitCode: EXIT_CANT_RUN,
      stdout: "",
      stderr: "Order KIK-1035 isn't seeded. Run npm run seed first.\n",
    });
    expect((await verify(dir)).stdout).toContain("0 entries");
    expect(rail.calls).toHaveLength(0);
  });

  it("exits 2 for a buyer with no seeded orders", async () => {
    const { dir, rail } = await seededWorld(SEEDED.filter(({ buyer }) => buyer === "B"));
    const path = variant(beat4File(), (file) => {
      const [proposal] = file.proposals as { order: string; ticket: { sender: string } }[];
      if (proposal) {
        proposal.order = "KIK-1038";
        proposal.ticket.sender = "buyer:A";
      }
    });
    const result = await runPropose([path, "--pglite", dir], ENV, options(rail));
    expect(result.exitCode).toBe(EXIT_CANT_RUN);
    expect(result.stderr).toBe("Buyer A isn't seeded. Run npm run seed first.\n");
  });

  it("exits 2 when a file ticket is already stored with another sender, deciding nothing", async () => {
    const { dir, rail } = await seededWorld();
    const handle = await openPgliteDirectory(dir);
    await writeTicket(handle.db, {
      id: "TKT-1035",
      channel: "email",
      senderEmail: "someone.else@example.com",
      senderPhone: null,
      subject: null,
      body: "Simulated ticket.",
      attachments: [],
      receivedAt: "2026-10-17T08:00:00+03:00",
      simulated: true,
    });
    await handle.close();
    const result = await runPropose([beat4, "--pglite", dir], ENV, options(rail));
    expect(result.exitCode).toBe(EXIT_CANT_RUN);
    expect(result.stderr).toBe(
      "Ticket TKT-1035 is already stored with another sender or attachments.\n",
    );
    expect((await verify(dir)).stdout).toContain("0 entries");
    expect(rail.calls).toHaveLength(0);
  });

  it("exits 2 for a proposal file that fails validation", async () => {
    const path = variant(beat4File(), (file) => {
      const [proposal] = file.proposals as Record<string, unknown>[];
      if (proposal) proposal.order = "1035";
    });
    const result = await runPropose([path], ENV, {});
    expect(result.exitCode).toBe(EXIT_CANT_RUN);
    expect(result.stderr).toMatch(/^Proposal file[^\n]*\n$/);
  });

  it("exits 2 naming the missing PayPal variables, never showing a value", async () => {
    const result = await runPropose([beat4], { PAYPAL_CLIENT_SECRET: SECRET }, {});
    expect(result.exitCode).toBe(EXIT_CANT_RUN);
    expect(result.stderr).toBe(
      "The propose CLI can't start. Set PAYPAL_BASE_URL, PAYPAL_CLIENT_ID in .env.local.\n",
    );
    expect(result.stderr).not.toContain(SECRET);
  });

  it("exits 2 on an unreachable DATABASE_URL and never shows it", async () => {
    const url = "postgres://countersign:pw-not-real@127.0.0.1:1/countersign";
    const result = await runPropose([beat4], { ...ENV, DATABASE_URL: url }, {});
    expect(result.exitCode).toBe(EXIT_CANT_RUN);
    expect(result.stderr).toMatch(/^Couldn't open the database at DATABASE_URL: .+\n$/);
    expect(result.stderr).not.toContain("pw-not-real");
  });

  it("exits 2 on a database with no audit_log table", async () => {
    const { dir, rail } = await seededWorld();
    const handle = await openPgliteDirectory(dir);
    await handle.db.execute(sql`DROP TABLE audit_log`);
    await handle.close();
    const result = await runPropose([beat4, "--pglite", dir], ENV, options(rail));
    expect(result.exitCode).toBe(EXIT_CANT_RUN);
    expect(result.stderr).toBe(
      `The database at ${dir} has no audit_log table. Run npm run db:migrate first.\n`,
    );
  });

  it("exits 2 with the usage for no file or an unknown option", async () => {
    expect((await runPropose([], ENV, {})).stderr).toBe(`${PROPOSE_USAGE}\n`);
    expect((await runPropose([beat4, "--live"], ENV, {})).stderr).toBe(
      `Unknown option --live. ${PROPOSE_USAGE}\n`,
    );
  });

  it("exits 2 as a child process when the PayPal variables are missing", () => {
    const child = spawnSync(process.execPath, ["--import", "tsx", entry, beat4], {
      cwd: repoRoot,
      encoding: "utf8",
      env: { PATH: process.env.PATH ?? "" },
    });
    expect(child.status).toBe(EXIT_CANT_RUN);
    expect(child.stdout).toBe("");
    expect(child.stderr).toBe(
      "The propose CLI can't start. Set PAYPAL_BASE_URL, PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET in .env.local.\n",
    );
  });
});
