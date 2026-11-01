import { createTestDatabase, type Database, type DatabaseHandle, sql } from "@countersign/db";
import { appendEntries, type EntryInput } from "@countersign/ledger";
import type { PayPalClient } from "@countersign/rail-paypal";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { disputeReceivedEntry, readDisputeState } from "../src/dispute-log";
import { syncDisputes } from "../src/dispute-sync";
import type { NudgeFetch } from "../src/nudge";
import {
  createFakeSandbox,
  type DisputeDetailSeed,
  type FakeSandbox,
  httpError,
} from "./fake-sandbox";

const SLOW = 60_000;
const NOW = new Date("2026-10-20T12:00:00.000Z");
const ENV = { RESOLVE_AGENT_URL: "http://resolve.test:8788" };
const usd = (minor: number) => ({ minor, currency: "USD" as const });

function seed(id: string, extra: Partial<DisputeDetailSeed> = {}): DisputeDetailSeed {
  return {
    id,
    status: "WAITING_FOR_SELLER_RESPONSE",
    amount: usd(24000),
    captureIds: [`CAP-${id}`],
    reason: "MERCHANDISE_OR_SERVICE_NOT_RECEIVED",
    sellerResponseDueDate: "2026-10-30T23:59:59.000Z",
    ...extra,
  };
}

function sandboxWith(...disputes: DisputeDetailSeed[]): FakeSandbox {
  const rail = createFakeSandbox();
  for (const dispute of disputes) {
    rail.disputeDetails.set(dispute.id, dispute);
    rail.merchantDisputes.push({ id: dispute.id, status: dispute.status });
  }
  return rail;
}

const nudgeFetch: NudgeFetch = async () => ({ ok: true });

describe("syncDisputes", () => {
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

  const deps = { now: () => NOW, env: ENV, nudgeFetch };

  async function append(...entries: EntryInput[]) {
    const written = await appendEntries(db, entries);
    if (!written.ok) throw new Error(written.rejection.detail);
  }

  const recordedEntry = (id: string) =>
    disputeReceivedEntry({
      at: "2026-10-19T09:00:00.000Z",
      source: "poll",
      dispute: {
        reason: "MERCHANDISE_OR_SERVICE_NOT_RECEIVED",
        lifeCycleStage: "INQUIRY",
        sellerResponseDueDate: null,
        linkNames: [],
        ...seed(id),
      },
    });

  it("counts recorded, already recorded and problem disputes, with the CLI's lines", async () => {
    await append(recordedEntry("PP-D-1"));
    const rail = sandboxWith(seed("PP-D-1"), seed("PP-D-2"), seed("PP-D-3"));
    // PP-D-3 is listed but can't be re-read.
    rail.disputeDetails.delete("PP-D-3");
    const result = await syncDisputes(db, rail, deps);
    expect(result).toMatchObject({ ok: true, recorded: 1, alreadyRecorded: 1, problems: 1 });
    if (!result.ok) return;
    expect(result.lines).toEqual([
      "Already recorded PP-D-1.",
      "Recorded dispute PP-D-2 on capture CAP-PP-D-2 for $240.00.",
      expect.stringContaining("Couldn't re-read PP-D-3: get-dispute failed with HTTP 404"),
    ]);
    const state = await readDisputeState(db);
    expect(state.known && [...state.state.disputes].sort()).toEqual(["PP-D-1", "PP-D-2"]);
  });

  it("is idempotent: a second sync records nothing new", async () => {
    const rail = sandboxWith(seed("PP-D-1"));
    await syncDisputes(db, rail, deps);
    const again = await syncDisputes(db, rail, deps);
    expect(again).toMatchObject({ ok: true, recorded: 0, alreadyRecorded: 1, problems: 0 });
  });

  it("says so when no dispute is waiting", async () => {
    const result = await syncDisputes(db, sandboxWith(), deps);
    expect(result).toEqual({
      ok: true,
      lines: ["No disputes are waiting for the seller."],
      recorded: 0,
      alreadyRecorded: 0,
      problems: 0,
    });
  });

  it("can't run when the log holds an entry it can't read", async () => {
    await append({
      entryType: "dispute.received",
      refId: "PP-D-1",
      at: "2026-10-19T09:00:00.000Z",
      payload: "x",
    });
    const rail = sandboxWith(seed("PP-D-2"));
    const result = await syncDisputes(db, rail, deps);
    expect(result).toMatchObject({ ok: false, lines: [] });
    if (result.ok) return;
    expect(result.error).toContain("The audit log has an entry that can't be read:");
    expect(rail.calls).toEqual([]);
  });

  it("can't run when PayPal's list can't be read", async () => {
    const rail = sandboxWith(seed("PP-D-1"));
    rail.failures.listMerchantDisputes = httpError("list-merchant-disputes", 500);
    const result = await syncDisputes(db, rail, deps);
    expect(result).toMatchObject({ ok: false, lines: [] });
    if (result.ok) return;
    expect(result.error).toContain("Couldn't list the merchant's disputes:");
    expect(result.error).toContain("list-merchant-disputes failed with HTTP 500");
    expect(await readDisputeState(db)).toMatchObject({ known: true });
  });

  it("stops, keeping what it recorded, when an entry turns unreadable inside the lock", async () => {
    const rail = sandboxWith(seed("PP-D-1"), seed("PP-D-2"));
    // Between reading PP-D-2 and recording it, something writes an entry that can't be read.
    const getDispute: PayPalClient["getDispute"] = rail.getDispute.bind(rail);
    const racing: PayPalClient = {
      ...rail,
      getDispute: async (id) => {
        const dispute = await getDispute(id);
        if (id === "PP-D-2") {
          await append({
            entryType: "dispute.received",
            refId: "PP-D-9",
            at: "2026-10-20T11:00:00.000Z",
            payload: "x",
          });
        }
        return dispute;
      },
    };
    const result = await syncDisputes(db, racing, deps);
    expect(result).toEqual({
      ok: false,
      error: "PP-D-2 wasn't recorded: the audit log has an entry that can't be read.",
      lines: ["Recorded dispute PP-D-1 on capture CAP-PP-D-1 for $240.00."],
    });
  });

  it("reports an unreachable Resolve and counts the dispute as recorded", async () => {
    const down: NudgeFetch = async () => {
      throw new Error("connect ECONNREFUSED");
    };
    const result = await syncDisputes(db, sandboxWith(seed("PP-D-1")), {
      ...deps,
      nudgeFetch: down,
    });
    expect(result).toMatchObject({ ok: true, recorded: 1, problems: 0 });
    if (!result.ok) return;
    expect(result.lines).toContain(
      "Resolve wasn't reachable; run npm run resolve -- dispute PP-D-1.",
    );
  });
});
