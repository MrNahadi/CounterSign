import { readFileSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { createMemoryShipmentStore, createMockCarrier } from "@countersign/carrier-mock";
import {
  asc,
  auditLog,
  createTestDatabase,
  type Database,
  type DatabaseHandle,
  seedOrders,
  sql,
  type Ticket,
  writeTicket,
} from "@countersign/db";
import { appendEntry, checkEvidence, EVIDENCE_FORMAT, verifyLog } from "@countersign/ledger";
import { parseMandate } from "@countersign/mandate";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { answerStepUp } from "../src/answer-step-up";
import { type AppDeps, createApp } from "../src/app";
import { APPROVAL_MESSAGES } from "../src/approvals-api";
import { APPROVER_KEY_VAR } from "../src/approver";
import { AUDIT_MESSAGES } from "../src/audit-api";
import { SUPPORT_AGENT_KEY_VAR } from "../src/principals";
import { propose } from "../src/propose";
import { createFakeSandbox } from "./fake-sandbox";

// The gate's read-only audit API (ADR 0034) over HTTP on 127.0.0.1, with PGlite, the fake sandbox
// and an injected clock. The log comes from real decisions: beat 3's two denials and beat 5's
// step-up, approved and refunded, plus one hand-written unreadable decision. Illustrative people,
// orders and keys.

const SLOW = 120_000;
const NOW = new Date("2026-10-17T09:00:00+03:00");
const LATER = new Date(NOW.getTime() + 5 * 60 * 1000);
const READ_AT = new Date(NOW.getTime() + 10 * 60 * 1000);
const AGENT_KEY = "agent-key-illustrative-0123456789abcdef";
const APPROVER_KEY = "approver-key-illustrative-0123456789abcd";
const WRONG_KEY = "wrong-key-illustrative-0123456789abcdefgh";
const ENV = { [SUPPORT_AGENT_KEY_VAR]: AGENT_KEY, [APPROVER_KEY_VAR]: APPROVER_KEY };
const MARKER = "ECHOMARKER7f3a";

const mandateFile = fileURLToPath(
  new URL("../../../packages/mandate/fixtures/kikapu-studio-v3.json", import.meta.url),
);
const parsedMandate = parseMandate(JSON.parse(readFileSync(mandateFile, "utf8")));
if (!parsedMandate.ok) throw new Error(parsedMandate.error);
const mandate = parsedMandate.mandate;

const usd = (minor: number) => ({ minor, currency: "USD" as const });

const BUYER_A = "grace.w@example.com";
const BUYER_B = "sb-1039@personal.example.com";
const BEAT5_PAYER = "wanjiru.m@example.com";

const ORDERS = [
  { n: 1039, minor: 6200, payerEmail: BUYER_B, shipment: "stalled_10d" },
  { n: 1042, minor: 9600, payerEmail: BUYER_A, shipment: "delivered" },
  { n: 1037, minor: 24000, payerEmail: BEAT5_PAYER, shipment: "delivered" },
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

const get = async (url: string, key: string | null = APPROVER_KEY) => {
  const res = await fetch(url, key === null ? {} : { headers: { Authorization: `Bearer ${key}` } });
  const text = await res.text();
  return { status: res.status, headers: res.headers, text, body: JSON.parse(text) };
};

const noKeyIn = (text: string) => {
  expect(text).not.toContain(APPROVER_KEY);
  expect(text).not.toContain(AGENT_KEY);
  expect(text).not.toContain(WRONG_KEY);
};

type Log = {
  kik1039Seq: number;
  kik1042Seq: number;
  beat5Seq: number;
  beat5Intent: string;
  beat5Refund: string;
  approvalSeq: number;
  unreadableSeq: number;
};

describe("the audit API", { timeout: SLOW }, () => {
  let handle: DatabaseHandle;
  let db: Database;
  let log: Log;

  const gate = () => listen({ db, env: ENV, clock: () => READ_AT });

  beforeAll(async () => {
    handle = await createTestDatabase();
    db = handle.db;
    const w = world();
    await writeTicket(db, ticketOf("TKT-3001", BUYER_A, 0));
    await writeTicket(db, ticketOf("TKT-1037", BEAT5_PAYER, 1));
    await db.insert(seedOrders).values(
      ORDERS.map(({ n, minor, payerEmail }) => ({
        orderNumber: `KIK-${n}`,
        runId: "run-illustrative",
        paypalOrderId: `ORD-${n}`,
        paypalCaptureId: `CAP-${n}`,
        amountMinor: minor,
        currency: "USD",
        payerEmail,
        buyer: "A",
        trackingNumber: `TRK${n}`,
        role: "illustrative",
        seededAt: "2026-10-01T08:00:00Z",
      })),
    );
    const proposeNow = async (proposal: unknown) => {
      const result = await propose({
        mandate,
        principal: "support-agent",
        proposal,
        now: NOW,
        ...w,
        db,
        clock: () => NOW,
      });
      if (!result.ok || result.replay) throw new Error("not decided");
      return result;
    };
    // Beat 3: buyer A's email names buyer B's order, then their own delivered one.
    const kik1039 = await proposeNow(refund(1039, null, "TKT-3001", "not_received"));
    const kik1042 = await proposeNow(refund(1042, "96.00", "TKT-3001", "not_received"));
    // Beat 5: $240.00 for a damaged basket, held, then approved and refunded.
    const beat5 = await proposeNow(refund(1037, "240.00", "TKT-1037", "damaged"));
    const approved = await answerStepUp({
      db,
      rail: w.rail,
      stepUpSeq: beat5.seqs.decision,
      answer: "approve",
      intentHash: beat5.record.intentHash,
      channel: "approvals_page",
      now: LATER,
      clock: () => LATER,
    });
    if (approved.kind !== "answered") throw new Error("not answered");
    const beat5Refund = approved.execution?.refund?.id;
    if (!beat5Refund || !beat5.record.intentId) throw new Error("no refund");
    const junk = await appendEntry(db, {
      entryType: "decision",
      refId: null,
      at: LATER.toISOString(),
      payload: { junk: true },
    });
    if (!junk.ok) throw new Error("junk not written");
    log = {
      kik1039Seq: kik1039.seqs.decision,
      kik1042Seq: kik1042.seqs.decision,
      beat5Seq: beat5.seqs.decision,
      beat5Intent: beat5.record.intentId,
      beat5Refund,
      approvalSeq: approved.approvalSeq,
      unreadableSeq: junk.entry.seq,
    };
  }, SLOW);

  afterAll(async () => {
    await handle.close();
  });

  const routes = () => [
    "/audit/decisions",
    `/audit/decisions/${log.beat5Seq}`,
    `/audit/intents/${log.beat5Intent}`,
    "/audit/entries",
    "/audit/verify",
    `/audit/export?intent=${log.beat5Intent}`,
  ];

  it("lists decisions newest first in snake_case, filtered and paged", async () => {
    const url = await gate();
    const all = await get(`${url}/audit/decisions`);
    expect(all.status).toBe(200);
    noKeyIn(all.text);
    expect(all.body.counts).toEqual({ all: 4, allowed: 0, stepped_up: 2, denied: 1 });
    expect(all.body.next_before).toBeNull();
    expect(all.body.rows.map((row: { seq: number }) => row.seq)).toEqual([
      log.unreadableSeq,
      log.beat5Seq,
      log.kik1042Seq,
      log.kik1039Seq,
    ]);
    expect(all.body.rows[0]).toMatchObject({ readable: false, seq: log.unreadableSeq });
    expect(all.body.rows[1]).toMatchObject({
      readable: true,
      action: "paypal.refund",
      amount: { minor: 24000, currency: "USD", display: "$240.00" },
      order_number: "KIK-1037",
      decision: "step_up",
      status: { kind: "approved" },
    });

    const stepUps = await get(`${url}/audit/decisions?decision=step_up`);
    expect(stepUps.status).toBe(200);
    expect(stepUps.body.rows).toHaveLength(2);
    expect(stepUps.body.rows.every((row: { decision: string }) => row.decision === "step_up")).toBe(
      true,
    );

    // Buyer A's two proposals, a page at a time.
    const first = await get(`${url}/audit/decisions?q=GRACE.W&limit=1`);
    expect(first.status).toBe(200);
    expect(first.body.counts.all).toBe(2);
    expect(first.body.rows.map((row: { seq: number }) => row.seq)).toEqual([log.kik1042Seq]);
    expect(first.body.next_before).toBe(log.kik1042Seq);
    const older = await get(`${url}/audit/decisions?q=GRACE.W&limit=1&before=${log.kik1042Seq}`);
    expect(older.body.rows.map((row: { seq: number }) => row.seq)).toEqual([log.kik1039Seq]);
    expect(older.body.next_before).toBeNull();
  });

  it("opens a decision with its claims vs records and trail", async () => {
    const url = await gate();
    const beat5 = await get(`${url}/audit/decisions/${log.beat5Seq}`);
    expect(beat5.status).toBe(200);
    noKeyIn(beat5.text);
    expect(beat5.body).toMatchObject({
      readable: true,
      seq: log.beat5Seq,
      decision: "step_up",
      ticket: { id: "TKT-1037", thread_id: "THR-TKT-1037", simulated: true },
      entry: { seq: log.beat5Seq },
    });
    const claims: { check: string; claim: { text: string } | null; verdict: string }[] =
      beat5.body.claims;
    expect(claims.find((pair) => pair.check === "evidence.photo_present")).toMatchObject({
      claim: { text: "1 photo attached" },
      verdict: "matches",
    });
    expect(claims.find((pair) => pair.check === "capture.refundable")).toMatchObject({
      claim: { text: "Asks for Refund $240.00 on KIK-1037" },
      verdict: "matches",
    });
    expect(claims.at(-1)).toMatchObject({ check: "message", verdict: "not_used" });
    const trailTypes = beat5.body.trail.map((entry: { type: string }) => entry.type);
    expect(trailTypes).toEqual(["decision", "approval", "execution.requested", "execution.result"]);
    expect(beat5.text).toContain(log.beat5Refund);

    const kik1039 = await get(`${url}/audit/decisions/${log.kik1039Seq}`);
    expect(
      kik1039.body.claims.find((pair: { check: string }) => pair.check === "ticket.from_payer"),
    ).toMatchObject({ claim: { text: `Sent from ${BUYER_A}` }, verdict: "contradicts" });
    expect(kik1039.body.safe_reply_hint).toEqual(expect.any(String));

    const unreadable = await get(`${url}/audit/decisions/${log.unreadableSeq}`);
    expect(unreadable.status).toBe(200);
    expect(unreadable.body).toMatchObject({ readable: false, payload: '{"junk":true}' });
  });

  it("finds an intent's newest decision", async () => {
    const url = await gate();
    const found = await get(`${url}/audit/intents/${log.beat5Intent}`);
    expect(found.status).toBe(200);
    expect(found.body).toEqual({ decision_seq: log.beat5Seq });
  });

  it("pages entries newest first with the total", async () => {
    const url = await gate();
    const rows = await db.select().from(auditLog).orderBy(asc(auditLog.seq));
    const first = await get(`${url}/audit/entries?limit=2`);
    expect(first.status).toBe(200);
    expect(first.body.total).toBe(rows.length);
    expect(first.body.entries.map((entry: { seq: number }) => entry.seq)).toEqual([
      rows.length,
      rows.length - 1,
    ]);
    expect(first.body.next_before).toBe(rows.length - 1);
    expect(first.body.entries[0]).toMatchObject({
      type: "decision",
      hash: rows.at(-1)?.hash,
      prev_hash: rows.at(-1)?.prevHash,
    });
    const next = await get(`${url}/audit/entries?before=${first.body.next_before}&limit=200`);
    expect(next.body.entries).toHaveLength(rows.length - 2);
    expect(next.body.next_before).toBeNull();
  });

  it("verifies the chain", async () => {
    const url = await gate();
    const verdict = await verifyLog(db);
    if (!verdict.intact) throw new Error("the log isn't intact");
    const verify = await get(`${url}/audit/verify`);
    expect(verify.status).toBe(200);
    expect(verify.body).toEqual({
      intact: true,
      entry_count: verdict.entries,
      head: verdict.head,
      problems: [],
    });
  });

  it("downloads evidence by intent and by capture, as files named for their scope", async () => {
    const url = await gate();
    for (const [kind, id] of [
      ["intent", log.beat5Intent],
      ["capture", "CAP-1037"],
    ] as const) {
      const res = await get(`${url}/audit/export?${kind}=${id}`);
      expect(res.status).toBe(200);
      noKeyIn(res.text);
      expect(res.headers.get("content-type")).toContain("application/json");
      expect(res.headers.get("content-disposition")).toBe(
        `attachment; filename="countersign-evidence-${kind}-${id}.json"`,
      );
      expect(res.body).toMatchObject({
        format: EVIDENCE_FORMAT,
        exported_at: READ_AT.toISOString(),
        scope: { kind, id },
        chain: { intact: true },
      });
      const seqs = res.body.entries.map((entry: { seq: number }) => entry.seq);
      expect(seqs).toContain(log.beat5Seq);
      expect(seqs).toContain(log.approvalSeq);
      expect(checkEvidence(res.body)).toMatchObject({ ok: true, problems: [] });
    }
  });

  it("refuses no key, a wrong key and a principal key on every route before reading anything", async () => {
    const touched: string[] = [];
    const watched = new Proxy({} as Database, {
      get(_target, property) {
        touched.push(String(property));
        throw new Error("the database was read");
      },
    });
    const url = await listen({ db: watched, env: ENV, clock: () => READ_AT });
    for (const route of [...routes(), `/audit/decisions?${MARKER}=1`]) {
      for (const key of [null, WRONG_KEY, AGENT_KEY]) {
        const res = await get(`${url}${route}`, key);
        expect(res.status).toBe(401);
        expect(res.headers.get("www-authenticate")).toBe("Bearer");
        expect(res.body).toEqual({ message: APPROVAL_MESSAGES.unauthorized });
        expect(res.text).not.toContain(MARKER);
        noKeyIn(res.text);
      }
    }
    expect(touched).toEqual([]);
  });

  it("never lets the approver key onto /mcp", async () => {
    const url = await gate();
    const res = await fetch(`${url}/mcp`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${APPROVER_KEY}`,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(res.status).toBe(401);
    noKeyIn(await res.text());
  });

  it("answers 400 for bad or unknown parameters without echoing them", async () => {
    const url = await gate();
    const bad: [string, string][] = [
      [`/audit/decisions?${MARKER}=1`, AUDIT_MESSAGES.badQuery],
      [`/audit/decisions?decision=${MARKER}`, AUDIT_MESSAGES.badQuery],
      ["/audit/decisions?limit=0", AUDIT_MESSAGES.badQuery],
      ["/audit/decisions?limit=201", AUDIT_MESSAGES.badQuery],
      [`/audit/decisions?limit=${MARKER}`, AUDIT_MESSAGES.badQuery],
      ["/audit/decisions?limit=1&limit=2", AUDIT_MESSAGES.badQuery],
      [`/audit/decisions?q=${"x".repeat(201)}`, AUDIT_MESSAGES.badQuery],
      ["/audit/decisions?before=-1", AUDIT_MESSAGES.badQuery],
      [`/audit/decisions/${MARKER}`, AUDIT_MESSAGES.badSeq],
      ["/audit/decisions/0", AUDIT_MESSAGES.badSeq],
      [`/audit/decisions/${log.beat5Seq}?${MARKER}=1`, AUDIT_MESSAGES.badQuery],
      [`/audit/intents/${MARKER}`, AUDIT_MESSAGES.badIntent],
      [`/audit/intents/${log.beat5Intent}?x=${MARKER}`, AUDIT_MESSAGES.badQuery],
      [`/audit/entries?q=${MARKER}`, AUDIT_MESSAGES.badQuery],
      ["/audit/entries?limit=0", AUDIT_MESSAGES.badQuery],
      [`/audit/verify?${MARKER}=1`, AUDIT_MESSAGES.badQuery],
      ["/audit/export", AUDIT_MESSAGES.badExport],
      [`/audit/export?intent=${log.beat5Intent}&capture=CAP-1037`, AUDIT_MESSAGES.badExport],
      [`/audit/export?intent=${MARKER}`, AUDIT_MESSAGES.badExport],
      [`/audit/export?capture=${MARKER}%22%0D%0A`, AUDIT_MESSAGES.badExport],
      [`/audit/export?capture=CAP-1037&${MARKER}=1`, AUDIT_MESSAGES.badExport],
    ];
    for (const [route, text] of bad) {
      const res = await get(`${url}${route}`);
      expect({ route, status: res.status, body: res.body }).toEqual({
        route,
        status: 400,
        body: { message: text },
      });
      expect(res.text).not.toContain(MARKER);
    }
  });

  it("answers 404 for an unknown seq, intent or empty export", async () => {
    const url = await gate();
    const missing: [string, string][] = [
      [`/audit/decisions/${log.approvalSeq}`, AUDIT_MESSAGES.noDecision],
      ["/audit/decisions/999999", AUDIT_MESSAGES.noDecision],
      [`/audit/intents/int_${"0".repeat(24)}`, AUDIT_MESSAGES.noIntent],
      [`/audit/export?intent=int_${"0".repeat(24)}`, AUDIT_MESSAGES.nothingToExport],
      ["/audit/export?capture=CAP-9999", AUDIT_MESSAGES.nothingToExport],
    ];
    for (const [route, text] of missing) {
      const res = await get(`${url}${route}`);
      expect({ route, status: res.status, body: res.body }).toEqual({
        route,
        status: 404,
        body: { message: text },
      });
    }
  });

  it("answers 503 on every route with no database", async () => {
    const url = await listen({ env: ENV, clock: () => READ_AT });
    for (const route of routes()) {
      const res = await get(`${url}${route}`);
      expect(res.status).toBe(503);
      expect(res.body).toEqual({ message: AUDIT_MESSAGES.unavailable });
    }
  });

  it("leaves the log's head and row count unchanged on every route", async () => {
    const before = await verifyLog(db);
    const count = async () =>
      (await db.select({ n: sql<number>`count(*)::int` }).from(auditLog))[0]?.n;
    const rowsBefore = await count();
    const url = await gate();
    for (const route of [
      ...routes(),
      `/audit/decisions/${log.unreadableSeq}`,
      "/audit/export?capture=CAP-1037",
      "/audit/export?capture=CAP-9999",
    ]) {
      await get(`${url}${route}`);
    }
    expect(await verifyLog(db)).toEqual(before);
    expect(await count()).toBe(rowsBefore);
  });

  // Last, because it breaks the chain.
  it("reports a row edited behind the trigger as broken at its seq", async () => {
    await db.execute(sql`ALTER TABLE audit_log DISABLE TRIGGER audit_log_append_only`);
    await db.execute(
      sql`UPDATE audit_log SET payload = replace(payload, '24000', '24001') WHERE seq = ${log.beat5Seq}`,
    );
    await db.execute(sql`ALTER TABLE audit_log ENABLE TRIGGER audit_log_append_only`);
    const url = await gate();
    const verify = await get(`${url}/audit/verify`);
    expect(verify.status).toBe(200);
    expect(verify.body.intact).toBe(false);
    expect(verify.body.head).toMatchObject({ seq: log.unreadableSeq });
    expect(verify.body.problems.map((problem: { seq: number }) => problem.seq)).toContain(
      log.beat5Seq,
    );
    expect(verify.body.problems[0]).toEqual({
      seq: log.beat5Seq,
      code: expect.any(String),
      detail: expect.any(String),
    });
    const exported = await get(`${url}/audit/export?intent=${log.beat5Intent}`);
    expect(exported.body.chain).toMatchObject({ intact: false });
  });
});
