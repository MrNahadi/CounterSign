import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createMemoryShipmentStore, createMockCarrier } from "@countersign/carrier-mock";
import {
  asc,
  auditLog,
  createTestDatabase,
  type Database,
  type DatabaseHandle,
  seedOrders,
  type Ticket,
  writeTicket,
} from "@countersign/db";
import { appendEntry, verifyLog } from "@countersign/ledger";
import { parseMandate } from "@countersign/mandate";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { answerStepUp } from "../src/answer-step-up";
import {
  type DecisionRow,
  type ReadableDecisionRow,
  readDecisionDetail,
  readDecisionRows,
  readDecisionSeqByIntent,
  readEntries,
} from "../src/audit-reader";
import { loadCase } from "../src/case-file";
import { decide } from "../src/decide";
import { executionRequestedEntry } from "../src/execution-log";
import { propose } from "../src/propose";
import { recordDecision } from "../src/record";
import { handlePayPalWebhook } from "../src/webhook";
import { createFakeSandbox, httpError } from "./fake-sandbox";

// The audit reader (ADR 0034) over a log built from real decisions: beats 3 to 5 through
// propose(), step-ups answered with answerStepUp(), beat 5's refund reconciled through the
// webhook handler, and two hand-written unreadable entries. PGlite and an injected time.
// Illustrative people and orders.

const SLOW = 120_000;
const NOW = new Date("2026-10-17T09:00:00+03:00");
const EARLY = new Date(NOW.getTime() - 20 * 60 * 1000);
const LATER = new Date(NOW.getTime() + 5 * 60 * 1000);
const READ_AT = new Date(NOW.getTime() + 10 * 60 * 1000);
const PRINCIPAL = "support-agent";
const WEBHOOK_ID = "WH-FAKE-0123456789";

const mandateFile = fileURLToPath(
  new URL("../../../packages/mandate/fixtures/kikapu-studio-v3.json", import.meta.url),
);
const parsedMandate = parseMandate(JSON.parse(readFileSync(mandateFile, "utf8")));
if (!parsedMandate.ok) throw new Error(parsedMandate.error);
const mandate = parsedMandate.mandate;
const mandates = [mandate];

const usd = (minor: number) => ({ minor, currency: "USD" as const });

const BUYER_A = "grace.w@example.com";
const BUYER_B = "sb-1039@personal.example.com";
const BEAT4_PAYER = "amina.k@example.com";
const BEAT5_PAYER = "wanjiru.m@example.com";
const OTHER_PAYER = "otieno.b@example.com";

type Seeded = { n: number; minor: number; payerEmail: string; shipment: string };

const ORDERS: Seeded[] = [
  { n: 1039, minor: 6200, payerEmail: BUYER_B, shipment: "stalled_10d" },
  { n: 1042, minor: 9600, payerEmail: BUYER_A, shipment: "delivered" },
  { n: 1040, minor: 4500, payerEmail: BEAT4_PAYER, shipment: "stalled_10d" },
  { n: 1037, minor: 24000, payerEmail: BEAT5_PAYER, shipment: "delivered" },
  { n: 1050, minor: 3000, payerEmail: OTHER_PAYER, shipment: "delivered" },
  { n: 1051, minor: 3100, payerEmail: OTHER_PAYER, shipment: "delivered" },
  { n: 1060, minor: 1000, payerEmail: OTHER_PAYER, shipment: "lost" },
  { n: 1061, minor: 1100, payerEmail: OTHER_PAYER, shipment: "lost" },
];

function world() {
  const rail = createFakeSandbox();
  const shipments = new Map<string, unknown>();
  for (const { n, minor, payerEmail, shipment } of ORDERS) {
    const captureId = `CAP-${n}`;
    const orderId = `ORD-${n}`;
    const trackingNumber = `TRK${n}`;
    const capture = { id: captureId, status: "COMPLETED", amount: usd(minor), orderId };
    rail.captures.set(captureId, capture);
    rail.orders.set(orderId, {
      id: orderId,
      status: "COMPLETED",
      payerEmail,
      payerId: `PAYER${n}`,
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
    shipments.set(trackingNumber, {
      trackingNumber,
      carrierName: "Illustrative Post",
      status: shipment,
      scanEvents: [{ at: "2026-10-02T08:00:00Z", description: "Accepted", place: "Nairobi" }],
      updatedAt: "2026-10-05T08:00:00Z",
    });
  }
  return { rail, carrier: createMockCarrier(createMemoryShipmentStore(shipments)) };
}

const ticketOf = (id: string, senderEmail: string, images: number): Ticket => ({
  id,
  channel: "email",
  senderEmail,
  senderPhone: null,
  subject: `About my order (${id})`,
  body: "Simulated ticket. My order needs sorting out.",
  attachments: Array.from({ length: images }, (_, index) => ({
    id: `ATT-${id}-${index}`,
    contentType: "image/jpeg",
  })),
  receivedAt: "2026-10-17T08:00:00+03:00",
  simulated: true,
  threadId: `THR-${id}`,
});

const refund = (n: number, value: string | null, ticketId: string, claim: string) => ({
  tool: "create_refund",
  args: {
    capture_id: `CAP-${n}`,
    ...(value === null ? {} : { amount: { value, currency_code: "USD" } }),
  },
  justification: { ticket_id: ticketId, claim },
});

const TRANSMISSION = {
  "paypal-transmission-id": "b2c3d4e5-transmission-id-header",
  "paypal-transmission-time": "2026-10-17T09:29:58Z",
  "paypal-cert-url": "https://api.sandbox.paypal.com/v1/notifications/certs/CERT-fake-cert-header",
  "paypal-auth-algo": "SHA256withRSA",
  "paypal-transmission-sig": "c2lnbmF0dXJlLXRyYW5zbWlzc2lvbi1zaWctaGVhZGVy",
};

type Log = {
  expiredSeq: number;
  kik1039Seq: number;
  kik1042Seq: number;
  kik1042Intent: string;
  beat4Seq: number;
  beat4Refund: string;
  deniedSeq: number;
  failedSeq: number;
  unknownSeq: number;
  notExecutableSeq: number;
  pendingSeq: number;
  beat5Seq: number;
  beat5Intent: string;
  beat5Refund: string;
  unreadableSeq: number;
  junkResultSeq: number;
  total: number;
};

describe("the audit reader", { timeout: SLOW }, () => {
  let handle: DatabaseHandle;
  let db: Database;
  let log: Log;

  const proposeAt = async (w: ReturnType<typeof world>, proposal: unknown, now = NOW) => {
    const result = await propose({
      mandate,
      principal: PRINCIPAL,
      proposal,
      now,
      ...w,
      db,
      clock: () => now,
    });
    if (!result.ok || result.replay) throw new Error("not decided");
    return result;
  };

  const answer = async (
    w: ReturnType<typeof world>,
    stepUpSeq: number,
    intentHash: string | null,
    reply: "approve" | "deny",
  ) => {
    const result = await answerStepUp({
      db,
      rail: w.rail,
      stepUpSeq,
      answer: reply,
      intentHash,
      channel: "approvals_page",
      now: LATER,
      clock: () => LATER,
    });
    if (result.kind !== "answered") throw new Error(`not answered: ${result.kind}`);
    return result;
  };

  beforeAll(async () => {
    handle = await createTestDatabase();
    db = handle.db;
    const w = world();
    for (const [id, sender, images] of [
      ["TKT-3001", BUYER_A, 0],
      ["TKT-1040", BEAT4_PAYER, 0],
      ["TKT-1037", BEAT5_PAYER, 1],
      ["TKT-1050", OTHER_PAYER, 0],
      ["TKT-1051", OTHER_PAYER, 0],
      ["TKT-1060", OTHER_PAYER, 0],
      ["TKT-1061", OTHER_PAYER, 0],
    ] as const) {
      await writeTicket(db, ticketOf(id, sender, images));
    }
    await db.insert(seedOrders).values(
      [1039, 1042, 1040, 1037].map((n) => ({
        orderNumber: `KIK-${n}`,
        runId: "run-illustrative",
        paypalOrderId: `ORD-${n}`,
        paypalCaptureId: `CAP-${n}`,
        amountMinor: ORDERS.find((order) => order.n === n)?.minor ?? 0,
        currency: "USD",
        payerEmail: ORDERS.find((order) => order.n === n)?.payerEmail ?? "",
        buyer: "A",
        trackingNumber: `TRK${n}`,
        role: "illustrative",
        seededAt: "2026-10-01T08:00:00Z",
      })),
    );

    // A wrong-item step-up from 20 minutes earlier, left to expire.
    const expired = await proposeAt(w, refund(1050, null, "TKT-1050", "wrong_item"), EARLY);
    // Beat 3: the attack email from buyer A names buyer B's order, then their own delivered one.
    const kik1039 = await proposeAt(w, refund(1039, null, "TKT-3001", "not_received"));
    const kik1042 = await proposeAt(w, refund(1042, "96.00", "TKT-3001", "not_received"));
    // Beat 4: a stalled parcel under the cap, refunded.
    const beat4 = await proposeAt(w, refund(1040, null, "TKT-1040", "not_received"));
    const beat4Refund = beat4.execution?.refund?.id;
    // A wrong-item step-up the merchant denies.
    const denied = await proposeAt(w, refund(1051, null, "TKT-1051", "wrong_item"));
    await answer(w, denied.seqs.decision, denied.record.intentHash, "deny");
    // PayPal refuses one allowed refund and never answers another.
    w.rail.failures.refundCapture = httpError("refund-capture", 422, "UNPROCESSABLE_ENTITY");
    const failed = await proposeAt(w, refund(1060, null, "TKT-1060", "not_received"));
    w.rail.failures.refundCapture = new Error("socket hang up");
    const unknown = await proposeAt(w, refund(1061, null, "TKT-1061", "not_received"));
    w.rail.failures = {};
    // Two allows recorded the way the decide CLI records them: one never requested, and one
    // requested whose result isn't logged yet.
    const loaded = loadCase(
      fileURLToPath(new URL("../fixtures/cases/lost-parcel-under-cap.json", import.meta.url)),
    );
    if (!loaded.ok) throw new Error(loaded.error);
    const { decisionCase } = loaded;
    const [first] = decisionCase.proposals;
    if (!first) throw new Error("no proposal in the case");
    const record = async (proposal: unknown) => {
      const decided = decide({
        mandate: decisionCase.mandate,
        principal: decisionCase.principal,
        proposal,
        records: decisionCase.records,
        now: NOW,
      });
      const recorded = await recordDecision(db, {
        proposal,
        principal: decisionCase.principal,
        mandate: decisionCase.mandate,
        decided,
      });
      if (!recorded.ok) throw new Error(recorded.detail);
      return { decided, seq: recorded.decision.seq };
    };
    const notExecutable = await record(first.proposal);
    const partial = {
      ...(first.proposal as { args: object }),
      args: { capture_id: "CAP-2060", amount: { value: "30.00", currency_code: "USD" } },
    };
    const pending = await record(partial);
    const { intent, intentId, intentHash } = pending.decided.record;
    if (!intent || !intentId || !intentHash) throw new Error("no intent");
    const requested = await appendEntry(
      db,
      executionRequestedEntry({
        at: NOW.toISOString(),
        intentId,
        intentHash,
        principal: PRINCIPAL,
        rail: "paypal",
        action: "paypal.refund",
        target: { captureId: "CAP-2060" },
        amount: intent.amount,
        decisionSeq: pending.seq,
      }),
    );
    if (!requested.ok) throw new Error("request not written");
    // Beat 5: $240.00 for a damaged basket, held, approved, refunded and reconciled.
    const beat5 = await proposeAt(w, refund(1037, "240.00", "TKT-1037", "damaged"));
    const approved = await answer(w, beat5.seqs.decision, beat5.record.intentHash, "approve");
    const beat5Refund = approved.execution?.refund?.id;
    if (!beat4Refund || !beat5Refund) throw new Error("no refund");
    const reconciled = await handlePayPalWebhook(
      {
        headers: TRANSMISSION,
        body: Buffer.from(
          JSON.stringify({
            id: "WH-EVT-0001",
            event_type: "PAYMENT.CAPTURE.REFUNDED",
            resource: { id: beat5Refund },
          }),
        ),
      },
      { db, rail: () => w.rail, env: { PAYPAL_WEBHOOK_ID: WEBHOOK_ID }, clock: () => LATER },
    );
    expect(reconciled.status).toBe(200);
    // Two hand-written entries that can't be read: a decision, and a result in KIK-1042's trail.
    const junkDecision = await appendEntry(db, {
      entryType: "decision",
      refId: null,
      at: LATER.toISOString(),
      payload: { junk: true },
    });
    const kik1042Intent = kik1042.record.intentId;
    if (!kik1042Intent || !beat5.record.intentId) throw new Error("no intent");
    const junkResult = await appendEntry(db, {
      entryType: "execution.result",
      refId: kik1042Intent,
      at: LATER.toISOString(),
      payload: { requestSeq: 1, outcome: "maybe" },
    });
    if (!junkDecision.ok || !junkResult.ok) throw new Error("junk not written");
    const rows = await db.select().from(auditLog).orderBy(asc(auditLog.seq));

    log = {
      expiredSeq: expired.seqs.decision,
      kik1039Seq: kik1039.seqs.decision,
      kik1042Seq: kik1042.seqs.decision,
      kik1042Intent,
      beat4Seq: beat4.seqs.decision,
      beat4Refund,
      deniedSeq: denied.seqs.decision,
      failedSeq: failed.seqs.decision,
      unknownSeq: unknown.seqs.decision,
      notExecutableSeq: notExecutable.seq,
      pendingSeq: pending.seq,
      beat5Seq: beat5.seqs.decision,
      beat5Intent: beat5.record.intentId,
      beat5Refund,
      unreadableSeq: junkDecision.entry.seq,
      junkResultSeq: junkResult.entry.seq,
      total: rows.length,
    };
  }, SLOW);

  afterAll(async () => {
    await handle.close();
  });

  const readable = (row: DecisionRow | undefined): ReadableDecisionRow => {
    if (!row?.readable) throw new Error("not a readable row");
    return row;
  };
  const rowAt = (rows: DecisionRow[], seq: number) => readable(rows.find((row) => row.seq === seq));

  describe("decision rows", () => {
    it("come newest first, with every field and each status", async () => {
      const page = await readDecisionRows(db, {}, READ_AT);
      const seqs = page.rows.map((row) => row.seq);
      expect(seqs).toEqual([...seqs].sort((a, b) => b - a));
      expect(page.rows).toHaveLength(11);

      expect(rowAt(page.rows, log.kik1039Seq)).toMatchObject({
        readable: true,
        principal: PRINCIPAL,
        action: "paypal.refund",
        action_words: "Refund",
        amount: { minor: 6200, currency: "USD", display: "$62.00" },
        target: { kind: "capture", id: "CAP-1039", order_id: "ORD-1039" },
        order_number: "KIK-1039",
        sender: BUYER_A,
        claim: "not_received",
        claim_words: "Says the parcel never arrived",
        decision: "deny",
        matched_rules: ["refund-lost-parcel"],
        status: null,
      });
      const kik1039 = rowAt(page.rows, log.kik1039Seq);
      expect(kik1039.reasons[0]).toEqual({
        code: "TICKET_NOT_FROM_PAYER",
        words: "The ticket didn't come from the person who paid.",
        detail: expect.any(String),
      });
      expect(kik1039.at).toBe(NOW.toISOString());
      expect(kik1039.intent_id).toMatch(/^int_/);

      const status = (seq: number) => rowAt(page.rows, seq).status;
      expect(status(log.beat4Seq)).toEqual({
        kind: "executed",
        execution: {
          outcome: "executed",
          refund: { id: log.beat4Refund, status: "COMPLETED" },
          invoice: null,
          dispute: null,
          payout: null,
        },
      });
      expect(status(log.failedSeq)).toMatchObject({
        kind: "failed",
        execution: { outcome: "failed" },
      });
      expect(status(log.unknownSeq)).toMatchObject({
        kind: "unknown",
        execution: { outcome: "unknown" },
      });
      expect(status(log.pendingSeq)).toMatchObject({
        kind: "pending",
        execution: { outcome: "pending" },
      });
      expect(status(log.notExecutableSeq)).toEqual({ kind: "not_executable", execution: null });
      expect(status(log.kik1042Seq)).toEqual({ kind: "open", execution: null });
      expect(status(log.beat5Seq)).toEqual({
        kind: "approved",
        execution: {
          outcome: "executed",
          refund: { id: log.beat5Refund, status: "COMPLETED" },
          invoice: null,
          dispute: null,
          payout: null,
        },
      });
      expect(status(log.deniedSeq)).toEqual({ kind: "denied", execution: null });
      expect(status(log.expiredSeq)).toEqual({ kind: "expired", execution: null });
      expect(rowAt(page.rows, log.beat4Seq).matched_rules).toEqual(["refund-lost-parcel"]);
      expect(rowAt(page.rows, log.notExecutableSeq).sender).toBeNull();
    });

    it("work a step-up's state out at the time asked", async () => {
      const early = await readDecisionRows(db, {}, NOW);
      expect(rowAt(early.rows, log.expiredSeq).status).toEqual({
        kind: "expired",
        execution: null,
      });
      const late = await readDecisionRows(db, {}, new Date(NOW.getTime() + 16 * 60 * 1000));
      expect(rowAt(late.rows, log.kik1042Seq).status).toEqual({ kind: "expired", execution: null });
    });

    it("filter by decision and q, with counts for the current q", async () => {
      const all = await readDecisionRows(db, {}, READ_AT);
      expect(all.counts).toEqual({ all: 11, allowed: 5, stepped_up: 4, denied: 1 });

      const denied = await readDecisionRows(db, { decision: "deny" }, READ_AT);
      expect(denied.rows.map((row) => row.seq)).toEqual(
        all.rows.filter((row) => row.readable && row.decision === "deny").map((row) => row.seq),
      );
      expect(denied.counts).toEqual(all.counts);

      const byOrder = await readDecisionRows(db, { q: "kik-1039" }, READ_AT);
      expect(byOrder.rows.map((row) => row.seq)).toEqual([log.kik1039Seq]);
      expect(byOrder.counts).toEqual({ all: 1, allowed: 0, stepped_up: 0, denied: 1 });

      const bySender = await readDecisionRows(db, { q: "GRACE.W@" }, READ_AT);
      expect(bySender.rows.map((row) => row.seq)).toEqual([log.kik1042Seq, log.kik1039Seq]);

      const byRefund = await readDecisionRows(db, { q: log.beat5Refund }, READ_AT);
      expect(byRefund.rows.map((row) => row.seq)).toEqual([log.beat5Seq]);
      const byIntent = await readDecisionRows(db, { q: log.beat5Intent }, READ_AT);
      expect(byIntent.rows.map((row) => row.seq)).toEqual([log.beat5Seq]);
      const byTarget = await readDecisionRows(db, { q: "cap-2060" }, READ_AT);
      expect(byTarget.rows.map((row) => row.seq)).toEqual([log.pendingSeq, log.notExecutableSeq]);

      const steppedUp = await readDecisionRows(db, { q: "kik", decision: "step_up" }, READ_AT);
      expect(steppedUp.rows.map((row) => row.seq)).toEqual([log.beat5Seq, log.kik1042Seq]);
      expect(steppedUp.counts).toEqual({ all: 4, allowed: 1, stepped_up: 2, denied: 1 });
    });

    it("page with before and limit, and give the next cursor", async () => {
      const all = await readDecisionRows(db, {}, READ_AT);
      const seqs = all.rows.map((row) => row.seq);
      const first = await readDecisionRows(db, { limit: 5 }, READ_AT);
      expect(first.rows.map((row) => row.seq)).toEqual(seqs.slice(0, 5));
      expect(first.next_before).toBe(seqs[4]);
      const second = await readDecisionRows(
        db,
        { limit: 5, before: first.next_before ?? 0 },
        READ_AT,
      );
      expect(second.rows.map((row) => row.seq)).toEqual(seqs.slice(5, 10));
      const third = await readDecisionRows(
        db,
        { limit: 5, before: second.next_before ?? 0 },
        READ_AT,
      );
      expect(third.rows.map((row) => row.seq)).toEqual(seqs.slice(10));
      expect(third.next_before).toBeNull();
      expect(all.next_before).toBeNull();
      expect(third.counts).toEqual(all.counts);
    });

    it("refuse filters out of range", async () => {
      await expect(readDecisionRows(db, { limit: 0 }, READ_AT)).rejects.toThrow();
      await expect(readDecisionRows(db, { limit: 201 }, READ_AT)).rejects.toThrow();
      await expect(readDecisionRows(db, { before: -1 }, READ_AT)).rejects.toThrow();
    });

    it("list an unreadable decision entry as unreadable, counted under all only", async () => {
      const page = await readDecisionRows(db, {}, READ_AT);
      const [newest] = page.rows;
      expect(newest).toEqual({
        readable: false,
        seq: log.unreadableSeq,
        at: LATER.toISOString(),
        problem: expect.stringMatching(/^decision #\d+ can't be read/),
      });
      expect(page.rows.filter((row) => row.readable)).toHaveLength(10);
      const searched = await readDecisionRows(db, { q: "kik" }, READ_AT);
      expect(searched.rows.every((row) => row.readable)).toBe(true);
    });
  });

  describe("decision detail", () => {
    it("holds beat 5 in full, with its trail of approval, request, result and reconciliation", async () => {
      const detail = await readDecisionDetail(db, log.beat5Seq, READ_AT, mandates);
      if (detail === null || !detail.readable) throw new Error("no readable detail");
      const [entry] = await db
        .select()
        .from(auditLog)
        .orderBy(asc(auditLog.seq))
        .then((rows) => rows.filter((row) => row.seq === log.beat5Seq));
      if (!entry) throw new Error("no entry");
      const stored = JSON.parse(entry.payload);

      expect(detail).toMatchObject({
        seq: log.beat5Seq,
        decision: "step_up",
        order_number: "KIK-1037",
        sender: BEAT5_PAYER,
        intent_hash: stored.record.intentHash,
        intent_canonical: stored.record.intentCanonical,
        mandate: {
          id: "kikapu-studio",
          version: 3,
          hash: stored.record.mandate.hash,
          seq: stored.mandateSeq,
        },
        safe_reply_hint: null,
        expires_at: stored.response.expires_at,
        proposal: stored.proposal,
        proposal_truncated: false,
        entry: { seq: entry.seq, at: entry.at, hash: entry.hash, prev_hash: entry.prevHash },
        ticket: {
          id: "TKT-1037",
          channel: "email",
          sender: BEAT5_PAYER,
          subject: "About my order (TKT-1037)",
          excerpt: "Simulated ticket. My order needs sorting out.",
          received_at: "2026-10-17T08:00:00+03:00",
          attachment_ids: ["ATT-TKT-1037-0"],
          thread_id: "THR-TKT-1037",
          simulated: true,
        },
      });
      expect(detail.usage).toMatchObject({ known: true });
      expect(detail.reasons.map((reason) => reason.code)).toEqual(
        stored.record.reasons.map((reason: { code: string }) => reason.code),
      );
      expect(detail.reasons[0]?.words).toEqual(expect.any(String));
      expect(detail.trace).toHaveLength(stored.record.trace.length);
      const photo = detail.trace.find((each) => each.verifier === "evidence.photo_present");
      expect(photo).toMatchObject({ words: "Photo of the damage", result: "pass" });
      expect(photo?.records[0]).toMatchObject({ words: "Ticket store" });
      expect(detail.claims.map((pair) => [pair.check, pair.verdict])).toEqual([
        ["capture.refundable", "matches"],
        ["ticket.from_payer", "matches"],
        ["evidence.photo_present", "matches"],
        ["ledger.not_duplicate", "passes"],
        ["message", "not_used"],
      ]);

      expect(detail.trail.map((each) => each.type)).toEqual([
        "decision",
        "approval",
        "execution.requested",
        "execution.result",
        "reconciliation",
      ]);
      const seqs = detail.trail.map((each) => each.seq);
      expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
      const [, approval, request, result, reconciliation] = detail.trail;
      expect(approval).toMatchObject({
        readable: true,
        at: LATER.toISOString(),
        hash: expect.stringMatching(/^[0-9a-f]{64}$/),
        parts: {
          kind: "approval",
          answer: "approve",
          outcome: "approved",
          code: null,
          channel: "approvals_page",
          step_up_seq: log.beat5Seq,
        },
      });
      expect(request).toMatchObject({
        parts: {
          kind: "execution.requested",
          request_id: stored.record.intentHash,
          replay: false,
          approval_seq: approval?.seq,
          decision_seq: null,
        },
      });
      expect(result).toMatchObject({
        parts: {
          kind: "execution.result",
          outcome: "executed",
          refund: { id: log.beat5Refund, status: "COMPLETED" },
          invoice: null,
          error: null,
        },
      });
      expect(reconciliation).toMatchObject({
        parts: {
          kind: "reconciliation",
          source: "webhook",
          event: { id: "WH-EVT-0001", type: "PAYMENT.CAPTURE.REFUNDED" },
          refund: {
            id: log.beat5Refund,
            status: "COMPLETED",
            amount: { minor: 24000, currency: "USD", display: "$240.00" },
          },
        },
      });
    });

    it("gives a denial its safe reply hint, and PayPal's refusal in the trail", async () => {
      const denial = await readDecisionDetail(db, log.kik1039Seq, READ_AT, mandates);
      if (denial === null || !denial.readable) throw new Error("no readable detail");
      expect(denial.safe_reply_hint).toEqual(expect.any(String));
      expect(denial.expires_at).toBeNull();

      const failed = await readDecisionDetail(db, log.failedSeq, READ_AT, mandates);
      if (failed === null || !failed.readable) throw new Error("no readable detail");
      const result = failed.trail.find((each) => each.type === "execution.result");
      expect(result).toMatchObject({
        readable: true,
        parts: {
          outcome: "failed",
          error: { name: "UNPROCESSABLE_ENTITY", issues: [], debug_id: "fake-debug" },
        },
      });
    });

    it("shows an unreadable trail entry with its problem", async () => {
      const detail = await readDecisionDetail(db, log.kik1042Seq, READ_AT, mandates);
      if (detail === null || !detail.readable) throw new Error("no readable detail");
      expect(detail.trail.map((each) => each.seq)).toEqual([log.kik1042Seq, log.junkResultSeq]);
      expect(detail.trail[1]).toEqual({
        seq: log.junkResultSeq,
        type: "execution.result",
        at: LATER.toISOString(),
        hash: expect.stringMatching(/^[0-9a-f]{64}$/),
        readable: false,
        problem: expect.stringMatching(/^execution\.result #\d+ can't be read/),
      });
    });

    it("finds nothing at a seq that isn't a decision", async () => {
      expect(await readDecisionDetail(db, 1, READ_AT, mandates)).toBeNull();
      expect(await readDecisionDetail(db, log.junkResultSeq, READ_AT, mandates)).toBeNull();
      expect(await readDecisionDetail(db, log.total + 100, READ_AT, mandates)).toBeNull();
    });

    it("answers an unreadable decision with its problem and raw payload text", async () => {
      const detail = await readDecisionDetail(db, log.unreadableSeq, READ_AT, mandates);
      expect(detail).toMatchObject({
        readable: false,
        seq: log.unreadableSeq,
        at: LATER.toISOString(),
        problem: expect.stringMatching(/^decision #\d+ can't be read/),
        payload: '{"junk":true}',
      });
    });
  });

  describe("by intent", () => {
    it("gives the newest decision's seq, or null", async () => {
      expect(await readDecisionSeqByIntent(db, log.beat5Intent)).toBe(log.beat5Seq);
      expect(await readDecisionSeqByIntent(db, `int_${"0".repeat(24)}`)).toBeNull();
      expect(await readDecisionSeqByIntent(db, "not an intent")).toBeNull();
    });
  });

  describe("entries", () => {
    it("page newest first with one summary per type and the total", async () => {
      const page = await readEntries(db, { limit: 200 });
      expect(page.total).toBe(log.total);
      expect(page.next_before).toBeNull();
      const seqs = page.entries.map((entry) => entry.seq);
      expect(seqs).toEqual([...seqs].sort((a, b) => b - a));
      const summary = (seq: number) => page.entries.find((entry) => entry.seq === seq)?.summary;
      expect(summary(log.kik1039Seq)).toBe("Denied refund $62.00 on KIK-1039.");
      expect(summary(log.beat5Seq)).toBe("Held refund $240.00 on KIK-1037 for approval.");
      expect(summary(log.beat4Seq)).toBe("Allowed refund $45.00 on KIK-1040.");
      const of = (type: string) =>
        page.entries.filter((entry) => entry.type === type).map((entry) => entry.summary);
      expect(of("mandate.version")).toEqual(["Mandate kikapu-studio version 3."]);
      expect(of("approval")).toEqual([
        expect.stringMatching(/^Approved step-up \d+\.$/),
        expect.stringMatching(/^Denied step-up \d+\.$/),
      ]);
      expect(of("execution.requested")).toContain("Asked PayPal to refund $240.00.");
      expect(of("execution.result")).toContain(`PayPal refunded it: ${log.beat5Refund} completed.`);
      expect(of("execution.result")).toContain("PayPal refused it: UNPROCESSABLE_ENTITY.");
      expect(of("reconciliation")).toEqual([
        `Matched webhook WH-EVT-0001 to refund ${log.beat5Refund}.`,
      ]);
      const junk = page.entries.find((entry) => entry.seq === log.unreadableSeq);
      expect(junk).toMatchObject({
        readable: false,
        summary: "This entry can't be read.",
        problem: expect.any(String),
        ref: null,
      });
      const rows = await db.select().from(auditLog).orderBy(asc(auditLog.seq));
      const last = rows.at(-1);
      expect(page.entries[0]).toMatchObject({
        seq: last?.seq,
        type: last?.entryType,
        ref: last?.refId,
        at: last?.at,
        hash: last?.hash,
        prev_hash: last?.prevHash,
      });
    });

    it("page back with before and limit", async () => {
      const first = await readEntries(db, { limit: 4 });
      expect(first.entries).toHaveLength(4);
      expect(first.next_before).toBe(first.entries[3]?.seq);
      const second = await readEntries(db, { limit: 4, before: first.next_before ?? 0 });
      expect(second.entries[0]?.seq).toBe((first.next_before ?? 0) - 1);
      expect(second.total).toBe(log.total);
    });
  });

  it("writes nothing", async () => {
    const before = await verifyLog(db);
    await readDecisionRows(db, {}, READ_AT);
    await readDecisionDetail(db, log.beat5Seq, READ_AT, mandates);
    await readDecisionSeqByIntent(db, log.beat5Intent);
    await readEntries(db, {});
    expect(await verifyLog(db)).toEqual(before);
  });
});
