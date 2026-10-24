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
  sha256Hex,
  sql,
  writeEvidenceDocument,
  writeTicket,
} from "@countersign/db";
import { appendEntries } from "@countersign/ledger";
import { hashMandate, parseMandate, REASONS } from "@countersign/mandate";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { type AppDeps, createApp } from "../src/app";
import { type Card, cardView, TICKET_EXCERPT_LENGTH } from "../src/approval-cards";
import type { StepUp } from "../src/approval-log";
import { APPROVAL_BODY_LIMIT, APPROVAL_MESSAGES } from "../src/approvals-api";
import { APPROVER_KEY_VAR } from "../src/approver";
import { claimsVsRecords } from "../src/claims";
import { APPROVAL_WINDOW_MS } from "../src/decide";
import { EVIDENCE_CARRIER } from "../src/executors";
import { OPS_AGENT_KEY_VAR, SUPPORT_AGENT_KEY_VAR } from "../src/principals";
import { propose } from "../src/propose";
import { createFakeSandbox } from "./fake-sandbox";

// The gate's approval API (ADR 0032) over HTTP on 127.0.0.1, with PGlite, the fake sandbox and an
// injected clock. Step-ups come from real decisions under the shipped mandate. Illustrative IDs,
// keys and people.

const SLOW = 60_000;
const NOW = new Date("2026-10-17T09:00:00+03:00");
const LATER = new Date(NOW.getTime() + 5 * 60 * 1000);
const PAST_EXPIRY = new Date(NOW.getTime() + APPROVAL_WINDOW_MS + 1);
const AGENT_KEY = "agent-key-illustrative-0123456789abcdef";
const APPROVER_KEY = "approver-key-illustrative-0123456789abcd";
const ENV = { [SUPPORT_AGENT_KEY_VAR]: AGENT_KEY, [APPROVER_KEY_VAR]: APPROVER_KEY };
const PAYER = "wanjiru.m@example.com";
const INVOICE = "INV2-ABCD-EFGH-IJKL-MNOP";
const DISPUTE = "PP-D-4012";
const BODY = `My basket arrived crushed. ${"The handles are torn and the weave is split. ".repeat(10)}`;

const mandateFile = fileURLToPath(
  new URL("../../../packages/mandate/fixtures/kikapu-studio-v3.json", import.meta.url),
);
const parsedMandate = parseMandate(JSON.parse(readFileSync(mandateFile, "utf8")));
if (!parsedMandate.ok) throw new Error(parsedMandate.error);
const mandate = parsedMandate.mandate;
const parsedOps = parseMandate(
  JSON.parse(
    readFileSync(
      fileURLToPath(
        new URL("../../../packages/mandate/fixtures/kikapu-studio-ops-v1.json", import.meta.url),
      ),
      "utf8",
    ),
  ),
);
if (!parsedOps.ok) throw new Error(parsedOps.error);
const opsMandate = parsedOps.mandate;

const usd = (minor: number) => ({ minor, currency: "USD" as const });

type Who = { mandate: typeof mandate; principal: "support-agent" | "ops-agent" };
const SUPPORT: Who = { mandate, principal: "support-agent" };
const OPS: Who = { mandate: opsMandate, principal: "ops-agent" };
const OPS_KEY = "ops-key-illustrative-0123456789abcdefgh";
const DYE_WORKS = "dyeworks@example.com";
const payout = (args: Record<string, unknown> = {}) => ({
  tool: "create_payout",
  args: {
    receiver: DYE_WORKS,
    amount: { value: "45.00", currency_code: "USD" },
    reference: "KDW-2026-0412",
    ...args,
  },
});

// Beat 5 (the payer of KIK-1037 asks for $240.00 back for a damaged basket, with a photo), plus a
// draft invoice and an open dispute.
function world() {
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
  rail.invoices.set(INVOICE, {
    id: INVOICE,
    status: "DRAFT",
    amount: usd(2500),
    invoiceNumber: "KIK-INV-0007",
    recipientEmails: [PAYER],
  });
  rail.disputeDetails.set(DISPUTE, {
    id: DISPUTE,
    status: "WAITING_FOR_SELLER_RESPONSE",
    amount: usd(4500),
    captureIds: [captureId],
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
type World = ReturnType<typeof world>;

const refund = (value: string) => ({
  tool: "create_refund",
  args: { capture_id: "CAP-1037", amount: { value, currency_code: "USD" } },
  justification: { ticket_id: "TKT-1037", claim: "damaged" },
});
const sendInvoice = {
  tool: "send_invoice",
  args: { invoice_id: INVOICE, note: "Thanks for your order." },
  justification: { ticket_id: "TKT-1037" },
};
const acceptClaim = {
  tool: "accept_dispute_claim",
  args: { dispute_id: DISPUTE, note: "Refunding in full." },
  justification: { ticket_id: "TKT-1037" },
};
const refundOffer = {
  tool: "make_offer",
  args: {
    dispute_id: DISPUTE,
    offer_type: "REFUND_WITH_RETURN",
    offer_amount: { value: "20.00", currency_code: "USD" },
    note: "Send it back and we'll refund $20.00.",
  },
};
const replacementOffer = {
  tool: "make_offer",
  args: { dispute_id: DISPUTE, offer_type: "REPLACEMENT_WITHOUT_REFUND", note: "A new basket." },
};

const DOCUMENT = "doc_0123456789abcdef01234567";
const DOCUMENT_NAME = `countersign-evidence-${DISPUTE}.pdf`;
const PDF_BYTES = new TextEncoder().encode("%PDF-1.7 illustrative evidence");
const FULFILMENT_NOTES = "Shipped under tracking TRK1037 (simulated carrier data).";
const provideEvidence = {
  tool: "provide_dispute_evidence",
  args: {
    dispute_id: DISPUTE,
    evidence: [
      {
        evidence_type: "PROOF_OF_FULFILLMENT",
        notes: FULFILMENT_NOTES,
        tracking_numbers: ["TRK1037"],
      },
      { evidence_type: "PROOF_OF_REFUND", notes: "Refunded.", refund_ids: ["REF-1037"] },
    ],
    document_ids: [DOCUMENT],
  },
};

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

const bearer = (key: string) => ({ Authorization: `Bearer ${key}` });

const getJson = async (url: string, key = APPROVER_KEY) => {
  const res = await fetch(url, { headers: bearer(key) });
  const text = await res.text();
  return { status: res.status, text, body: JSON.parse(text) };
};

const postJson = async (url: string, body: unknown, key = APPROVER_KEY) => {
  const res = await fetch(url, {
    method: "POST",
    headers: { ...bearer(key), "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, text, body: JSON.parse(text) };
};

const noKeyIn = (text: string) => {
  expect(text).not.toContain(APPROVER_KEY);
  expect(text).not.toContain(AGENT_KEY);
};

describe("the approval API", { timeout: SLOW }, () => {
  let handle: DatabaseHandle;
  let db: Database;

  beforeAll(async () => {
    handle = await createTestDatabase();
    db = handle.db;
  }, SLOW);

  beforeEach(async () => {
    await db.execute(sql`TRUNCATE audit_log, tickets, seed_orders, evidence_documents`);
    await writeEvidenceDocument(db, {
      id: DOCUMENT,
      disputeId: DISPUTE,
      kind: "pdf",
      name: DOCUMENT_NAME,
      contentType: "application/pdf",
      bytes: PDF_BYTES,
      createdAt: NOW.toISOString(),
    });
    await writeTicket(db, {
      id: "TKT-1037",
      channel: "email",
      senderEmail: PAYER,
      senderPhone: null,
      subject: "Damaged basket",
      body: BODY,
      attachments: [{ id: "ATT-TKT-1037", contentType: "image/jpeg" }],
      receivedAt: "2026-10-17T08:00:00+03:00",
      simulated: true,
    });
    await db.insert(seedOrders).values({
      orderNumber: "KIK-1037",
      runId: "run-illustrative",
      paypalOrderId: "ORD-1037",
      paypalCaptureId: "CAP-1037",
      amountMinor: 24000,
      currency: "USD",
      payerEmail: PAYER,
      buyer: "Wanjiru M. (illustrative)",
      trackingNumber: "TRK1037",
      role: "damaged",
      seededAt: "2026-10-01T08:00:00Z",
    });
  });

  afterAll(async () => {
    await handle.close();
  });

  const entries = () => db.select().from(auditLog).orderBy(asc(auditLog.seq));

  const stepUp = async (w: World, proposal: unknown, who: Who = SUPPORT) => {
    const result = await propose({
      mandate: who.mandate,
      principal: who.principal,
      proposal,
      now: NOW,
      ...w,
      db,
      clock: () => NOW,
    });
    if (!result.ok || result.replay) throw new Error("not decided");
    expect(result.record.decision).toBe("step_up");
    const hash = result.record.intentHash;
    if (hash === null) throw new Error("no intent hash");
    return { seq: result.seqs.decision, hash, intentId: result.record.intentId };
  };

  const gate = (w: World, now = LATER, env: Record<string, string | undefined> = ENV) => {
    const logged: string[] = [];
    const url = listen({
      db,
      rail: () => w.rail,
      env,
      clock: () => now,
      log: (line) => logged.push(line),
    });
    return { url, logged };
  };

  it("lists beat 5's card with every field, approves it with its hash and refunds once", async () => {
    const w = world();
    const { seq, hash, intentId } = await stepUp(w, refund("240.00"));
    const url = await gate(w).url;

    const list = await getJson(`${url}/approvals`);
    expect(list.status).toBe(200);
    noKeyIn(list.text);
    expect(list.body.recent).toEqual([]);
    expect(list.body.open).toHaveLength(1);
    const card: Card = list.body.open[0];
    expect(card).toMatchObject({
      step_up_id: seq,
      intent_id: intentId,
      intent_hash: hash,
      principal: "support-agent",
      action: "paypal.refund",
      action_words: "Refund",
      amount: { minor: 24000, currency: "USD", display: "$240.00" },
      target: { kind: "capture", id: "CAP-1037" },
      order_number: "KIK-1037",
      ticket: {
        id: "TKT-1037",
        channel: "email",
        sender: PAYER,
        subject: "Damaged basket",
        excerpt: BODY.slice(0, TICKET_EXCERPT_LENGTH),
        received_at: "2026-10-17T08:00:00+03:00",
        attachment_ids: ["ATT-TKT-1037"],
        simulated: true,
      },
      claim: "damaged",
      params: null,
      state: "open",
      answer: null,
      can_execute: true,
      cannot_execute: null,
      expires_at: new Date(NOW.getTime() + APPROVAL_WINDOW_MS).toISOString(),
    });
    expect(card.ticket?.excerpt).toHaveLength(TICKET_EXCERPT_LENGTH);
    expect(Date.parse(card.decided_at)).toBe(NOW.getTime());
    expect(card.reasons.length).toBeGreaterThan(0);
    for (const reason of card.reasons) {
      expect(reason.words).toBe(REASONS[reason.code as keyof typeof REASONS].words);
      expect(reason.detail.length).toBeGreaterThan(0);
    }
    // Only the checks refund-damaged uses, each with where its records came from.
    expect(card.checks.map((check) => check.verifier).sort()).toEqual(
      [
        "capture.refundable",
        "evidence.photo_present",
        "ledger.not_duplicate",
        "ticket.from_payer",
      ].sort(),
    );
    const capture = card.checks.find((check) => check.verifier === "capture.refundable");
    expect(capture?.result).toBe("pass");
    expect(capture?.records).toContainEqual({ call: expect.any(String), id: "CAP-1037" });

    // The same pairs as the decision page, one per check that decided, then the message.
    expect(card.claims.map((pair) => pair.check)).toEqual([
      ...card.checks.map((check) => check.verifier),
      "message",
    ]);
    expect(card.claims.find((pair) => pair.check === "evidence.photo_present")?.verdict).toBe(
      "matches",
    );
    expect(card.claims.at(-1)?.verdict).toBe("not_used");

    const one = await getJson(`${url}/approvals/${seq}`);
    expect(one.status).toBe(200);
    expect(one.body).toEqual(card);

    const answer = await postJson(`${url}/approvals/${seq}`, {
      answer: "approve",
      intent_hash: hash,
    });
    expect(answer.status).toBe(200);
    noKeyIn(answer.text);
    expect(answer.body).toMatchObject({
      outcome: "approved",
      code: null,
      step_up_id: seq,
      intent_id: intentId,
      execution: { outcome: "executed", refund: { status: "COMPLETED" }, error: null },
    });
    expect(w.rail.calls.filter((call) => call.call === "refundCapture")).toHaveLength(1);

    const after = await getJson(`${url}/approvals`);
    expect(after.body.open).toEqual([]);
    expect(after.body.recent).toEqual([
      expect.objectContaining({
        step_up_id: seq,
        action_words: "Refund",
        order_number: "KIK-1037",
        outcome: "approved",
        channel: "approvals_page",
        execution: {
          outcome: "executed",
          refund: { id: answer.body.execution.refund.id, status: "COMPLETED" },
          invoice: null,
          dispute: null,
        },
      }),
    ]);
    const answered = await getJson(`${url}/approvals/${seq}`);
    expect(answered.body).toMatchObject({ state: "answered", answer: { outcome: "approved" } });
  });

  it("answers an approved payout with its batch and item", async () => {
    const w = world();
    const decided = await propose({
      mandate: opsMandate,
      principal: "ops-agent",
      proposal: {
        tool: "create_payout",
        args: {
          receiver: "dyeworks@example.com",
          amount: { value: "45.00", currency_code: "USD" },
          reference: "KDW-2026-0412",
        },
      },
      now: NOW,
      ...w,
      db,
      clock: () => NOW,
    });
    if (!decided.ok || decided.replay) throw new Error("not decided");
    expect(decided.record.decision).toBe("step_up");
    const url = await gate(w).url;

    const answer = await postJson(`${url}/approvals/${decided.seqs.decision}`, {
      answer: "approve",
      intent_hash: decided.record.intentHash,
    });

    expect(answer.status).toBe(200);
    expect(answer.body.execution).toEqual({
      outcome: "executed",
      refund: null,
      invoice: null,
      dispute: null,
      payout: {
        batchId: "FAKEBATCH0001",
        batchStatus: "PENDING",
        item: { id: "FAKEITEM0001", status: "UNCLAIMED" },
      },
      error: null,
    });
    expect(w.rail.calls.filter((call) => call.call === "createPayout")).toHaveLength(1);
  });

  it("shows a payout's payee, amount, bill and note, with the name from the ops mandate", async () => {
    const w = world();
    const noted = await stepUp(w, payout({ note: "Dye for the October baskets." }), OPS);
    const bare = await stepUp(w, payout({ reference: "KDW-2026-0413" }), OPS);
    const url = await gate(w).url;

    const list = await getJson(`${url}/approvals`);
    expect(list.status).toBe(200);
    noKeyIn(list.text);
    const cards: Card[] = list.body.open;
    const bySeq = (seq: number): Card | undefined => cards.find((card) => card.step_up_id === seq);

    expect(bySeq(noted.seq)).toMatchObject({
      principal: "ops-agent",
      action: "paypal.payout",
      amount: { minor: 4500, currency: "USD", display: "$45.00" },
      target: { kind: "payee", id: DYE_WORKS },
      order_number: null,
      ticket: null,
      can_execute: true,
      cannot_execute: null,
      params: {
        kind: "payout",
        reference: "KDW-2026-0412",
        note: "Dye for the October baskets.",
        payee_name: "Kisumu Dye Works (illustrative)",
      },
    });
    expect(bySeq(bare.seq)?.params).toEqual({
      kind: "payout",
      reference: "KDW-2026-0413",
      note: null,
      payee_name: "Kisumu Dye Works (illustrative)",
    });
    expect(bySeq(noted.seq)?.checks.map((check) => check.verifier)).toEqual(["payee.allowlisted"]);
    expect((await getJson(`${url}/approvals/${noted.seq}`)).body).toEqual(bySeq(noted.seq));
  });

  it("refuses the ops key on the approval API, and writes nothing", async () => {
    const w = world();
    const { seq, hash } = await stepUp(w, payout(), OPS);
    const url = await gate(w, LATER, { ...ENV, [OPS_AGENT_KEY_VAR]: OPS_KEY }).url;
    const before = await entries();

    const list = await getJson(`${url}/approvals`, OPS_KEY);
    expect(list.status).toBe(401);
    expect(list.body).toEqual({ message: APPROVAL_MESSAGES.unauthorized });
    expect((await getJson(`${url}/approvals/${seq}`, OPS_KEY)).status).toBe(401);
    const post = await postJson(
      `${url}/approvals/${seq}`,
      { answer: "approve", intent_hash: hash },
      OPS_KEY,
    );
    expect(post.status).toBe(401);
    expect(post.text).not.toContain(OPS_KEY);
    expect(await entries()).toEqual(before);
    expect(w.rail.calls.filter((call) => call.call === "createPayout")).toHaveLength(0);
  });

  it("refuses agents, wrong keys and no key with 401, and writes nothing", async () => {
    const w = world();
    const { seq, hash } = await stepUp(w, refund("240.00"));
    const url = await gate(w).url;
    const before = await entries();

    for (const key of [AGENT_KEY, `${APPROVER_KEY}x`, "short"]) {
      const list = await getJson(`${url}/approvals`, key);
      expect(list.status).toBe(401);
      expect(list.body).toEqual({ message: APPROVAL_MESSAGES.unauthorized });
      expect((await getJson(`${url}/approvals/${seq}`, key)).status).toBe(401);
      const post = await postJson(
        `${url}/approvals/${seq}`,
        { answer: "approve", intent_hash: hash },
        key,
      );
      expect(post.status).toBe(401);
      noKeyIn(post.text);
    }
    const bare = await fetch(`${url}/approvals`);
    expect(bare.status).toBe(401);
    expect(await entries()).toEqual(before);
    expect(w.rail.calls.filter((call) => call.call === "refundCapture")).toHaveLength(0);
  });

  it("refuses the approver key on /mcp", async () => {
    const url = await gate(world()).url;
    const res = await fetch(`${url}/mcp`, {
      method: "POST",
      headers: {
        ...bearer(APPROVER_KEY),
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(res.status).toBe(401);
  });

  it("counts a short key or a principal key's value as unset, naming only the variable", async () => {
    const w = world();
    for (const env of [
      { [SUPPORT_AGENT_KEY_VAR]: AGENT_KEY, [APPROVER_KEY_VAR]: "too-short" },
      { [SUPPORT_AGENT_KEY_VAR]: AGENT_KEY, [APPROVER_KEY_VAR]: AGENT_KEY },
      { [SUPPORT_AGENT_KEY_VAR]: AGENT_KEY },
    ]) {
      const { url, logged } = gate(w, LATER, env);
      const base = await url;
      const line = logged.find((entry) => entry.includes(APPROVER_KEY_VAR));
      expect(line).toBeDefined();
      for (const entry of logged) {
        expect(entry).not.toContain(AGENT_KEY);
        expect(entry).not.toContain("too-short");
      }
      for (const key of [AGENT_KEY, "too-short"]) {
        expect((await getJson(`${base}/approvals`, key)).status).toBe(401);
      }
    }
    const { logged } = gate(w);
    expect(logged.some((entry) => entry.includes(APPROVER_KEY_VAR))).toBe(false);
  });

  it("answers 400 for a bad body and 404 for an unknown step-up, writing nothing", async () => {
    const w = world();
    const { seq, hash } = await stepUp(w, refund("240.00"));
    const url = await gate(w).url;
    const before = await entries();

    for (const body of [
      { answer: "maybe", intent_hash: hash },
      { answer: "approve" },
      { answer: "approve", intent_hash: hash, amount: 1 },
      { answer: "approve", intent_hash: "ABC" },
      "not json",
      '"approve"',
      { answer: "approve", intent_hash: hash, pad: "x".repeat(17 * 1024) },
    ]) {
      const res = await postJson(`${url}/approvals/${seq}`, body);
      expect(res.status).toBe(400);
      expect(Object.keys(res.body)).toEqual(["message"]);
      expect(res.text).not.toContain("maybe");
    }
    expect(APPROVAL_BODY_LIMIT).toBe("16kb");

    for (const id of [String(seq + 100), "abc", "0", "1e3"]) {
      expect((await getJson(`${url}/approvals/${id}`)).status).toBe(404);
      const post = await postJson(`${url}/approvals/${id}`, { answer: "deny", intent_hash: hash });
      expect(post.status).toBe(404);
    }
    expect(await entries()).toEqual(before);
  });

  it("answers a changed hash or an expired card with a 200 rejection, and sends nothing", async () => {
    const w = world();
    const { seq, hash } = await stepUp(w, refund("240.00"));
    const url = await gate(w).url;

    const changed = await postJson(`${url}/approvals/${seq}`, {
      answer: "approve",
      intent_hash: "0".repeat(64),
    });
    expect(changed.status).toBe(200);
    expect(changed.body).toMatchObject({
      outcome: "rejected",
      code: "HASH_MISMATCH",
      execution: null,
    });

    const late = await gate(w, PAST_EXPIRY).url;
    const expired = await postJson(`${late}/approvals/${seq}`, {
      answer: "approve",
      intent_hash: hash,
    });
    expect(expired.body).toMatchObject({ outcome: "rejected", code: "EXPIRED" });
    const list = await getJson(`${late}/approvals`);
    expect(list.body.open).toEqual([]);
    expect(list.body.recent).toEqual([
      expect.objectContaining({ step_up_id: seq, outcome: "expired", execution: null }),
    ]);
    expect(w.rail.calls.filter((call) => call.call === "refundCapture")).toHaveLength(0);
  });

  it("shows an invoice send and an accepted claim as executable", async () => {
    const w = world();
    const invoice = await stepUp(w, sendInvoice);
    const claim = await stepUp(w, acceptClaim);
    const url = await gate(w).url;

    const list = await getJson(`${url}/approvals`);
    const cards: Card[] = list.body.open;
    expect(cards.map((card) => card.step_up_id)).toEqual([claim.seq, invoice.seq]);
    expect(cards[0]).toMatchObject({
      action_words: "Accept dispute claim",
      target: { kind: "dispute", id: DISPUTE },
      order_number: null,
      can_execute: true,
      cannot_execute: null,
      checks: [],
    });
    expect(cards[1]).toMatchObject({
      action_words: "Send invoice",
      amount: { minor: 2500, display: "$25.00" },
      target: { kind: "invoice", id: INVOICE },
      can_execute: true,
      cannot_execute: null,
    });
    expect(cards[0]?.params).toEqual({ kind: "accept_claim", note: "Refunding in full." });
    expect(cards[1]?.params).toEqual({
      kind: "invoice_send",
      note: "Thanks for your order.",
      send_to_recipient: true,
      additional_recipients: [],
    });
  });

  it("shows each offer's type, amount and note, and every evidence item and document", async () => {
    const w = world();
    const offer = await stepUp(w, refundOffer);
    const replacement = await stepUp(w, replacementOffer);
    const evidence = await stepUp(w, provideEvidence);
    const url = await gate(w).url;

    const list = await getJson(`${url}/approvals`);
    expect(list.status).toBe(200);
    const bySeq = (seq: number): Card | undefined =>
      (list.body.open as Card[]).find((card) => card.step_up_id === seq);

    expect(bySeq(offer.seq)?.params).toEqual({
      kind: "make_offer",
      offer_type: "REFUND_WITH_RETURN",
      offer_type_words: "Refund with return",
      amount: { minor: 2000, currency: "USD", display: "$20.00" },
      note: "Send it back and we'll refund $20.00.",
    });
    expect(bySeq(replacement.seq)?.params).toEqual({
      kind: "make_offer",
      offer_type: "REPLACEMENT_WITHOUT_REFUND",
      offer_type_words: "Replacement without refund",
      amount: null,
      note: "A new basket.",
    });

    const card = bySeq(evidence.seq);
    expect(card).toMatchObject({
      action_words: "Provide dispute evidence",
      target: { kind: "dispute", id: DISPUTE },
      can_execute: true,
    });
    expect(card?.params).toEqual({
      kind: "provide_evidence",
      items: [
        {
          evidence_type: "PROOF_OF_FULFILLMENT",
          evidence_type_words: "Proof of fulfillment",
          notes: FULFILMENT_NOTES,
          tracking_numbers: ["TRK1037"],
          tracking_carrier: EVIDENCE_CARRIER.nameOther,
          refund_ids: [],
        },
        {
          evidence_type: "PROOF_OF_REFUND",
          evidence_type_words: "Proof of refund",
          notes: "Refunded.",
          tracking_numbers: [],
          tracking_carrier: null,
          refund_ids: ["REF-1037"],
        },
      ],
      documents: [
        {
          id: DOCUMENT,
          name: DOCUMENT_NAME,
          sha256: sha256Hex(PDF_BYTES),
          size: PDF_BYTES.byteLength,
          available: true,
        },
      ],
    });
    expect((await getJson(`${url}/approvals/${evidence.seq}`)).body).toEqual(card);

    // A document that's gone shows as unavailable, with no size; the card still reads.
    await db.execute(sql`TRUNCATE evidence_documents`);
    const gone = await getJson(`${url}/approvals/${evidence.seq}`);
    expect(gone.status).toBe(200);
    expect(gone.body.params.documents).toEqual([
      expect.objectContaining({ id: DOCUMENT, size: null, available: false }),
    ]);
  });

  it("approves an evidence card, sends it once and answers the dispute's status", async () => {
    const w = world();
    const { seq, hash, intentId } = await stepUp(w, provideEvidence);
    const url = await gate(w).url;

    const answer = await postJson(`${url}/approvals/${seq}`, {
      answer: "approve",
      intent_hash: hash,
    });
    expect(answer.status).toBe(200);
    expect(answer.body).toMatchObject({
      outcome: "approved",
      intent_id: intentId,
      execution: {
        outcome: "executed",
        refund: null,
        invoice: null,
        dispute: { id: DISPUTE, status: "UNDER_REVIEW" },
        error: null,
      },
    });
    expect(w.rail.calls.filter((call) => call.call === "provideEvidence")).toHaveLength(1);

    const after = await getJson(`${url}/approvals`);
    expect(after.body.recent).toEqual([
      expect.objectContaining({
        step_up_id: seq,
        outcome: "approved",
        execution: {
          outcome: "executed",
          refund: null,
          invoice: null,
          dispute: { id: DISPUTE, status: "UNDER_REVIEW" },
        },
      }),
    ]);
  });

  it("downloads a document to the approver key only, with its type and an attachment name", async () => {
    const url = await gate(world()).url;
    const path = `${url}/approvals/documents/${DOCUMENT}`;

    const res = await fetch(path, { headers: bearer(APPROVER_KEY) });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(res.headers.get("content-disposition")).toBe(`attachment; filename=${DOCUMENT_NAME}`);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(PDF_BYTES);

    for (const key of [AGENT_KEY, `${APPROVER_KEY}x`]) {
      const refused = await getJson(path, key);
      expect(refused.status).toBe(401);
      expect(refused.body).toEqual({ message: APPROVAL_MESSAGES.unauthorized });
    }
    expect((await fetch(path)).status).toBe(401);

    for (const id of ["doc_123", "DOC_0123456789ABCDEF01234567", "abc", `${DOCUMENT}0`]) {
      const bad = await getJson(`${url}/approvals/documents/${id}`);
      expect(bad.status).toBe(400);
      expect(bad.body).toEqual({ message: APPROVAL_MESSAGES.badDocumentId });
    }
    const unknown = await getJson(`${url}/approvals/documents/doc_${"f".repeat(24)}`);
    expect(unknown.status).toBe(404);
    expect(unknown.body).toEqual({ message: APPROVAL_MESSAGES.documentNotFound });
  });

  it("answers 503 when a step-up entry can't be read, and approves nothing", async () => {
    const w = world();
    const { seq, hash, intentId } = await stepUp(w, refund("240.00"));
    const broken = await appendEntries(db, [
      { entryType: "approval", refId: intentId, at: NOW.toISOString(), payload: { junk: true } },
    ]);
    if (!broken.ok) throw new Error(broken.rejection.detail);
    const url = await gate(w).url;
    const before = await entries();

    const list = await getJson(`${url}/approvals`);
    expect(list.status).toBe(503);
    expect(list.body).toEqual({ message: APPROVAL_MESSAGES.unreadable });
    expect((await getJson(`${url}/approvals/${seq}`)).status).toBe(503);
    const post = await postJson(`${url}/approvals/${seq}`, {
      answer: "approve",
      intent_hash: hash,
    });
    expect(post.status).toBe(503);
    expect(await entries()).toEqual(before);
    expect(w.rail.calls.filter((call) => call.call === "refundCapture")).toHaveLength(0);
  });

  it("denies without PayPal set up, but won't approve", async () => {
    const w = world();
    const first = await stepUp(w, refund("240.00"));
    const noRail = await listen({
      db,
      env: ENV,
      clock: () => LATER,
      rail: () => {
        throw new Error("PayPal variables missing");
      },
    });
    const approve = await postJson(`${noRail}/approvals/${first.seq}`, {
      answer: "approve",
      intent_hash: first.hash,
    });
    expect(approve.status).toBe(503);
    expect(approve.body).toEqual({ message: APPROVAL_MESSAGES.noRail });
    expect((await entries()).some((row) => row.entryType === "approval")).toBe(false);

    const deny = await postJson(`${noRail}/approvals/${first.seq}`, {
      answer: "deny",
      intent_hash: first.hash,
    });
    expect(deny.status).toBe(200);
    expect(deny.body).toMatchObject({ outcome: "denied", execution: null });
  });

  it("answers 503 with no database", async () => {
    const url = await listen({ env: ENV });
    expect((await getJson(`${url}/approvals`)).status).toBe(503);
    expect((await getJson(`${url}/approvals/1`)).status).toBe(503);
    expect((await getJson(`${url}/approvals/documents/${DOCUMENT}`)).status).toBe(503);
  });
});

describe("cardView", () => {
  const stepUp: StepUp = {
    seq: 7,
    intentId: `int_${"a".repeat(24)}`,
    intentHash: "b".repeat(64),
    intentCanonical: "{}",
    intent: {
      principal: "support-agent",
      rail: "paypal",
      action: "paypal.refund",
      amount: usd(24000),
      target: { kind: "capture", captureId: "CAP-1037", orderId: null },
      ticketId: "TKT-1037",
      claim: "damaged",
      mandateVersion: 3,
    },
    principal: "support-agent",
    mandate: { id: "unknown-mandate", version: 1, hash: "c".repeat(64) },
    trace: [
      {
        verifier: "dispute.none_open",
        result: "pass",
        records: [{ call: "GET /v1/customer/disputes", id: null }],
        detail: "No open dispute.",
      },
      {
        verifier: "shipment.status",
        result: "pass",
        records: [{ call: "GET /shipments/{tracking}", id: "TRK1037" }],
        detail: "Delivered.",
        value: "delivered",
      },
    ],
    matchedRules: ["refund-damaged"],
    reasons: [{ code: "ALWAYS_NEEDS_APPROVAL", detail: "Held." }],
    decidedAt: NOW.toISOString(),
    expiresAt: LATER.toISOString(),
    state: "open",
    answer: null,
  };

  it("shows every check when the step-up's mandate isn't one it knows", () => {
    const card = cardView(stepUp, { ticket: null, orderNumber: null, mandates: [mandate] });
    expect(card.ticket).toBeNull();
    expect(card.claims).toEqual(
      claimsVsRecords(
        { ...stepUp, proposal: "" },
        { ticket: null, orderNumber: null, mandates: [mandate] },
      ),
    );
    expect(card.checks).toEqual([
      {
        verifier: "dispute.none_open",
        result: "pass",
        value: null,
        detail: "No open dispute.",
        records: [{ call: "GET /v1/customer/disputes", id: null }],
      },
      {
        verifier: "shipment.status",
        result: "pass",
        value: "delivered",
        detail: "Delivered.",
        records: [{ call: "GET /shipments/{tracking}", id: "TRK1037" }],
      },
    ]);
    expect(card.reasons).toEqual([
      {
        code: "ALWAYS_NEEDS_APPROVAL",
        words: REASONS.ALWAYS_NEEDS_APPROVAL.words,
        detail: "Held.",
      },
    ]);
  });

  describe("a payout card's payee name", () => {
    const payoutStepUp = (email: string, params: StepUp["intent"]["params"]): StepUp => ({
      ...stepUp,
      intent: {
        principal: "ops-agent",
        rail: "paypal",
        action: "paypal.payout",
        amount: usd(4500),
        target: { kind: "payee", email },
        ticketId: null,
        claim: null,
        mandateVersion: 1,
        params,
      },
      principal: "ops-agent",
      mandate: { id: "kikapu-studio-ops", version: 1, hash: hashMandate(opsMandate).hash },
      trace: [],
      matchedRules: ["payout-listed-supplier"],
    });
    const context = (mandates: (typeof mandate)[]) => ({
      ticket: null,
      orderNumber: null,
      mandates,
    });
    const listed = payoutStepUp(DYE_WORKS, { note: "October dye.", reference: "KDW-2026-0412" });

    it("comes from the mandate that decided, found by hash among the loaded ones", () => {
      const card = cardView(listed, context([mandate, opsMandate]));
      expect(card.params).toEqual({
        kind: "payout",
        reference: "KDW-2026-0412",
        note: "October dye.",
        payee_name: "Kisumu Dye Works (illustrative)",
      });
      expect(card.can_execute).toBe(true);
    });

    it("is null when the deciding mandate isn't loaded, or doesn't list the payee", () => {
      expect(cardView(listed, context([mandate])).params).toMatchObject({ payee_name: null });
      const unlisted = payoutStepUp("refunds.desk@example.com", { reference: "RD-1" });
      expect(cardView(unlisted, context([opsMandate])).params).toEqual({
        kind: "payout",
        reference: "RD-1",
        note: null,
        payee_name: null,
      });
    });

    it("shows no reference when the stored intent has none", () => {
      const card = cardView(
        payoutStepUp(DYE_WORKS, { note: "October dye." }),
        context([opsMandate]),
      );
      expect(card.params).toMatchObject({ kind: "payout", reference: null });
    });
  });

  it("uses a phone number as the sender when the ticket has no email", () => {
    const card = cardView(stepUp, {
      ticket: {
        id: "TKT-9",
        channel: "chat",
        senderEmail: null,
        senderPhone: "+254700000000",
        subject: null,
        body: "Short.",
        attachments: [],
        receivedAt: NOW.toISOString(),
        simulated: true,
      },
      orderNumber: "KIK-1037",
      mandates: [],
    });
    expect(card.ticket).toMatchObject({ sender: "+254700000000", excerpt: "Short." });
    expect(card.order_number).toBe("KIK-1037");
  });
});
