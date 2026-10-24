import { readFileSync } from "node:fs";
import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import { asc, auditLog, createTestDatabase, type DatabaseHandle, sql } from "@countersign/db";
import { appendEntries, verifyLog } from "@countersign/ledger";
import { PayPalError } from "@countersign/rail-paypal";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { type AppDeps, createApp } from "../src/app";
import { DisputeReceivedPayloadSchema } from "../src/dispute-log";
import {
  executionRequestedEntry,
  executionResultEntry,
  ReconciliationPayloadSchema,
} from "../src/execution-log";
import type { NudgeFetch } from "../src/nudge";
import { handlePayPalWebhook, type WebhookDeps } from "../src/webhook";
import { createFakeSandbox, type FakeSandbox, httpError } from "./fake-sandbox";

// Each PGlite start takes a couple of seconds.
const SLOW = 60_000;
const AT = new Date("2026-10-17T09:30:00.000Z");
const WEBHOOK_ID = "WH-FAKE-0123456789";
const SECRET = "fake-client-secret-should-never-appear";
const INTENT = `int_${"a".repeat(24)}`;
const HASH = "a".repeat(64);
const CAPTURE = "CAP-1035";
const usd = (minor: number) => ({ minor, currency: "USD" as const });

const ENV = {
  PAYPAL_WEBHOOK_ID: WEBHOOK_ID,
  PAYPAL_CLIENT_ID: "fake-client-id",
  PAYPAL_CLIENT_SECRET: SECRET,
};

const TRANSMISSION = {
  "paypal-transmission-id": "b2c3d4e5-transmission-id-header",
  "paypal-transmission-time": "2026-10-17T09:29:58Z",
  "paypal-cert-url": "https://api.sandbox.paypal.com/v1/notifications/certs/CERT-fake-cert-header",
  "paypal-auth-algo": "SHA256withRSA",
  "paypal-transmission-sig": "c2lnbmF0dXJlLXRyYW5zbWlzc2lvbi1zaWctaGVhZGVy",
};

const eventBody = (id: string, refundId: string, type = "PAYMENT.CAPTURE.REFUNDED") =>
  JSON.stringify({
    id,
    event_type: type,
    resource_type: "refund",
    summary: "A body-only-marker refund summary",
    resource: {
      id: refundId,
      status: "COMPLETED",
      amount: { currency_code: "USD", value: "1.00" },
    },
  });

const DISPUTE = "PP-D-1234";
const disputeBody = (id: string, disputeId: unknown, type = "CUSTOMER.DISPUTE.CREATED") =>
  JSON.stringify({
    id,
    event_type: type,
    resource_type: "dispute",
    summary: "A body-only-marker dispute summary",
    resource: {
      dispute_id: disputeId,
      status: "RESOLVED",
      reason: "UNAUTHORISED",
      dispute_amount: { currency_code: "USD", value: "1.00" },
    },
  });

type Injected = { status: number; text: string };

// Calls the Express app in-process, with no listening port.
function inject(
  app: ReturnType<typeof createApp>,
  options: { path: string; method?: string; headers?: Record<string, string>; body?: string },
): Promise<Injected> {
  const req = new IncomingMessage(new Socket());
  req.method = options.method ?? "POST";
  req.url = options.path;
  const body = options.body === undefined ? undefined : Buffer.from(options.body);
  req.headers = {
    "content-type": "application/json",
    ...(body ? { "content-length": String(body.length) } : {}),
    ...options.headers,
  };
  if (body) req.push(body);
  req.push(null);

  const res = new ServerResponse(req);
  const chunks: Buffer[] = [];
  const take = (chunk: unknown) => {
    if (typeof chunk === "string") chunks.push(Buffer.from(chunk));
    else if (Buffer.isBuffer(chunk) || chunk instanceof Uint8Array) chunks.push(Buffer.from(chunk));
  };
  return new Promise((resolve) => {
    res.write = ((chunk: unknown) => {
      take(chunk);
      return true;
    }) as typeof res.write;
    res.end = ((chunk?: unknown) => {
      take(chunk);
      resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString("utf8") });
      return res;
    }) as typeof res.end;
    app(req, res);
  });
}

let handle: DatabaseHandle;
let sandbox: FakeSandbox;

beforeAll(async () => {
  handle = await createTestDatabase();
}, SLOW);

afterAll(async () => {
  await handle.close();
});

beforeEach(async () => {
  await handle.db.execute(sql`TRUNCATE audit_log`);
  sandbox = createFakeSandbox();
  sandbox.refunds.set("REFUND-1", {
    id: "REFUND-1",
    status: "COMPLETED",
    amount: usd(1800),
    captureId: CAPTURE,
  });
  sandbox.refunds.set("REFUND-DASH", {
    id: "REFUND-DASH",
    status: "COMPLETED",
    amount: usd(500),
    captureId: "CAP-1036",
  });
});

const appWith = (overrides: Partial<AppDeps> = {}) =>
  createApp({ db: handle.db, rail: () => sandbox, env: ENV, clock: () => AT, ...overrides });

const post = (app: ReturnType<typeof createApp>, body: string, headers = TRANSMISSION) =>
  inject(app, { path: "/webhooks/paypal", headers, body });

async function seedExecuted(): Promise<{ resultSeq: number }> {
  const written = await appendEntries(handle.db, [
    executionRequestedEntry({
      at: "2026-10-17T09:00:00.000Z",
      intentId: INTENT,
      intentHash: HASH,
      principal: "support-agent",
      rail: "paypal",
      action: "paypal.refund",
      target: { captureId: CAPTURE },
      amount: usd(1800),
      decisionSeq: 1,
    }),
    executionResultEntry({
      at: "2026-10-17T09:00:01.000Z",
      intentId: INTENT,
      requestSeq: 1,
      outcome: "executed",
      refund: { id: "REFUND-1", status: "COMPLETED" },
    }),
  ]);
  if (!written.ok) throw new Error(written.rejection.detail);
  return { resultSeq: written.entries[1]?.seq ?? 0 };
}

async function entries() {
  return handle.db.select().from(auditLog).orderBy(asc(auditLog.seq));
}

async function reconciliations() {
  return (await entries()).filter((row) => row.entryType === "reconciliation");
}

describe("POST /webhooks/paypal", () => {
  it(
    "reconciles a verified refund event against the result that names the refund",
    async () => {
      const { resultSeq } = await seedExecuted();
      // The event body says $1.00; the log keeps the refund as re-read, $18.00.
      const body = eventBody("WH-EVENT-1", "REFUND-1");
      const answer = await post(appWith(), body);

      expect(answer.status).toBe(200);
      const [row, ...rest] = await reconciliations();
      expect(rest).toHaveLength(0);
      expect(row?.refId).toBe(INTENT);
      expect(row?.at).toBe(AT.toISOString());
      expect(ReconciliationPayloadSchema.parse(JSON.parse(row?.payload ?? ""))).toEqual({
        source: "webhook",
        event: { id: "WH-EVENT-1", type: "PAYMENT.CAPTURE.REFUNDED" },
        refund: { id: "REFUND-1", captureId: CAPTURE, status: "COMPLETED", amount: usd(1800) },
        resultSeq,
      });
      // The signature was checked over the exact raw body, with the webhook ID.
      const verify = sandbox.calls.find((call) => call.call === "verifyWebhookSignature");
      expect(verify?.arg).toEqual({
        webhookId: WEBHOOK_ID,
        transmission: {
          transmissionId: TRANSMISSION["paypal-transmission-id"],
          transmissionTime: TRANSMISSION["paypal-transmission-time"],
          certUrl: TRANSMISSION["paypal-cert-url"],
          authAlgo: TRANSMISSION["paypal-auth-algo"],
          transmissionSig: TRANSMISSION["paypal-transmission-sig"],
        },
        rawBody: body,
      });
      expect(
        sandbox.calls.some((call) => call.call === "getRefund" && call.arg === "REFUND-1"),
      ).toBe(true);
      expect((await verifyLog(handle.db)).intact).toBe(true);
    },
    SLOW,
  );

  it("answers a redelivered event 200 and writes nothing", async () => {
    await seedExecuted();
    const app = appWith();
    await post(app, eventBody("WH-EVENT-1", "REFUND-1"));
    const before = await entries();

    const again = await post(app, eventBody("WH-EVENT-1", "REFUND-1"));

    expect(again.status).toBe(200);
    expect(await entries()).toEqual(before);
  });

  it("logs a refund nobody requested with a null ref", async () => {
    await seedExecuted();
    const answer = await post(appWith(), eventBody("WH-EVENT-2", "REFUND-DASH"));

    expect(answer.status).toBe(200);
    const [row] = await reconciliations();
    expect(row?.refId).toBeNull();
    const payload = ReconciliationPayloadSchema.parse(JSON.parse(row?.payload ?? ""));
    expect(payload.resultSeq).toBeNull();
    expect(payload.refund).toEqual({
      id: "REFUND-DASH",
      captureId: "CAP-1036",
      status: "COMPLETED",
      amount: usd(500),
    });
  });

  describe("refuses without writing anything", () => {
    const writesNothing = async (answer: Promise<Injected>, status: number) => {
      await seedExecuted();
      const before = await entries();
      expect((await answer).status).toBe(status);
      expect(await entries()).toEqual(before);
    };

    it("400 for a missing transmission header", async () => {
      const { "paypal-transmission-sig": _, ...headers } = TRANSMISSION;
      await writesNothing(
        post(appWith(), eventBody("WH-E", "REFUND-1"), headers as typeof TRANSMISSION),
        400,
      );
      expect(sandbox.calls).toHaveLength(0);
    });

    it("400 for a malformed transmission header", async () => {
      const headers = { ...TRANSMISSION, "paypal-cert-url": "not a url" };
      await writesNothing(post(appWith(), eventBody("WH-E", "REFUND-1"), headers), 400);
      expect(sandbox.calls).toHaveLength(0);
    });

    it("400 for an empty body", async () => {
      await writesNothing(
        inject(appWith(), { path: "/webhooks/paypal", headers: TRANSMISSION }),
        400,
      );
    });

    it("400 for a body the rail client refuses to verify", async () => {
      sandbox.failures.verifyWebhookSignature = new PayPalError({
        kind: "invalid_request",
        call: "verify-webhook-signature",
        status: null,
      });
      await writesNothing(post(appWith(), "[1, 2]"), 400);
    });

    it("400 for a verified event that can't be read", async () => {
      await writesNothing(post(appWith(), JSON.stringify({ event_type: 7 })), 400);
      await writesNothing(
        post(appWith(), JSON.stringify({ id: "WH-E", event_type: "PAYMENT.CAPTURE.REFUNDED" })),
        400,
      );
    });

    it("400 for a failed signature", async () => {
      sandbox.webhookVerification = "fail";
      await writesNothing(post(appWith(), eventBody("WH-E", "REFUND-1")), 400);
      expect(sandbox.calls.some((call) => call.call === "getRefund")).toBe(false);
    });

    it("503 when PAYPAL_WEBHOOK_ID is missing", async () => {
      const { PAYPAL_WEBHOOK_ID: _, ...env } = ENV;
      await writesNothing(post(appWith({ env }), eventBody("WH-E", "REFUND-1")), 503);
      expect(sandbox.calls).toHaveLength(0);
    });

    it("503 when the verification can't complete", async () => {
      sandbox.failures.verifyWebhookSignature = httpError("verify-webhook-signature", 500);
      await writesNothing(post(appWith(), eventBody("WH-E", "REFUND-1")), 503);
      sandbox.failures.verifyWebhookSignature = new PayPalError({
        kind: "network",
        call: "verify-webhook-signature",
        status: null,
      });
      await writesNothing(post(appWith(), eventBody("WH-E", "REFUND-1")), 503);
    });

    it("503 when the rail client can't be built", async () => {
      const rail = () => {
        throw new Error("PAYPAL_CLIENT_SECRET is missing.");
      };
      await writesNothing(post(appWith({ rail }), eventBody("WH-E", "REFUND-1")), 503);
    });

    it("503 when the refund can't be read", async () => {
      sandbox.failures.getRefund = httpError("get-refund", 404, "RESOURCE_NOT_FOUND");
      await writesNothing(post(appWith(), eventBody("WH-E", "REFUND-1")), 503);
    });

    it("503 when the database is missing", async () => {
      await writesNothing(post(appWith({ db: undefined }), eventBody("WH-E", "REFUND-1")), 503);
    });
  });

  it("answers other event types 200 and writes nothing", async () => {
    await seedExecuted();
    const before = await entries();
    for (const [id, type] of [
      ["WH-EVENT-3", "PAYMENT.CAPTURE.COMPLETED"],
      ["WH-EVENT-6", "CUSTOMER.DISPUTE.UPDATED"],
      ["WH-EVENT-7", "CUSTOMER.DISPUTE.RESOLVED"],
    ] as const) {
      const answer = await post(appWith(), disputeBody(id, DISPUTE, type));
      expect(answer.status).toBe(200);
      expect(JSON.parse(answer.text)).toEqual({ message: "Event type not handled." });
    }

    expect(await entries()).toEqual(before);
    expect(sandbox.calls.some((call) => call.call === "getRefund")).toBe(false);
    expect(sandbox.calls.some((call) => call.call === "getDispute")).toBe(false);
  });

  it("refuses a body over 64 KB before verifying it", async () => {
    const body = JSON.stringify({ id: "WH-BIG", padding: "x".repeat(70 * 1024) });
    const answer = await post(appWith(), body);

    expect(answer.status).toBe(413);
    expect(sandbox.calls).toHaveLength(0);
    expect(await entries()).toHaveLength(0);
  });

  describe("never reveals the body, a header or a secret", () => {
    const spies: ReturnType<typeof vi.spyOn>[] = [];
    beforeEach(() => {
      for (const method of ["log", "info", "warn", "error", "debug"] as const) {
        spies.push(vi.spyOn(console, method).mockImplementation(() => {}));
      }
    });
    afterEach(() => {
      for (const spy of spies.splice(0)) spy.mockRestore();
    });

    it("in any answer or log line", async () => {
      await seedExecuted();
      const body = eventBody("WH-EVENT-4", "REFUND-1");
      const answers: Injected[] = [];
      answers.push(await post(appWith(), body));
      answers.push(await post(appWith(), body));
      answers.push(await post(appWith(), "{body-only-marker"));
      answers.push(await post(appWith({ env: {} }), body));
      sandbox.webhookVerification = "fail";
      answers.push(await post(appWith(), body));
      sandbox.webhookVerification = "pass";
      sandbox.failures.getRefund = httpError("get-refund", 500);
      answers.push(await post(appWith(), eventBody("WH-EVENT-5", "REFUND-1")));
      answers.push(await post(appWith(), JSON.stringify({ x: "y".repeat(70 * 1024) })));

      const logged = spies.flatMap((spy) => spy.mock.calls.flat().map(String));
      const said = [...answers.map((answer) => answer.text), ...logged].join("\n");
      expect(answers.map((answer) => answer.status)).toEqual([200, 200, 400, 503, 400, 503, 413]);
      for (const secret of [
        SECRET,
        WEBHOOK_ID,
        "body-only-marker",
        ...Object.values(TRANSMISSION),
      ]) {
        expect(said).not.toContain(secret);
      }
      for (const answer of answers) {
        expect(Object.keys(JSON.parse(answer.text))).toEqual(["message"]);
      }
    });
  });
});

describe("POST /webhooks/paypal with CUSTOMER.DISPUTE.CREATED", () => {
  type Nudge = { url: string; body: unknown };
  let nudges: Nudge[];
  let nudgeFetch: NudgeFetch;

  beforeEach(() => {
    nudges = [];
    nudgeFetch = async (url, init) => {
      nudges.push({ url, body: JSON.parse(init.body) });
      return { ok: true };
    };
    // The event body says $1.00 and RESOLVED; PayPal's record is what's logged.
    sandbox.disputeDetails.set(DISPUTE, {
      id: DISPUTE,
      status: "WAITING_FOR_SELLER_RESPONSE",
      amount: usd(24000),
      captureIds: [CAPTURE],
      reason: "MERCHANDISE_OR_SERVICE_NOT_RECEIVED",
      lifeCycleStage: "CHARGEBACK",
      sellerResponseDueDate: "2026-10-27T09:30:00.000Z",
    });
  });

  const disputeApp = (overrides: Partial<AppDeps> = {}) =>
    appWith({
      env: { ...ENV, RESOLVE_AGENT_URL: "http://resolve.test:8788" },
      fetch: nudgeFetch,
      ...overrides,
    });

  async function received() {
    return (await entries()).filter((row) => row.entryType === "dispute.received");
  }

  it(
    "appends one dispute.received from the re-read dispute and nudges Resolve once",
    async () => {
      const body = disputeBody("WH-DISPUTE-1", DISPUTE);
      const answer = await post(disputeApp(), body);

      expect(answer.status).toBe(200);
      expect(JSON.parse(answer.text)).toEqual({ message: "Recorded." });
      const [row, ...rest] = await received();
      expect(rest).toHaveLength(0);
      expect(row?.refId).toBe(DISPUTE);
      expect(row?.at).toBe(AT.toISOString());
      expect(DisputeReceivedPayloadSchema.parse(JSON.parse(row?.payload ?? ""))).toEqual({
        disputeId: DISPUTE,
        source: "webhook",
        event: { id: "WH-DISPUTE-1", type: "CUSTOMER.DISPUTE.CREATED" },
        dispute: {
          status: "WAITING_FOR_SELLER_RESPONSE",
          reason: "MERCHANDISE_OR_SERVICE_NOT_RECEIVED",
          lifeCycleStage: "CHARGEBACK",
          amount: usd(24000),
          sellerResponseDueDate: "2026-10-27T09:30:00.000Z",
          captureIds: [CAPTURE],
        },
      });
      expect(row?.payload).not.toContain("body-only-marker");
      expect(sandbox.calls.find((call) => call.call === "verifyWebhookSignature")?.arg).toEqual(
        expect.objectContaining({ webhookId: WEBHOOK_ID, rawBody: body }),
      );
      expect(sandbox.calls.filter((call) => call.call === "getDispute")).toEqual([
        { call: "getDispute", arg: DISPUTE },
      ]);
      expect(nudges).toEqual([
        { url: "http://resolve.test:8788/disputes", body: { dispute_id: DISPUTE } },
      ]);
      expect((await verifyLog(handle.db)).intact).toBe(true);
    },
    SLOW,
  );

  it("nudges the default Resolve address when RESOLVE_AGENT_URL is unset", async () => {
    await post(disputeApp({ env: ENV }), disputeBody("WH-DISPUTE-1", DISPUTE));
    expect(nudges.map((nudge) => nudge.url)).toEqual(["http://127.0.0.1:8788/disputes"]);
  });

  it('answers a redelivered event ID "Already recorded." and writes or nudges nothing', async () => {
    const app = disputeApp();
    await post(app, disputeBody("WH-DISPUTE-1", DISPUTE));
    const before = await entries();
    nudges.length = 0;

    const again = await post(app, disputeBody("WH-DISPUTE-1", DISPUTE));

    expect(again.status).toBe(200);
    expect(JSON.parse(again.text)).toEqual({ message: "Already recorded." });
    expect(await entries()).toEqual(before);
    expect(nudges).toHaveLength(0);
  });

  it("gives the same answer whatever the nudge does", async () => {
    const failing: NudgeFetch = async () => {
      throw new Error("connect ECONNREFUSED");
    };
    const refusing: NudgeFetch = async () => ({ ok: false });
    // Never settles: the answer doesn't wait for it.
    const hanging: NudgeFetch = () => new Promise(() => {});
    const thrower: NudgeFetch = () => {
      throw new Error("sync failure");
    };
    const answers: Injected[] = [];
    for (const [index, fetch] of [failing, refusing, hanging, thrower].entries()) {
      answers.push(await post(disputeApp({ fetch }), disputeBody(`WH-DISPUTE-${index}`, DISPUTE)));
    }

    expect(answers.map((answer) => [answer.status, JSON.parse(answer.text).message])).toEqual([
      [200, "Recorded."],
      [200, "Recorded."],
      [200, "Recorded."],
      [200, "Recorded."],
    ]);
    expect(await received()).toHaveLength(4);
  });

  describe("refuses without writing or nudging", () => {
    const writesNothing = async (answer: Promise<Injected>, status: number) => {
      await seedExecuted();
      const before = await entries();
      expect((await answer).status).toBe(status);
      expect(await entries()).toEqual(before);
      expect(nudges).toHaveLength(0);
    };

    it("400 for a bad signature, before reading the dispute", async () => {
      sandbox.webhookVerification = "fail";
      await writesNothing(post(disputeApp(), disputeBody("WH-D", DISPUTE)), 400);
      expect(sandbox.calls.some((call) => call.call === "getDispute")).toBe(false);
    });

    it("400 for a missing or malformed dispute_id", async () => {
      await writesNothing(post(disputeApp(), disputeBody("WH-D", undefined)), 400);
      await writesNothing(post(disputeApp(), disputeBody("WH-D", " ")), 400);
      await writesNothing(post(disputeApp(), disputeBody("WH-D", 42)), 400);
      expect(sandbox.calls.some((call) => call.call === "getDispute")).toBe(false);
    });

    it("503 when the dispute can't be re-read", async () => {
      await writesNothing(post(disputeApp(), disputeBody("WH-D", "PP-D-UNKNOWN")), 503);
      sandbox.failures.getDispute = httpError("get-dispute", 500);
      await writesNothing(post(disputeApp(), disputeBody("WH-D", DISPUTE)), 503);
    });

    it("503 when the re-read dispute can't be recorded as it is", async () => {
      sandbox.disputeDetails.set(DISPUTE, {
        id: DISPUTE,
        status: "WAITING_FOR_SELLER_RESPONSE",
        amount: { minor: 1.5, currency: "USD" },
        captureIds: [CAPTURE],
      });
      await writesNothing(post(disputeApp(), disputeBody("WH-D", DISPUTE)), 503);
    });

    it("503 when a dispute.received entry can't be read", async () => {
      const bad = await appendEntries(handle.db, [
        { entryType: "dispute.received", refId: DISPUTE, at: AT.toISOString(), payload: "x" },
      ]);
      expect(bad.ok).toBe(true);
      const before = await entries();
      const answer = await post(disputeApp(), disputeBody("WH-D", DISPUTE));
      expect(answer.status).toBe(503);
      expect(await entries()).toEqual(before);
      expect(nudges).toHaveLength(0);
    });

    it("503 when the log can't be written", async () => {
      await handle.db.execute(sql`
        CREATE FUNCTION test_refuse_insert() RETURNS trigger AS $$
        BEGIN RAISE EXCEPTION 'refused'; END; $$ LANGUAGE plpgsql`);
      await handle.db.execute(sql`
        CREATE TRIGGER test_refuse_insert BEFORE INSERT ON audit_log
        FOR EACH ROW EXECUTE FUNCTION test_refuse_insert()`);
      try {
        const answer = await post(disputeApp(), disputeBody("WH-D", DISPUTE));
        expect(answer.status).toBe(503);
        expect(await entries()).toHaveLength(0);
        expect(nudges).toHaveLength(0);
      } finally {
        await handle.db.execute(sql`DROP TRIGGER test_refuse_insert ON audit_log`);
        await handle.db.execute(sql`DROP FUNCTION test_refuse_insert()`);
      }
    });

    it("503 when the database is missing", async () => {
      await writesNothing(post(disputeApp({ db: undefined }), disputeBody("WH-D", DISPUTE)), 503);
    });
  });

  it("still reconciles refund events beside dispute ones", async () => {
    await seedExecuted();
    const app = disputeApp();
    expect((await post(app, disputeBody("WH-DISPUTE-1", DISPUTE))).status).toBe(200);
    const refund = await post(app, eventBody("WH-EVENT-1", "REFUND-1"));

    expect(JSON.parse(refund.text)).toEqual({ message: "Reconciled." });
    expect(await reconciliations()).toHaveLength(1);
    expect(await received()).toHaveLength(1);
    expect(nudges).toHaveLength(1);
  });
});

describe("POST /webhooks/paypal with PAYMENT.PAYOUTS-ITEM.*", () => {
  type PayoutFixture = {
    headers: typeof TRANSMISSION;
    body: { id: string; resource: { payout_item_id: string; sender_batch_id: string } };
  };
  const fixture = JSON.parse(
    readFileSync(new URL("../webhooks/payout-item-succeeded.json", import.meta.url), "utf8"),
  ) as PayoutFixture;
  const PAYOUT_INTENT = fixture.body.resource.sender_batch_id;
  const ITEM = fixture.body.resource.payout_item_id;
  const BATCH = "5UXD2E8A7EBQJ";
  const PAYEE = "dyeworks@example.com";

  const payoutBody = (id: string, itemId: unknown, type = "PAYMENT.PAYOUTS-ITEM.SUCCEEDED") =>
    JSON.stringify({
      id,
      event_type: type,
      resource_type: "payouts_item",
      summary: "A body-only-marker payout summary",
      resource: {
        payout_item_id: itemId,
        transaction_status: "SUCCESS",
        payout_batch_id: "BODYBATCH",
        sender_batch_id: "int_body-only-marker",
        payout_item: { amount: { currency: "USD", value: "1.00" }, receiver: "x@example.com" },
      },
    });

  const sandboxItem = (overrides: Record<string, unknown> = {}) => ({
    itemId: ITEM,
    batchId: BATCH,
    senderBatchId: PAYOUT_INTENT,
    status: "SUCCESS",
    amount: usd(4500),
    receiver: PAYEE,
    senderItemId: "KDW-2026-0412",
    errorName: null,
    timeProcessed: "2026-10-24T07:40:11Z",
    ...overrides,
  });

  beforeEach(() => {
    sandbox.payoutItems.set(ITEM, sandboxItem());
  });

  // The ops agent's payout, sent and read back with its item unclaimed.
  async function seedPayout(
    result: "executed" | "unknown" = "executed",
  ): Promise<{ resultSeq: number }> {
    const written = await appendEntries(handle.db, [
      executionRequestedEntry({
        at: "2026-10-24T07:30:00.000Z",
        intentId: PAYOUT_INTENT,
        intentHash: "b".repeat(64),
        principal: "ops-agent",
        rail: "paypal",
        action: "paypal.payout",
        target: { email: PAYEE },
        amount: usd(4500),
        approvalSeq: 1,
      }),
      executionResultEntry(
        result === "executed"
          ? {
              at: "2026-10-24T07:30:01.000Z",
              intentId: PAYOUT_INTENT,
              requestSeq: 1,
              outcome: "executed",
              payout: {
                batchId: BATCH,
                batchStatus: "PENDING",
                item: { id: ITEM, status: "UNCLAIMED" },
              },
            }
          : {
              at: "2026-10-24T07:30:01.000Z",
              intentId: PAYOUT_INTENT,
              requestSeq: 1,
              outcome: "unknown",
            },
      ),
    ]);
    if (!written.ok) throw new Error(written.rejection.detail);
    return { resultSeq: written.entries[1]?.seq ?? 0 };
  }

  const handle_ = (body: string, overrides: Partial<WebhookDeps> = {}) =>
    handlePayPalWebhook(
      { headers: TRANSMISSION, body: Buffer.from(body) },
      { db: handle.db, rail: () => sandbox, env: ENV, clock: () => AT, ...overrides },
    );

  const payloadOf = (row: { payload: string } | undefined) =>
    ReconciliationPayloadSchema.parse(JSON.parse(row?.payload ?? ""));

  it(
    "reconciles the signed fixture once, from the item as re-read",
    async () => {
      const { resultSeq } = await seedPayout();
      const body = JSON.stringify(fixture.body);
      const answer = await post(appWith(), body, fixture.headers);

      expect(answer.status).toBe(200);
      expect(JSON.parse(answer.text)).toEqual({ message: "Reconciled." });
      const [row, ...rest] = await reconciliations();
      expect(rest).toHaveLength(0);
      expect(row?.refId).toBe(PAYOUT_INTENT);
      expect(row?.at).toBe(AT.toISOString());
      expect(payloadOf(row)).toEqual({
        source: "webhook",
        event: { id: fixture.body.id, type: "PAYMENT.PAYOUTS-ITEM.SUCCEEDED" },
        payout: { batchId: BATCH, itemId: ITEM, status: "SUCCESS", amount: usd(4500) },
        resultSeq,
      });
      expect(sandbox.calls.find((call) => call.call === "verifyWebhookSignature")?.arg).toEqual(
        expect.objectContaining({ webhookId: WEBHOOK_ID, rawBody: body }),
      );
      expect(sandbox.calls.filter((call) => call.call === "getPayoutItem")).toEqual([
        { call: "getPayoutItem", arg: ITEM },
      ]);
      expect((await verifyLog(handle.db)).intact).toBe(true);
    },
    SLOW,
  );

  it("logs the item as PayPal has it, never the event body", async () => {
    await seedPayout();
    sandbox.payoutItems.set(ITEM, sandboxItem({ status: "UNCLAIMED" }));
    const answer = await handle_(payoutBody("WH-PAYOUT-1", ITEM));

    expect(answer).toEqual({ status: 200, message: "Reconciled." });
    const [row] = await reconciliations();
    expect(row?.payload).not.toContain("body-only-marker");
    expect(payloadOf(row)).toMatchObject({
      payout: { batchId: BATCH, itemId: ITEM, status: "UNCLAIMED", amount: usd(4500) },
    });
  });

  it('answers a redelivered event ID "Already reconciled." and writes nothing', async () => {
    await seedPayout();
    await handle_(payoutBody("WH-PAYOUT-1", ITEM));
    const before = await entries();
    const reads = sandbox.calls.filter((call) => call.call === "getPayoutItem").length;

    const again = await handle_(payoutBody("WH-PAYOUT-1", ITEM, "PAYMENT.PAYOUTS-ITEM.UNCLAIMED"));

    expect(again).toEqual({ status: 200, message: "Already reconciled." });
    expect(await entries()).toEqual(before);
    expect(sandbox.calls.filter((call) => call.call === "getPayoutItem")).toHaveLength(reads);
  });

  it("handles any PAYMENT.PAYOUTS-ITEM.* event type", async () => {
    await seedPayout();
    const types = ["UNCLAIMED", "RETURNED", "FAILED", "BLOCKED", "HELD", "REFUNDED", "DENIED"];
    for (const [index, type] of types.entries()) {
      const answer = await handle_(
        payoutBody(`WH-PAYOUT-${index}`, ITEM, `PAYMENT.PAYOUTS-ITEM.${type}`),
      );
      expect(answer).toEqual({ status: 200, message: "Reconciled." });
    }
    expect(await reconciliations()).toHaveLength(types.length);
  });

  it("links a payout whose result is unknown to its intent, with no result", async () => {
    await seedPayout("unknown");
    expect((await handle_(payoutBody("WH-PAYOUT-1", ITEM))).status).toBe(200);

    const [row] = await reconciliations();
    expect(row?.refId).toBe(PAYOUT_INTENT);
    expect(payloadOf(row).resultSeq).toBeNull();
  });

  describe("logs an item of a batch Countersign didn't send with a null ref and no result", () => {
    it("when no request names its sender_batch_id", async () => {
      await seedExecuted();
      sandbox.payoutItems.set(ITEM, sandboxItem({ senderBatchId: "someone-elses-batch" }));
      expect(await handle_(payoutBody("WH-PAYOUT-1", ITEM))).toEqual({
        status: 200,
        message: "Reconciled.",
      });

      const [row] = await reconciliations();
      expect(row?.refId).toBeNull();
      expect(payloadOf(row).resultSeq).toBeNull();
      expect(payloadOf(row)).toMatchObject({ payout: { batchId: BATCH, itemId: ITEM } });
    });

    it("when PayPal gives no sender_batch_id", async () => {
      await seedPayout();
      sandbox.payoutItems.set(ITEM, sandboxItem({ senderBatchId: null }));
      await handle_(payoutBody("WH-PAYOUT-1", ITEM));

      const [row] = await reconciliations();
      expect(row?.refId).toBeNull();
      expect(payloadOf(row).resultSeq).toBeNull();
    });

    it("when the intent's executed result names another batch", async () => {
      await seedPayout();
      sandbox.payoutItems.set(ITEM, sandboxItem({ batchId: "OTHERBATCH01" }));
      await handle_(payoutBody("WH-PAYOUT-1", ITEM));

      const [row] = await reconciliations();
      expect(row?.refId).toBeNull();
      expect(payloadOf(row).resultSeq).toBeNull();
    });
  });

  describe("refuses without writing anything", () => {
    const writesNothing = async (answer: () => Promise<{ status: number }>, status: number) => {
      await seedPayout();
      const before = await entries();
      expect((await answer()).status).toBe(status);
      expect(await entries()).toEqual(before);
    };

    it("400 for a missing or malformed payout_item_id, before any read", async () => {
      await writesNothing(() => handle_(payoutBody("WH-P", undefined)), 400);
      await writesNothing(() => handle_(payoutBody("WH-P", " ")), 400);
      await writesNothing(() => handle_(payoutBody("WH-P", 42)), 400);
      expect(sandbox.calls.some((call) => call.call === "getPayoutItem")).toBe(false);
    });

    it("400 for a bad signature, before reading the item", async () => {
      sandbox.webhookVerification = "fail";
      await writesNothing(() => handle_(payoutBody("WH-P", ITEM)), 400);
      expect(sandbox.calls.some((call) => call.call === "getPayoutItem")).toBe(false);
    });

    it("503 when the item can't be re-read", async () => {
      await writesNothing(() => handle_(payoutBody("WH-P", "UNKNOWNITEM1")), 503);
      sandbox.failures.getPayoutItem = httpError("get-payout-item", 500);
      await writesNothing(() => handle_(payoutBody("WH-P", ITEM)), 503);
    });

    it("503 when the re-read item can't be recorded as it is", async () => {
      sandbox.payoutItems.set(ITEM, sandboxItem({ amount: { minor: 1.5, currency: "USD" } }));
      await writesNothing(() => handle_(payoutBody("WH-P", ITEM)), 503);
    });

    it("503 when an entry in the log can't be read", async () => {
      const bad = await appendEntries(handle.db, [
        { entryType: "execution.result", refId: PAYOUT_INTENT, at: AT.toISOString(), payload: "x" },
      ]);
      expect(bad.ok).toBe(true);
      const before = await entries();
      expect(await handle_(payoutBody("WH-P", ITEM))).toEqual({
        status: 503,
        message: "Try again later.",
      });
      expect(await entries()).toEqual(before);
    });

    it("503 when the log can't be written", async () => {
      await seedPayout();
      await handle.db.execute(sql`
        CREATE FUNCTION test_refuse_insert() RETURNS trigger AS $$
        BEGIN RAISE EXCEPTION 'refused'; END; $$ LANGUAGE plpgsql`);
      await handle.db.execute(sql`
        CREATE TRIGGER test_refuse_insert BEFORE INSERT ON audit_log
        FOR EACH ROW EXECUTE FUNCTION test_refuse_insert()`);
      try {
        expect((await handle_(payoutBody("WH-P", ITEM))).status).toBe(503);
        expect(await reconciliations()).toHaveLength(0);
      } finally {
        await handle.db.execute(sql`DROP TRIGGER test_refuse_insert ON audit_log`);
        await handle.db.execute(sql`DROP FUNCTION test_refuse_insert()`);
      }
    });

    it("503 when the database is missing", async () => {
      await writesNothing(() => handle_(payoutBody("WH-P", ITEM), { db: undefined }), 503);
    });
  });

  it("acknowledges PAYMENT.PAYOUTSBATCH.* and ignores it", async () => {
    await seedPayout();
    const before = await entries();
    for (const [index, type] of ["PROCESSING", "SUCCESS", "DENIED"].entries()) {
      const answer = await post(
        appWith(),
        payoutBody(`WH-BATCH-${index}`, ITEM, `PAYMENT.PAYOUTSBATCH.${type}`),
      );
      expect(answer.status).toBe(200);
      expect(JSON.parse(answer.text)).toEqual({ message: "Event type not handled." });
    }
    expect(await entries()).toEqual(before);
    expect(sandbox.calls.some((call) => call.call === "getPayoutItem")).toBe(false);
  });

  it("still reconciles refunds and records disputes beside payouts", async () => {
    await seedExecuted();
    await seedPayout();
    sandbox.disputeDetails.set(DISPUTE, {
      id: DISPUTE,
      status: "WAITING_FOR_SELLER_RESPONSE",
      amount: usd(24000),
      captureIds: [CAPTURE],
    });
    const app = appWith({ fetch: async () => ({ ok: true }) });
    const answers = [
      await post(app, payoutBody("WH-PAYOUT-1", ITEM)),
      await post(app, eventBody("WH-EVENT-1", "REFUND-1")),
      await post(app, disputeBody("WH-DISPUTE-1", DISPUTE)),
    ];

    expect(answers.map((answer) => JSON.parse(answer.text).message)).toEqual([
      "Reconciled.",
      "Reconciled.",
      "Recorded.",
    ]);
    const rows = await reconciliations();
    expect(rows.map((row) => row.refId)).toEqual([PAYOUT_INTENT, INTENT]);
    expect(payloadOf(rows[1]).refund?.id).toBe("REFUND-1");
  });
});

describe("GET /health", () => {
  it("works with no dependencies", async () => {
    const answer = await inject(createApp(), { path: "/health", method: "GET" });
    expect(answer.status).toBe(200);
    expect(JSON.parse(answer.text)).toEqual({ ok: true });
  });

  it("leaves the webhook unavailable with no dependencies", async () => {
    const answer = await post(createApp(), eventBody("WH-E", "REFUND-1"));
    expect(answer.status).toBe(503);
  });
});
