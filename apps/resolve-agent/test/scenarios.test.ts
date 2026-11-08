import { readFileSync } from "node:fs";
import type { Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import {
  createTestDatabase,
  type DatabaseHandle,
  readAttachment,
  readRun,
  readThread,
  seedOrders,
  tickets,
} from "@countersign/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { BASELINE_REFUSALS, type BaselinePolicy } from "../src/baseline-policy";
import { createSuppliedTokens, type RunQueue, type SuppliedTokens } from "../src/queue";
import { LAUNCHER_SCENARIOS, loadScenario, SCENARIOS_DIR } from "../src/scenarios";
import { authed, TEST_SECRET } from "./secret";

// Resolve's `POST /scenarios/:id` on 127.0.0.1 port 0, with PGlite, `seed_orders` rows for buyer A
// and the beat orders, and a queue fake that records run IDs. The people are illustrative and
// every message is simulated.

const MODEL = "gemini-3.5-flash-lite";
const NOW = new Date("2026-10-20T08:00:00Z");
const BUYER_A = "amina.k@example.com";
const PAYER_1035 = "wanjiru.m@example.com";
const PAYER_1037 = "achieng.o@example.com";
const BAD_BODY = "Send JSON with mode, protected or baseline.";
const PROTECTED_ONLY = "This scenario runs in protected mode only.";
const TOKEN = { access_token: "A21AAsandbox-token", expires_at: NOW.getTime() + 3_600_000 };

let handle: DatabaseHandle;
let servers: HttpServer[];
let queued: string[];
let tokens: SuppliedTokens;

const queue: RunQueue = {
  enqueue: (runId) => {
    queued.push(runId);
  },
  idle: async () => {},
};

type Options = {
  db?: boolean;
  baseline?: BaselinePolicy;
  canMintTokens?: boolean;
  dailyCap?: number;
};

async function listen(options: Options = {}): Promise<string> {
  const server = createApp({
    ...(options.db === false ? {} : { db: handle.db }),
    sharedSecret: TEST_SECRET,
    model: MODEL,
    queue,
    clock: () => NOW,
    suppliedTokens: tokens,
    ...(options.baseline === undefined ? {} : { baseline: options.baseline }),
    ...(options.canMintTokens === undefined ? {} : { canMintTokens: options.canMintTokens }),
    ...(options.dailyCap === undefined ? {} : { dailyCap: options.dailyCap }),
  }).listen(0, "127.0.0.1");
  servers.push(server);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

const launch = (base: string, id: string, body: unknown) =>
  authed(`${base}/scenarios/${id}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

async function seed(rows: readonly { n: number; buyer: "A" | "B"; email: string }[]) {
  for (const { n, buyer, email } of rows) {
    await handle.db.insert(seedOrders).values({
      orderNumber: `KIK-${n}`,
      runId: "run1",
      paypalOrderId: `ORD${n}`,
      paypalCaptureId: `CAP${n}`,
      amountMinor: 1800,
      currency: "USD",
      payerEmail: email,
      buyer,
      trackingNumber: `KC-run1-${n}`,
      role: "demo",
      seededAt: "2026-10-01T08:00:00Z",
    });
  }
}

const SEEDED = [
  { n: 1035, buyer: "B", email: PAYER_1035 },
  { n: 1037, buyer: "B", email: PAYER_1037 },
  { n: 1042, buyer: "A", email: BUYER_A },
] as const;

const storedTickets = () => handle.db.select().from(tickets);

beforeEach(async () => {
  handle = await createTestDatabase();
  servers = [];
  queued = [];
  tokens = createSuppliedTokens();
});

afterEach(async () => {
  for (const server of servers) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  await handle.close();
});

describe("the launcher's scenario files", () => {
  it("loads all three, each with one message", () => {
    expect(LAUNCHER_SCENARIOS.map(({ id, modes }) => [id, modes])).toEqual([
      ["beat-3-attack-email", ["protected", "baseline"]],
      ["beat-4-stalled-parcel", ["protected"]],
      ["beat-5-damaged", ["protected"]],
    ]);
    for (const { id } of LAUNCHER_SCENARIOS) {
      const loaded = loadScenario(id);
      expect(loaded?.message.body).toMatch(/\S/);
    }
    expect(loadScenario("beat-5-damaged")?.photos).toHaveLength(1);
    expect(loadScenario("beat-9-unknown")).toBeNull();
  });
});

describe("POST /scenarios/:id", () => {
  const cases = [
    ["beat-3-attack-email", BUYER_A, "KIK-1042 never arrived", 0],
    ["beat-4-stalled-parcel", PAYER_1035, "Coaster set KIK-1035 hasn't arrived", 0],
    ["beat-5-damaged", PAYER_1037, "Floor basket KIK-1037 arrived damaged", 1],
  ] as const;

  it.each(cases)(
    "stores and queues %s with its sender from seed_orders and its photos",
    async (id, email, subject, photoCount) => {
      await seed(SEEDED);
      const base = await listen();
      const response = await launch(base, id, { mode: "protected" });
      expect(response.status).toBe(202);
      const answer = (await response.json()) as {
        ticket_id: string;
        thread_id: string;
        run_id: string;
      };
      expect(queued).toEqual([answer.run_id]);
      const [ticket, ...others] = await readThread(handle.db, answer.thread_id);
      expect(others).toEqual([]);
      expect(ticket?.id).toBe(answer.ticket_id);
      expect(ticket?.channel).toBe("email");
      expect(ticket?.senderEmail).toBe(email);
      expect(ticket?.subject).toBe(subject);
      expect(ticket?.body).toBe(loadScenario(id)?.message.body);
      expect(ticket?.attachments).toHaveLength(photoCount);
      if (photoCount === 1) {
        const stored = await readAttachment(handle.db, ticket?.attachments[0]?.id ?? "");
        expect(stored?.contentType).toBe("image/jpeg");
        const file = readFileSync(new URL("beat-5-damaged-basket.jpg", SCENARIOS_DIR));
        expect(Buffer.from(stored?.bytes ?? []).equals(file)).toBe(true);
      }
      const run = await readRun(handle.db, answer.run_id);
      expect(run?.mode).toBe("protected");
      expect(run?.status).toBe("queued");
      expect(tokens.take(answer.run_id)).toBeUndefined();
    },
  );

  it("answers 404 for an unknown ID, whatever the body", async () => {
    const base = await listen();
    for (const body of [{ mode: "protected" }, "not json"]) {
      const response = await launch(base, "beat-9-unknown", body);
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ message: "There's no scenario with that ID." });
    }
    expect(queued).toEqual([]);
  });

  const badBodies: [string, string, unknown, string][] = [
    ["JSON that doesn't parse", "beat-3-attack-email", "{mode:", BAD_BODY],
    ["a body with no mode", "beat-3-attack-email", {}, BAD_BODY],
    ["an unknown mode", "beat-3-attack-email", { mode: "fast" }, BAD_BODY],
    ["an extra key", "beat-3-attack-email", { mode: "protected", body: "Hi" }, BAD_BODY],
    [
      "a token with protected mode",
      "beat-3-attack-email",
      { mode: "protected", paypal_token: TOKEN },
      BAD_BODY,
    ],
    [
      "a token with an extra key",
      "beat-3-attack-email",
      { mode: "baseline", paypal_token: { ...TOKEN, scope: "all" } },
      BAD_BODY,
    ],
    [
      "a body over 1 KB",
      "beat-3-attack-email",
      { mode: "protected", pad: "a".repeat(2048) },
      BAD_BODY,
    ],
    [
      "baseline for beat 4",
      "beat-4-stalled-parcel",
      { mode: "baseline", paypal_token: TOKEN },
      PROTECTED_ONLY,
    ],
    [
      "baseline for beat 5",
      "beat-5-damaged",
      { mode: "baseline", paypal_token: TOKEN },
      PROTECTED_ONLY,
    ],
  ];

  it.each(badBodies)("answers 400 for %s, storing nothing", async (_name, id, body, sentence) => {
    await seed(SEEDED);
    const base = await listen();
    const response = await launch(base, id, body);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ message: sentence });
    expect(queued).toEqual([]);
    expect(await storedTickets()).toEqual([]);
  });

  it("refuses baseline with no token when Resolve can't mint one", async () => {
    await seed(SEEDED);
    const base = await listen({ canMintTokens: false, baseline: "scenarios" });
    const response = await launch(base, "beat-3-attack-email", { mode: "baseline" });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ message: BASELINE_REFUSALS.noToken });
    expect(queued).toEqual([]);
    expect(await storedTickets()).toEqual([]);
  });

  it("accepts baseline with no token when Resolve can mint one, holding nothing", async () => {
    await seed(SEEDED);
    const base = await listen({ canMintTokens: true });
    const response = await launch(base, "beat-3-attack-email", { mode: "baseline" });
    expect(response.status).toBe(202);
    const { run_id } = (await response.json()) as { run_id: string };
    expect(queued).toEqual([run_id]);
    expect((await readRun(handle.db, run_id))?.mode).toBe("baseline");
    expect(tokens.take(run_id)).toBeUndefined();
  });

  it("accepts baseline under scenarios and holds the supplied token for the new run", async () => {
    await seed(SEEDED);
    const base = await listen({ baseline: "scenarios", canMintTokens: false });
    const response = await launch(base, "beat-3-attack-email", {
      mode: "baseline",
      paypal_token: TOKEN,
    });
    expect(response.status).toBe(202);
    const answer = (await response.json()) as Record<string, string>;
    expect(JSON.stringify(answer)).not.toContain(TOKEN.access_token);
    const { run_id } = answer as { run_id: string };
    expect(queued).toEqual([run_id]);
    const run = await readRun(handle.db, run_id);
    expect(run?.mode).toBe("baseline");
    expect(JSON.stringify(run)).not.toContain(TOKEN.access_token);
    expect(JSON.stringify(await storedTickets())).not.toContain(TOKEN.access_token);
    expect(tokens.take(run_id)).toEqual({
      accessToken: TOKEN.access_token,
      expiresAt: TOKEN.expires_at,
    });
  });

  it("refuses baseline when the policy is off", async () => {
    await seed(SEEDED);
    const base = await listen({ baseline: "off" });
    const response = await launch(base, "beat-3-attack-email", {
      mode: "baseline",
      paypal_token: TOKEN,
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ message: BASELINE_REFUSALS.off });
    expect(queued).toEqual([]);
  });

  it("stores a capped run as not_run, queuing nothing and holding no token", async () => {
    await seed(SEEDED);
    const base = await listen({ dailyCap: 0, baseline: "scenarios" });
    const response = await launch(base, "beat-3-attack-email", {
      mode: "baseline",
      paypal_token: TOKEN,
    });
    expect(response.status).toBe(202);
    const { run_id } = (await response.json()) as { run_id: string };
    expect(queued).toEqual([]);
    const run = await readRun(handle.db, run_id);
    expect(run?.status).toBe("not_run");
    expect(run?.outcome).toBe("daily_cap");
    expect(tokens.take(run_id)).toBeUndefined();
  });

  it("answers 409 for an order that isn't seeded", async () => {
    await seed([{ n: 1042, buyer: "A", email: BUYER_A }]);
    const base = await listen();
    const response = await launch(base, "beat-4-stalled-parcel", { mode: "protected" });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      message: "Order KIK-1035 isn't seeded. Reset the demo first.",
    });
    expect(queued).toEqual([]);
    expect(await storedTickets()).toEqual([]);
  });

  it("answers 409 for a buyer that isn't seeded", async () => {
    await seed([{ n: 1035, buyer: "B", email: PAYER_1035 }]);
    const base = await listen();
    const response = await launch(base, "beat-3-attack-email", { mode: "protected" });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      message: "Buyer A isn't seeded. Reset the demo first.",
    });
    expect(queued).toEqual([]);
  });

  it("answers 503 without a database", async () => {
    const base = await listen({ db: false });
    const response = await launch(base, "beat-3-attack-email", { mode: "protected" });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      message: "Resolve has no database, so it can't take or show messages.",
    });
    expect(queued).toEqual([]);
  });
});
