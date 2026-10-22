import { createTestDatabase, type Database, type DatabaseHandle, sql } from "@countersign/db";
import { appendEntries, type EntryInput, verifyLog } from "@countersign/ledger";
import type { PayPalDisputeDetail } from "@countersign/rail-paypal";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  DisputeReceivedPayloadSchema,
  disputeReceivedEntry,
  readDisputeState,
} from "../src/dispute-log";

const SLOW = 60_000;
const T1 = "2026-10-18T09:00:00.000Z";

const dispute = (id: string, patch: Partial<PayPalDisputeDetail> = {}): PayPalDisputeDetail => ({
  id,
  status: "WAITING_FOR_SELLER_RESPONSE",
  reason: "MERCHANDISE_OR_SERVICE_NOT_RECEIVED",
  lifeCycleStage: "CHARGEBACK",
  amount: { minor: 24000, currency: "USD" },
  sellerResponseDueDate: "2026-10-28T09:00:00.000Z",
  captureIds: ["CAP-1"],
  linkNames: ["provide_evidence"],
  ...patch,
});

const viaWebhook = (id: string, eventId: string) =>
  disputeReceivedEntry({
    at: T1,
    source: "webhook",
    event: { id: eventId, type: "CUSTOMER.DISPUTE.CREATED" },
    dispute: dispute(id),
  });
const viaPoll = (id: string) =>
  disputeReceivedEntry({ at: T1, source: "poll", dispute: dispute(id) });

describe("the dispute.received entry", () => {
  let handle: DatabaseHandle;
  let db: Database;

  beforeAll(async () => {
    handle = await createTestDatabase();
    db = handle.db;
  }, SLOW);

  beforeEach(async () => {
    await db.execute(sql`TRUNCATE audit_log`);
  });

  afterAll(async () => {
    await handle.close();
  });

  const append = async (...inputs: EntryInput[]) => {
    const result = await appendEntries(db, inputs);
    if (!result.ok) throw new Error(`append rejected: ${result.rejection.detail}`);
    return result.entries;
  };

  it("is built from a re-read dispute for a webhook, ref the dispute ID", () => {
    const entry = viaWebhook("PP-D-1", "WH-1");
    expect(entry.entryType).toBe("dispute.received");
    expect(entry.refId).toBe("PP-D-1");
    expect(entry.payload).toEqual({
      disputeId: "PP-D-1",
      source: "webhook",
      event: { id: "WH-1", type: "CUSTOMER.DISPUTE.CREATED" },
      dispute: {
        status: "WAITING_FOR_SELLER_RESPONSE",
        reason: "MERCHANDISE_OR_SERVICE_NOT_RECEIVED",
        lifeCycleStage: "CHARGEBACK",
        amount: { minor: 24000, currency: "USD" },
        sellerResponseDueDate: "2026-10-28T09:00:00.000Z",
        captureIds: ["CAP-1"],
      },
    });
    expect(DisputeReceivedPayloadSchema.safeParse(entry.payload).success).toBe(true);
  });

  it("is built for a poll with a null event and no due date when PayPal has none", () => {
    const entry = disputeReceivedEntry({
      at: T1,
      source: "poll",
      dispute: dispute("PP-D-2", { sellerResponseDueDate: null, captureIds: [] }),
    });
    expect(entry.refId).toBe("PP-D-2");
    expect(entry.payload).toMatchObject({
      source: "poll",
      event: null,
      dispute: { sellerResponseDueDate: null, captureIds: [] },
    });
  });

  it("refuses a bad time or an amount that isn't integer minor units", () => {
    expect(() =>
      disputeReceivedEntry({ at: "yesterday", source: "poll", dispute: dispute("PP-D-1") }),
    ).toThrow();
    expect(() =>
      disputeReceivedEntry({
        at: T1,
        source: "poll",
        dispute: dispute("PP-D-1", { amount: { minor: 24.5, currency: "USD" } }),
      }),
    ).toThrow();
  });

  it("appends, verifies, and reads back the dispute and event IDs", async () => {
    await append(viaWebhook("PP-D-1", "WH-1"), viaPoll("PP-D-2"));
    expect(await verifyLog(db)).toMatchObject({ intact: true, entries: 2 });
    expect(await readDisputeState(db)).toEqual({
      known: true,
      state: {
        disputes: new Set(["PP-D-1", "PP-D-2"]),
        firstSeqs: new Map([
          ["PP-D-1", 1],
          ["PP-D-2", 2],
        ]),
        events: new Set(["WH-1"]),
      },
    });
  });

  it("reads an empty log as nothing recorded", async () => {
    expect(await readDisputeState(db)).toEqual({
      known: true,
      state: { disputes: new Set(), firstSeqs: new Map(), events: new Set() },
    });
  });

  const unreadable: [string, EntryInput][] = [
    [
      "a payload that isn't JSON",
      { entryType: "dispute.received", refId: "PP-D-1", at: T1, payload: "x" },
    ],
    [
      "a payload missing its dispute",
      {
        entryType: "dispute.received",
        refId: "PP-D-1",
        at: T1,
        payload: { disputeId: "PP-D-1", source: "poll", event: null },
      },
    ],
    ["a ref that isn't its dispute", { ...viaPoll("PP-D-1"), refId: "PP-D-9" }],
  ];

  it.each(unreadable)("makes the state unknown for %s", async (_name, bad) => {
    await append(viaPoll("PP-D-0"), bad);
    expect(await readDisputeState(db)).toMatchObject({ known: false, seq: 2 });
  });
});
