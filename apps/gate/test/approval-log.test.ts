import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createMemoryShipmentStore, createMockCarrier } from "@countersign/carrier-mock";
import {
  createTestDatabase,
  type Database,
  type DatabaseHandle,
  sql,
  writeTicket,
} from "@countersign/db";
import { appendEntries, type EntryInput, verifyLog } from "@countersign/ledger";
import { parseMandate } from "@countersign/mandate";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  type ApprovalInput,
  approvalEntry,
  RECENT_STEP_UPS,
  readStepUp,
  readStepUps,
  type StepUp,
} from "../src/approval-log";
import { APPROVAL_WINDOW_MS } from "../src/decide";
import { propose as runPropose } from "../src/propose";
import { createFakeSandbox } from "./fake-sandbox";

// Each PGlite start takes a couple of seconds.
const SLOW = 60_000;
const NOW = new Date("2026-10-17T09:00:00+03:00");
const LATER = new Date(NOW.getTime() + 5 * 60 * 1000);
const PAST_EXPIRY = new Date(NOW.getTime() + APPROVAL_WINDOW_MS + 1);
const PRINCIPAL = "support-agent";

const mandateFile = fileURLToPath(
  new URL("../../../packages/mandate/fixtures/kikapu-studio-v3.json", import.meta.url),
);
const parsedMandate = parseMandate(JSON.parse(readFileSync(mandateFile, "utf8")));
if (!parsedMandate.ok) throw new Error(parsedMandate.error);
const mandate = parsedMandate.mandate;

const usd = (minor: number) => ({ minor, currency: "USD" as const });

// Beat 5 on illustrative records: the payer of KIK-1037 asks for $240.00 back for a damaged
// basket, with a photo. Every check passes, but it's above the agent's own limit.
const PAYER = "wanjiru.m@example.com";

function beat5World() {
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

const beat5 = (ticketId: string, value = "240.00") => ({
  tool: "create_refund",
  args: { capture_id: "CAP-1037", amount: { value, currency_code: "USD" } },
  justification: { ticket_id: ticketId, claim: "damaged" },
});

const storeTicket = (db: Database, id: string, senderEmail: string) =>
  writeTicket(db, {
    id,
    channel: "email",
    senderEmail,
    senderPhone: null,
    subject: null,
    body: "Simulated ticket.",
    attachments: [{ id: `ATT-${id}`, contentType: "image/jpeg" }],
    receivedAt: "2026-10-17T08:00:00+03:00",
    simulated: true,
  });

describe("the step-up reader and approval entries", { timeout: SLOW }, () => {
  let handle: DatabaseHandle;
  let db: Database;

  beforeAll(async () => {
    handle = await createTestDatabase();
    db = handle.db;
  }, SLOW);

  beforeEach(async () => {
    await db.execute(sql`TRUNCATE audit_log, tickets`);
    await storeTicket(db, "TKT-1037", PAYER);
  });

  afterAll(async () => {
    await handle.close();
  });

  // Proposes beat 5 through propose(), and returns its decision entry's seq.
  const proposeBeat5 = async (proposal: unknown = beat5("TKT-1037")) => {
    const world = beat5World();
    const result = await runPropose({
      mandate,
      principal: PRINCIPAL,
      proposal,
      now: NOW,
      rail: world.rail,
      carrier: world.carrier,
      db,
    });
    if (!result.ok || result.replay) throw new Error("beat 5 wasn't decided");
    return result;
  };

  const stepUp = async () => {
    const result = await proposeBeat5();
    expect(result.record.decision).toBe("step_up");
    const { intentId, intentHash } = result.record;
    if (intentId === null || intentHash === null) throw new Error("no intent");
    return { seq: result.seqs.decision, intentId, intentHash };
  };

  const answer = (
    held: { seq: number; intentId: string; intentHash: string },
    payload: Partial<ApprovalInput> = {},
  ) =>
    approvalEntry({
      at: LATER.toISOString(),
      intentId: held.intentId,
      stepUpSeq: held.seq,
      intentHash: held.intentHash,
      answer: "deny",
      outcome: "denied",
      approver: "merchant",
      channel: "approvals_page",
      ...payload,
    } as ApprovalInput);

  const append = async (entries: EntryInput[]) => {
    const result = await appendEntries(db, entries);
    if (!result.ok) throw new Error(result.rejection.detail);
    return result.entries;
  };

  const listAt = async (now: Date) => {
    const read = await readStepUps(db, now);
    if (!read.known) throw new Error(read.detail);
    return read;
  };

  const seqs = (stepUps: readonly StepUp[]) => stepUps.map((held) => held.seq);

  it("reads beat 5's step-up as one open card, then as answered after a deny, with the log intact", async () => {
    const held = await stepUp();

    const before = await listAt(LATER);
    expect(seqs(before.open)).toEqual([held.seq]);
    expect(before.recent).toEqual([]);
    const [card] = before.open;
    expect(card).toMatchObject({
      seq: held.seq,
      intentId: held.intentId,
      intentHash: held.intentHash,
      principal: PRINCIPAL,
      state: "open",
      answer: null,
      decidedAt: NOW.toISOString(),
      expiresAt: new Date(NOW.getTime() + APPROVAL_WINDOW_MS).toISOString(),
      intent: {
        action: "paypal.refund",
        amount: usd(24000),
        target: { kind: "capture", captureId: "CAP-1037" },
        ticketId: "TKT-1037",
        claim: "damaged",
      },
    });
    expect(card?.reasons.map((reason) => reason.code)).toEqual(["ABOVE_AUTO_LIMIT"]);
    expect(card?.trace.length).toBeGreaterThan(0);
    expect(await readStepUp(db, held.seq, LATER)).toEqual({ known: true, stepUp: card });

    const [denied] = await append([answer(held)]);
    const after = await listAt(LATER);
    expect(after.open).toEqual([]);
    expect(seqs(after.recent)).toEqual([held.seq]);
    expect(after.recent[0]).toMatchObject({
      state: "answered",
      answer: {
        seq: denied?.seq,
        at: LATER.toISOString(),
        outcome: "denied",
        channel: "approvals_page",
      },
    });
    const one = await readStepUp(db, held.seq, LATER);
    expect(one.known && one.stepUp?.state).toBe("answered");
    expect((await verifyLog(db)).intact).toBe(true);
  });

  it("reads an approved answer as answered", async () => {
    const held = await stepUp();
    await append([answer(held, { answer: "approve", outcome: "approved", channel: "cli" })]);
    const read = await readStepUp(db, held.seq, LATER);
    expect(read.known && read.stepUp?.answer?.outcome).toBe("approved");
    expect(read.known && read.stepUp?.answer?.channel).toBe("cli");
  });

  it("works out expired from the injected time, never stored", async () => {
    const held = await stepUp();
    const atExpiry = new Date(NOW.getTime() + APPROVAL_WINDOW_MS);
    expect(seqs((await listAt(atExpiry)).open)).toEqual([held.seq]);

    const expired = await listAt(PAST_EXPIRY);
    expect(expired.open).toEqual([]);
    expect(seqs(expired.recent)).toEqual([held.seq]);
    expect(expired.recent[0]).toMatchObject({ state: "expired", answer: null });
    // The same log still reads as open at an earlier time.
    expect(seqs((await listAt(LATER)).open)).toEqual([held.seq]);
  });

  it("leaves a step-up open after a rejected answer", async () => {
    const held = await stepUp();
    await append([
      answer(held, {
        answer: "approve",
        outcome: "rejected",
        code: "HASH_MISMATCH",
        intentHash: "b".repeat(64),
      }),
    ]);
    const read = await listAt(LATER);
    expect(seqs(read.open)).toEqual([held.seq]);
    expect(read.recent).toEqual([]);
  });

  it("lists one card per intent, its newest open step-up, newest first", async () => {
    const first = await stepUp();
    const again = await stepUp();
    expect(again.intentId).toBe(first.intentId);
    const other = await proposeBeat5(beat5("TKT-1037", "200.00"));
    expect(other.record.decision).toBe("step_up");

    const read = await listAt(LATER);
    expect(seqs(read.open)).toEqual([other.seqs.decision, again.seq]);
    // The older step-up is still open, just not carded.
    const older = await readStepUp(db, first.seq, LATER);
    expect(older.known && older.stepUp?.state).toBe("open");
  });

  it("answers every earlier step-up of the intent with one deny, and keeps a later one open", async () => {
    const first = await stepUp();
    const second = await stepUp();
    const [denied] = await append([answer(second)]);
    const third = await stepUp();

    const read = await listAt(LATER);
    expect(seqs(read.open)).toEqual([third.seq]);
    expect(seqs(read.recent)).toEqual([second.seq, first.seq]);
    for (const answered of read.recent) {
      expect(answered).toMatchObject({ state: "answered", answer: { seq: denied?.seq } });
    }
  });

  it(`lists the last ${RECENT_STEP_UPS} answered or expired step-ups, newest first`, async () => {
    const held: number[] = [];
    for (let n = 0; n <= RECENT_STEP_UPS; n++) held.push((await stepUp()).seq);
    const read = await listAt(PAST_EXPIRY);
    expect(read.open).toEqual([]);
    expect(seqs(read.recent)).toEqual(held.reverse().slice(0, RECENT_STEP_UPS));
  });

  it("says not found for any seq that isn't a step-up", async () => {
    const held = await stepUp();
    await storeTicket(db, "TKT-9001", "someone.else@example.com");
    const denied = await proposeBeat5(beat5("TKT-9001"));
    expect(denied.record.decision).toBe("deny");
    const [approval] = await append([answer(held)]);

    for (const seq of [held.seq - 1, denied.seqs.decision, approval?.seq ?? 0, 9_999]) {
      expect(await readStepUp(db, seq, LATER)).toEqual({ known: true, stepUp: null });
    }
  });

  describe("the approval writer", () => {
    const held = { seq: 2, intentId: `int_${"c".repeat(24)}`, intentHash: "c".repeat(64) };
    const refused: [string, Record<string, unknown>][] = [
      ["an extra key", { extra: true }],
      ["an approver other than the merchant", { approver: "agent" }],
      ["an unknown channel", { channel: "sms" }],
      ["an unknown answer", { answer: "maybe", outcome: "rejected", code: "EXPIRED" }],
      ["an approve recorded as denied", { answer: "approve", outcome: "denied" }],
      ["a rejection without a code", { answer: "approve", outcome: "rejected" }],
      ["an approval with a code", { answer: "approve", outcome: "approved", code: "EXPIRED" }],
      ["an unknown code", { outcome: "rejected", code: "NOPE" }],
      [
        "a deny rejected with an approve-only code",
        { outcome: "rejected", code: "ALREADY_REQUESTED" },
      ],
      ["a hash that isn't a SHA-256", { intentHash: "not-a-hash" }],
      ["a step-up seq of zero", { stepUpSeq: 0 }],
      ["a ref that isn't an intent ID", { intentId: "TKT-1037" }],
      ["a bad time", { at: "yesterday" }],
    ];

    it.each(refused)("refuses %s, so nothing is appended", async (_, change) => {
      expect(() => answer(held, change as Partial<ApprovalInput>)).toThrow();
    });

    it("builds an approval entry with the intent as its ref", () => {
      expect(answer(held, { answer: "approve", outcome: "rejected", code: "EXPIRED" })).toEqual({
        entryType: "approval",
        refId: held.intentId,
        at: LATER.toISOString(),
        payload: {
          stepUpSeq: 2,
          intentHash: held.intentHash,
          answer: "approve",
          outcome: "rejected",
          code: "EXPIRED",
          approver: "merchant",
          channel: "approvals_page",
        },
      });
    });
  });

  describe("an entry it can't read", () => {
    const unreadable = async (entries: (held: { seq: number; intentId: string }) => EntryInput) => {
      const held = await stepUp();
      const [bad] = await append([entries(held)]);
      const list = await readStepUps(db, LATER);
      expect(list).toMatchObject({ known: false, seq: bad?.seq });
      expect(await readStepUp(db, held.seq, LATER)).toMatchObject({ known: false, seq: bad?.seq });
    };

    it("makes the read unknown for a decision entry with no record", async () => {
      await unreadable((held) => ({
        entryType: "decision",
        refId: held.intentId,
        at: NOW.toISOString(),
        payload: { note: "illustrative" },
      }));
    });

    it("makes the read unknown for a step-up whose intent can't be read", async () => {
      await unreadable((held) => ({
        entryType: "decision",
        refId: held.intentId,
        at: NOW.toISOString(),
        payload: {
          principal: PRINCIPAL,
          record: { decision: "step_up", intentId: held.intentId, intent: { action: "refund" } },
          response: { decision: "pending_approval" },
        },
      }));
    });

    it("makes the read unknown for an approval entry of another shape", async () => {
      await unreadable((held) => ({
        entryType: "approval",
        refId: held.intentId,
        at: LATER.toISOString(),
        payload: { stepUpSeq: held.seq, outcome: "approved" },
      }));
    });

    it("makes the read unknown for an approval that answers no step-up of its intent", async () => {
      await unreadable((held) => ({
        entryType: "approval",
        refId: held.intentId,
        at: LATER.toISOString(),
        payload: {
          stepUpSeq: held.seq + 50,
          intentHash: "a".repeat(64),
          answer: "deny",
          outcome: "denied",
          approver: "merchant",
          channel: "cli",
        },
      }));
    });
  });
});
