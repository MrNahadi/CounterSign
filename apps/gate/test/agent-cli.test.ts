import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createDatabaseShipmentStore, createMockCarrier } from "@countersign/carrier-mock";
import {
  auditLog,
  type DatabaseHandle,
  openPgliteDirectory,
  readTicket,
  seedOrders,
} from "@countersign/db";
import type { ShipmentStatus } from "@countersign/mandate";
import { afterEach, describe, expect, it } from "vitest";
import {
  AGENT_USAGE,
  EXIT_CANT_RUN,
  EXIT_DIFFERED,
  EXIT_MATCHED,
  runAgent,
} from "../src/agent-cli";
import { createApp } from "../src/app";
import { AgentResponseSchema } from "../src/decide";
import { createFakeSandbox, type FakeSandbox } from "./fake-sandbox";
import { trackedTempDirs } from "./temp-dirs";

// The stand-in agent against a listening gate over real HTTP and MCP, sharing one PGlite store.
// Illustrative orders and people in PayPal's sandbox shapes; made-up principal keys.

const SLOW = 60_000;
const NOW = new Date("2026-10-17T09:00:00+03:00");
const KEY = "test-support-agent-key-0123456789abcdef";
const ENV = { COUNTERSIGN_SUPPORT_AGENT_KEY: KEY };

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const proposalsDir = fileURLToPath(new URL("../proposals/", import.meta.url));
const beat4 = join(proposalsDir, "beat-4-stalled-parcel.json");
const guarded = join(proposalsDir, "guarded-actions.json");
const entry = fileURLToPath(new URL("../src/agent-main.ts", import.meta.url));

const BUYER_EMAIL = { A: "amina.k@example.com", B: "grace.w@example.com" } as const;
const usd = (minor: number) => ({ minor, currency: "USD" as const });

type SeededOrder = { n: number; buyer: "A" | "B"; minor: number; status: ShipmentStatus };
const SEEDED: readonly SeededOrder[] = [
  { n: 1035, buyer: "A", minor: 1800, status: "stalled_10d" },
  { n: 1037, buyer: "A", minor: 24000, status: "delivered" },
  { n: 1038, buyer: "B", minor: 4800, status: "delivered" },
];

const tempDir = trackedTempDirs();

let servers: Server[] = [];
let handles: DatabaseHandle[] = [];

afterEach(async () => {
  for (const server of servers) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  for (const handle of handles) await handle.close().catch(() => {});
  servers = [];
  handles = [];
});

// A PGlite store as `npm run seed` leaves it, and a fake sandbox holding the same orders.
async function seededWorld(): Promise<{ handle: DatabaseHandle; rail: FakeSandbox }> {
  const handle = await openPgliteDirectory(tempDir("agent-cli-"));
  handles.push(handle);
  const rail = createFakeSandbox();
  const store = createDatabaseShipmentStore(handle.db);
  for (const { n, buyer, minor, status } of SEEDED) {
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
            { id: `${captureId}-${trackingNumber}`, captureId, trackingNumber, status: "SHIPPED" },
          ],
          refunds: [],
        },
      ],
    });
  }
  return { handle, rail };
}

async function listenGate(handle: DatabaseHandle, rail: FakeSandbox, key = KEY): Promise<string> {
  const server = createApp({
    db: handle.db,
    rail: () => rail,
    carrier: createMockCarrier(createDatabaseShipmentStore(handle.db)),
    env: { COUNTERSIGN_SUPPORT_AGENT_KEY: key },
    clock: () => NOW,
  }).listen(0, "127.0.0.1");
  servers.push(server);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}/mcp`;
}

// A port nothing listens on: listened on, then closed.
async function closedUrl(): Promise<string> {
  const server = createApp({}).listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return `http://127.0.0.1:${port}/mcp`;
}

function proposalFile(contents: unknown): string {
  const path = join(tempDir("agent-file-"), "proposals.json");
  writeFileSync(path, JSON.stringify(contents));
  return path;
}

const fileOf = (path: string) => JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;

function variant(path: string, change: (file: Record<string, unknown>) => void): string {
  const file = structuredClone(fileOf(path));
  file.mandate = join(repoRoot, "packages/mandate/fixtures/kikapu-studio-v3.json");
  change(file);
  return proposalFile(file);
}

type FileItem = Record<string, unknown>;
const items = (file: Record<string, unknown>) => file.proposals as FileItem[];

const options = (handle: DatabaseHandle) => ({ db: handle.db, now: () => NOW });

const entryCount = async (handle: DatabaseHandle) =>
  (await handle.db.select().from(auditLog)).length;

describe("npm run agent on the demo files", { timeout: SLOW }, () => {
  it("matches every decision in beat 4 and guarded-actions.json over MCP, and exits 0", async () => {
    const { handle, rail } = await seededWorld();
    const url = await listenGate(handle, rail);

    const first = await runAgent([beat4, "--url", url], ENV, options(handle));
    expect(first.stderr).toBe("");
    expect(first.exitCode).toBe(EXIT_MATCHED);
    expect(first.stdout).toContain(`Gate ${url}, as support-agent`);
    expect(first.stdout).toContain(
      "For       KIK-1035, ticket TKT-1035 from amina.k@example.com (simulated)",
    );
    expect(first.stdout).toContain("Decision  Allow");
    expect(rail.refunds.size).toBe(1);

    const second = await runAgent([guarded, "--url", url], ENV, options(handle));
    expect(second.stderr).toBe("");
    expect(second.exitCode).toBe(EXIT_MATCHED);
    const blocks = second.stdout.split(/\n(?=Proposal \d+ of \d+\n)/).slice(1);
    expect(blocks).toHaveLength(3);
    expect(blocks[0]).toContain("Tool      create_payout");
    expect(blocks[0]).toContain("(NO_MATCHING_RULE)");
    expect(blocks[1]).toContain(
      "For       pay_order on KIK-1037, ticket TKT-2002 from amina.k@example.com (simulated)",
    );
    expect(blocks[1]).toContain("(NO_MATCHING_RULE)");
    expect(blocks[2]).toContain("(TARGET_UNKNOWN)");
    for (const block of blocks) {
      expect(block).toContain("Decision  Deny");
      expect(block).toContain("  Reply     ");
      expect(block).not.toContain("Expected");
    }
    // Nothing else was sent, and every call was recorded.
    expect(rail.refunds.size).toBe(1);
    expect(await entryCount(handle)).toBeGreaterThanOrEqual(5);

    // The tickets were written to the store first, labelled simulated.
    const payoutTicket = await readTicket(handle.db, "TKT-2001");
    expect(payoutTicket).toMatchObject({ senderEmail: BUYER_EMAIL.B, simulated: true });
    expect(await readTicket(handle.db, "TKT-1035")).toMatchObject({ simulated: true });
  });

  it("exits 1 when a decision differs from the file", async () => {
    const { handle, rail } = await seededWorld();
    const url = await listenGate(handle, rail);
    const path = variant(guarded, (file) => {
      (items(file)[2] as FileItem).expect = { decision: "step_up", reasons: [] };
    });
    const result = await runAgent([path, "--url", url], ENV, options(handle));
    expect(result.exitCode).toBe(EXIT_DIFFERED);
    expect(result.stdout).toContain("Expected step_up, got deny TARGET_UNKNOWN.");
    expect(result.stdout).toContain("1 proposal differed from the file.");
  });

  it("prints the agent responses with --json, each one valid", async () => {
    const { handle, rail } = await seededWorld();
    const url = await listenGate(handle, rail);
    const result = await runAgent([guarded, "--json", "--url", url], ENV, options(handle));
    expect(result.exitCode).toBe(EXIT_MATCHED);
    expect(result.stderr).toBe("");
    const responses = JSON.parse(result.stdout) as unknown[];
    expect(responses).toHaveLength(3);
    for (const response of responses) {
      expect(AgentResponseSchema.safeParse(response).success).toBe(true);
    }
    expect(responses.map((response) => (response as { decision: string }).decision)).toEqual([
      "denied",
      "denied",
      "denied",
    ]);
  });
});

describe("npm run agent when it can't run", { timeout: SLOW }, () => {
  it("names a missing or short principal key, never showing it", async () => {
    const short = "too-short-key";
    for (const env of [{}, { COUNTERSIGN_SUPPORT_AGENT_KEY: short }]) {
      const result = await runAgent([guarded], env, {});
      expect(result.exitCode).toBe(EXIT_CANT_RUN);
      expect(result.stderr).toBe(
        "The agent CLI can't start. Set COUNTERSIGN_SUPPORT_AGENT_KEY in .env.local, 32 or more characters.\n",
      );
      expect(result.stderr).not.toContain(short);
    }
  });

  it("exits 2 with one line when the gate refuses the key", async () => {
    const { handle, rail } = await seededWorld();
    const url = await listenGate(handle, rail, "the-gate-holds-another-key-0123456789");
    const result = await runAgent([guarded, "--url", url], ENV, options(handle));
    expect(result.exitCode).toBe(EXIT_CANT_RUN);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe(
      `The gate at ${url} refused the principal key (HTTP 401). Check COUNTERSIGN_SUPPORT_AGENT_KEY matches the gate's.\n`,
    );
    expect(result.stderr).not.toContain(KEY);
    expect(await entryCount(handle)).toBe(0);
  });

  it("exits 2 with one line when the gate is unreachable, after storing the tickets in --pglite", async () => {
    const dir = tempDir("agent-pglite-");
    const seed = await openPgliteDirectory(dir);
    await seed.db.insert(seedOrders).values({
      orderNumber: "KIK-1037",
      runId: "run1",
      paypalOrderId: "ORD1037",
      paypalCaptureId: "CAP1037",
      amountMinor: 24000,
      currency: "USD",
      payerEmail: BUYER_EMAIL.A,
      buyer: "A",
      trackingNumber: "KC-run1-1037",
      role: "demo",
      seededAt: "2026-10-01T08:00:00Z",
    });
    await seed.db.insert(seedOrders).values({
      orderNumber: "KIK-1038",
      runId: "run1",
      paypalOrderId: "ORD1038",
      paypalCaptureId: "CAP1038",
      amountMinor: 4800,
      currency: "USD",
      payerEmail: BUYER_EMAIL.B,
      buyer: "B",
      trackingNumber: "KC-run1-1038",
      role: "demo",
      seededAt: "2026-10-01T08:00:00Z",
    });
    await seed.close();

    const url = await closedUrl();
    const result = await runAgent([guarded, "--url", url, "--pglite", dir], ENV, {
      now: () => NOW,
    });
    expect(result.exitCode).toBe(EXIT_CANT_RUN);
    expect(result.stderr).toBe(
      `Couldn't reach the gate at ${url}. Start it with npm run dev --workspace @countersign/gate.\n`,
    );

    const after = await openPgliteDirectory(dir);
    handles.push(after);
    for (const id of ["TKT-2001", "TKT-2002", "TKT-2003"]) {
      expect(await readTicket(after.db, id)).toMatchObject({ id, simulated: true });
    }
  });

  it("refuses an order on a tool other than create_refund, and another principal", async () => {
    const withOrder = variant(guarded, (file) => {
      (items(file)[0] as FileItem).order = "KIK-1037";
    });
    const ordered = await runAgent([withOrder], ENV, {});
    expect(ordered.exitCode).toBe(EXIT_CANT_RUN);
    expect(ordered.stderr).toContain("Only create_refund proposals name an order or a capture");

    const seedOnRefund = variant(beat4, (file) => {
      (items(file)[0] as FileItem).seed_order = "KIK-1037";
    });
    expect((await runAgent([seedOnRefund], ENV, {})).stderr).toContain(
      "Only pay_order proposals name a seed_order",
    );

    const other = variant(guarded, (file) => {
      file.principal = "ops-agent";
    });
    expect((await runAgent([other], ENV, {})).stderr).toContain(
      "the stand-in agent proposes as support-agent, not ops-agent.",
    );
  });

  it("exits 2 with the usage for no file, an unknown option or a bad --url", async () => {
    expect((await runAgent([], ENV, {})).stderr).toBe(`${AGENT_USAGE}\n`);
    expect((await runAgent([guarded, "--live"], ENV, {})).stderr).toBe(
      `Unknown option --live. ${AGENT_USAGE}\n`,
    );
    expect((await runAgent([guarded, "--url", "ftp://gate"], ENV, {})).stderr).toBe(
      `--url needs the gate's MCP URL. ${AGENT_USAGE}\n`,
    );
  });

  it("exits 2 as a child process when the principal key is missing", () => {
    const child = spawnSync(process.execPath, ["--import", "tsx", entry, guarded], {
      cwd: repoRoot,
      encoding: "utf8",
      env: { PATH: process.env.PATH ?? "" },
    });
    expect(child.status).toBe(EXIT_CANT_RUN);
    expect(child.stdout).toBe("");
    expect(child.stderr).toBe(
      "The agent CLI can't start. Set COUNTERSIGN_SUPPORT_AGENT_KEY in .env.local, 32 or more characters.\n",
    );
  });
});
