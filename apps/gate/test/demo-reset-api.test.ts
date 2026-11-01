import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  agentRuns,
  auditLog,
  createTestDatabase,
  type Database,
  type DatabaseHandle,
  seedOrders,
  sql,
} from "@countersign/db";
import { DEMO_ORDERS, type DemoOrder } from "@countersign/seed";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { type AppDeps, createApp } from "../src/app";
import { APPROVAL_MESSAGES } from "../src/approvals-api";
import { APPROVER_KEY_VAR } from "../src/approver";
import { DEMO_RESET_VAR, RESET_MESSAGES } from "../src/demo-reset";
import { DEMO_RESET_PATH } from "../src/demo-reset-api";
import { OPS_AGENT_KEY_VAR, SUPPORT_AGENT_KEY_VAR } from "../src/principals";
import { createFakeSandbox, type FakeSandbox } from "./fake-sandbox";

// POST /demo/reset over HTTP on 127.0.0.1 (T-009), with PGlite, the fake sandbox and an injected
// clock. Every catalog order is seeded already, so the reset keeps them and needs no reseed.
// Illustrative keys and tokens.

const SLOW = 60_000;
const NOW = new Date("2026-10-20T12:00:00.000Z");
const RUN = "20261001oldrun";
const APPROVER_KEY = "approver-key-illustrative-0123456789abcd";
const SUPPORT_KEY = "support-key-illustrative-0123456789abcde";
const OPS_KEY = "ops-key-illustrative-0123456789abcdefgh";
const VAULT_A = "illustrative-vault-a";
const VAULT_B = "illustrative-vault-b";
const ENV = {
  [APPROVER_KEY_VAR]: APPROVER_KEY,
  [SUPPORT_AGENT_KEY_VAR]: SUPPORT_KEY,
  [OPS_AGENT_KEY_VAR]: OPS_KEY,
  [DEMO_RESET_VAR]: "on",
  PAYPAL_BASE_URL: "https://api-m.sandbox.paypal.com",
  PAYPAL_CLIENT_ID: "illustrative-client-id",
  PAYPAL_CLIENT_SECRET: "illustrative-client-secret",
  PAYPAL_SEED_VAULT_TOKEN: VAULT_A,
  PAYPAL_SEED_VAULT_TOKEN_B: VAULT_B,
  RESOLVE_AGENT_URL: "http://resolve.test:8788",
};

const usd = (minor: number) => ({ minor, currency: "USD" as const });
const rowFor = (demo: DemoOrder) => ({
  orderNumber: demo.orderNumber,
  runId: RUN,
  paypalOrderId: `ORD-${RUN}-${demo.orderNumber}`,
  paypalCaptureId: `CAP-${RUN}-${demo.orderNumber}`,
  amountMinor: 1800,
  currency: "USD",
  payerEmail: `buyer-${demo.buyer.toLowerCase()}@example.com`,
  buyer: demo.buyer,
  trackingNumber: `TRK-${RUN}-${demo.orderNumber}`,
  role: demo.role,
  seededAt: "2026-10-01T09:00:00.000Z",
});

let servers: Server[] = [];

afterEach(async () => {
  for (const server of servers) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  servers = [];
});

async function listen(deps: AppDeps): Promise<string> {
  const server = createApp(deps).listen(0, "127.0.0.1");
  servers.push(server);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

const post = async (base: string, key?: string) => {
  const res = await fetch(`${base}${DEMO_RESET_PATH}`, {
    method: "POST",
    ...(key ? { headers: { Authorization: `Bearer ${key}` } } : {}),
  });
  const text = await res.text();
  // Express's own 404 is HTML, so the body is read only when it is JSON.
  const body = res.headers.get("content-type")?.includes("json") ? JSON.parse(text) : null;
  return { status: res.status, text, body: body as Record<string, unknown> };
};

describe("POST /demo/reset", { timeout: SLOW }, () => {
  let handle: DatabaseHandle;
  let db: Database;
  let rail: FakeSandbox;
  let railBuilds: number;

  const listenWith = (
    env: Record<string, string | undefined> = ENV,
    extra: Partial<AppDeps> = {},
  ) =>
    listen({
      db,
      env,
      clock: () => NOW,
      rail: () => {
        railBuilds += 1;
        return rail;
      },
      fetch: async () => ({ ok: true }),
      ...extra,
    });

  const logRows = () => db.select().from(auditLog).orderBy(auditLog.seq);

  beforeAll(async () => {
    handle = await createTestDatabase();
    db = handle.db;
  }, SLOW);

  beforeEach(async () => {
    await db.execute(
      sql`TRUNCATE audit_log, tickets, ticket_attachments, agent_runs, dispute_drafts, evidence_documents, seed_orders, cleared_run_counts`,
    );
    rail = createFakeSandbox();
    railBuilds = 0;
    for (const demo of DEMO_ORDERS) {
      const row = rowFor(demo);
      await db.insert(seedOrders).values(row);
      rail.captures.set(row.paypalCaptureId, {
        id: row.paypalCaptureId,
        status: "COMPLETED",
        amount: usd(1800),
        orderId: row.paypalOrderId,
      });
    }
  });

  afterAll(async () => {
    await handle.close();
  });

  describe("when the flag is exactly on", () => {
    it("answers 401 for no key, a wrong key and a principal key, and clears nothing", async () => {
      const base = await listenWith();
      for (const key of [undefined, "not-the-key", SUPPORT_KEY, OPS_KEY]) {
        const result = await post(base, key);
        expect(result.status).toBe(401);
        expect(result.body).toEqual({ message: APPROVAL_MESSAGES.unauthorized });
      }
      expect(await logRows()).toEqual([]);
      expect(railBuilds).toBe(0);
    });

    it("answers 200 with the snake_case report for the approver key", async () => {
      const base = await listenWith();
      const result = await post(base, APPROVER_KEY);
      expect(result.status).toBe(200);
      expect(result.body).toEqual({
        complete: true,
        reset_at: NOW.toISOString(),
        took_ms: 0,
        orders: { kept: 30, replaced: [], run_id: null, failed: [] },
        cleared: {
          previous_head: null,
          entries: 0,
          tickets: 0,
          attachments: 0,
          runs: 0,
          drafts: 0,
          documents: 0,
        },
        disputes: { recorded: 0, already_recorded: 0, problems: 0 },
      });
      const rows = await logRows();
      expect(rows.map((row) => [row.seq, row.entryType])).toEqual([[1, "demo.reset"]]);
      expect(result.text).not.toContain(APPROVER_KEY);
      expect(result.text).not.toContain(VAULT_A);
    });

    it("answers 200 with failures and nothing cleared when a replacement fails", async () => {
      await db.delete(seedOrders);
      const base = await listenWith(ENV, {
        reseed: async ({ orders, runId }) => ({
          runId,
          total: orders.length,
          seeded: 0,
          counts: {},
          failures: [{ orderNumber: "KIK-1013", call: "createOrder", reason: "PayPal said no" }],
          problem: null,
        }),
      } as Partial<AppDeps>);
      const result = await post(base, APPROVER_KEY);
      expect(result.status).toBe(200);
      expect(result.body).toMatchObject({
        complete: false,
        cleared: null,
        disputes: null,
        orders: {
          failed: expect.arrayContaining([
            { order_number: "KIK-1013", call: "createOrder", reason: "PayPal said no" },
          ]),
        },
      });
      expect(await logRows()).toEqual([]);
    });

    it("answers 409 with the sentence while Resolve is working, and clears nothing", async () => {
      await db.insert(agentRuns).values({
        id: "run_illustrative",
        ticketId: "tkt_illustrative",
        threadId: "thr_illustrative",
        mode: "protected",
        model: "illustrative-model",
        modelVersions: [],
        status: "running",
        queuedAt: "2026-10-20T11:59:00.000Z",
      });
      const base = await listenWith();
      const result = await post(base, APPROVER_KEY);
      expect(result.status).toBe(409);
      expect(result.body).toEqual({ message: RESET_MESSAGES.resolveBusy });
      expect(await logRows()).toEqual([]);
    });

    it("answers 409 for a second reset inside a minute", async () => {
      const base = await listenWith();
      expect((await post(base, APPROVER_KEY)).status).toBe(200);
      const again = await post(base, APPROVER_KEY);
      expect(again.status).toBe(409);
      expect(again.body).toEqual({ message: RESET_MESSAGES.justReset });
    });

    it("answers 503 with the sentence naming only the missing vault variable", async () => {
      const { PAYPAL_SEED_VAULT_TOKEN_B: _, ...env } = ENV;
      const base = await listenWith(env);
      const result = await post(base, APPROVER_KEY);
      expect(result.status).toBe(503);
      expect(result.body).toEqual({
        message: "Set PAYPAL_SEED_VAULT_TOKEN_B on the gate to reset the demo.",
      });
      expect(result.text).not.toContain(VAULT_A);
    });

    it("answers 503 when PayPal isn't set up", async () => {
      const base = await listenWith(ENV, {
        rail: () => {
          throw new Error("no rail");
        },
      });
      const result = await post(base, APPROVER_KEY);
      expect(result.status).toBe(503);
      expect(result.body).toEqual({ message: RESET_MESSAGES.noPayPal });
    });

    it("answers 503 without a database", async () => {
      const base = await listen({ env: ENV, clock: () => NOW, rail: () => rail });
      const result = await post(base, APPROVER_KEY);
      expect(result.status).toBe(503);
      expect(result.body).toEqual({ message: RESET_MESSAGES.noDatabase });
    });

    it("builds the rail client once across requests (railOnce)", async () => {
      await db.insert(agentRuns).values({
        id: "run_illustrative",
        ticketId: "tkt_illustrative",
        threadId: "thr_illustrative",
        mode: "protected",
        model: "illustrative-model",
        modelVersions: [],
        status: "queued",
        queuedAt: "2026-10-20T11:59:00.000Z",
      });
      const base = await listenWith();
      expect((await post(base, APPROVER_KEY)).status).toBe(409);
      expect((await post(base, APPROVER_KEY)).status).toBe(409);
      expect(railBuilds).toBe(1);
    });
  });

  describe("when the flag isn't exactly on", () => {
    it.each([
      ["unset", undefined],
      ["off", "off"],
      ["ON", "ON"],
      ["true", "true"],
      ["padded", " on"],
      ["blank", ""],
    ])("answers 404 even with the approver key (%s)", async (_name, value) => {
      const base = await listenWith({ ...ENV, [DEMO_RESET_VAR]: value });
      for (const key of [APPROVER_KEY, undefined]) {
        const result = await post(base, key);
        expect(result.status).toBe(404);
      }
      expect(await logRows()).toEqual([]);
      expect(railBuilds).toBe(0);
    });
  });
});
