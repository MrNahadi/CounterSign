import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createMemoryShipmentStore, createMockCarrier } from "@countersign/carrier-mock";
import {
  auditLog,
  createTestDatabase,
  type Database,
  type DatabaseHandle,
  eq,
  readTicket,
  sql,
  type Ticket,
  writeTicket,
} from "@countersign/db";
import {
  CLAIMS,
  parseMandate,
  SHIPMENT_STATUSES,
  type TraceEntry,
  VERIFIERS,
} from "@countersign/mandate";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  type ClaimPair,
  type ClaimsDecision,
  checksThatDecided,
  claimsVsRecords,
  MESSAGE_RECORD,
  NO_RECORDS_READ,
  UNREADABLE_PROPOSAL_CLAIM,
} from "../src/claims";
import { propose as runPropose } from "../src/propose";
import { VERIFIER_WORDS } from "../src/words";
import { createFakeSandbox } from "./fake-sandbox";

// Each PGlite start takes a couple of seconds.
const SLOW = 60_000;
const NOW = new Date("2026-10-17T09:00:00+03:00");
const PRINCIPAL = "support-agent";

const mandateFile = fileURLToPath(
  new URL("../../../packages/mandate/fixtures/kikapu-studio-v3.json", import.meta.url),
);
const parsedMandate = parseMandate(JSON.parse(readFileSync(mandateFile, "utf8")));
if (!parsedMandate.ok) throw new Error(parsedMandate.error);
const mandate = parsedMandate.mandate;
const mandates = [mandate];

const usd = (minor: number) => ({ minor, currency: "USD" as const });

// Illustrative orders in PayPal's sandbox shapes, one capture and tracker each.
type Seeded = { n: number; minor: number; payerEmail: string; shipment: string };

function sandboxWith(orders: readonly Seeded[]) {
  const rail = createFakeSandbox();
  const shipments = new Map<string, unknown>();
  for (const { n, minor, payerEmail, shipment } of orders) {
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

const refund = (
  n: number,
  value: string | null,
  ticketId: string,
  claim: string = "not_received",
) => ({
  tool: "create_refund",
  args: {
    capture_id: `CAP-${n}`,
    ...(value === null ? {} : { amount: { value, currency_code: "USD" } }),
  },
  justification: { ticket_id: ticketId, claim },
});

// Illustrative people.
const BUYER_A = "grace.w@example.com";
const BUYER_B = "sb-1039@personal.example.com";
const BEAT4_PAYER = "amina.k@example.com";
const BEAT5_PAYER = "wanjiru.m@example.com";

const LONG_BODY = `My parcel never came. ${"Please refund me now. ".repeat(30)}`;

const ticketOf = (id: string, senderEmail: string, images: number): Ticket => ({
  id,
  channel: "email",
  senderEmail,
  senderPhone: null,
  subject: `About my order (${id})`,
  body: LONG_BODY,
  attachments: Array.from({ length: images }, (_, index) => ({
    id: `ATT-${id}-${index}`,
    contentType: "image/jpeg",
  })),
  receivedAt: "2026-10-17T08:00:00+03:00",
  simulated: true,
});

describe("claims vs records", { timeout: SLOW }, () => {
  let handle: DatabaseHandle;
  let db: Database;

  beforeAll(async () => {
    handle = await createTestDatabase();
    db = handle.db;
  }, SLOW);

  beforeEach(async () => {
    await db.execute(sql`TRUNCATE audit_log, tickets`);
  });

  afterAll(async () => {
    await handle.close();
  });

  // Proposes through propose() and reads back the decision entry it wrote.
  const decisionEntry = async (
    world: ReturnType<typeof sandboxWith>,
    proposal: unknown,
  ): Promise<ClaimsDecision> => {
    const result = await runPropose({
      mandate,
      principal: PRINCIPAL,
      proposal,
      now: NOW,
      rail: world.rail,
      carrier: world.carrier,
      db,
    });
    if (!result.ok || result.replay) throw new Error("not decided");
    const [row] = await db.select().from(auditLog).where(eq(auditLog.seq, result.seqs.decision));
    if (!row) throw new Error("no decision entry");
    const payload = JSON.parse(row.payload);
    return { ...payload.record, proposal: payload.proposal };
  };

  // The pairs for a decision entry, with its ticket read from the store by the intent's ID.
  const pairsFor = async (
    decision: ClaimsDecision,
    orderNumber: string | null,
    loaded = mandates,
  ) => {
    const ticketId = decision.intent?.ticketId ?? null;
    const ticket = ticketId === null ? null : await readTicket(db, ticketId);
    return claimsVsRecords(decision, { ticket, orderNumber, mandates: loaded });
  };

  const beat3World = () =>
    sandboxWith([
      { n: 1039, minor: 6200, payerEmail: BUYER_B, shipment: "stalled_10d" },
      { n: 1042, minor: 9600, payerEmail: BUYER_A, shipment: "delivered" },
    ]);

  const beat5 = async () => {
    await writeTicket(db, ticketOf("TKT-1037", BEAT5_PAYER, 1));
    const world = sandboxWith([
      { n: 1037, minor: 24000, payerEmail: BEAT5_PAYER, shipment: "delivered" },
    ]);
    return decisionEntry(world, refund(1037, "240.00", "TKT-1037", "damaged"));
  };

  const shipmentPair = (pairs: ClaimPair[]) => {
    const pair = pairs.find((each) => each.check === "shipment.status");
    if (!pair) throw new Error("no shipment pair");
    return pair;
  };

  describe("the checks that decided", () => {
    it("are a matched rule's require plus shipment.status when its when tests it, in trace order", async () => {
      await writeTicket(db, ticketOf("TKT-3001", BUYER_A, 0));
      const decision = await decisionEntry(beat3World(), refund(1042, "96.00", "TKT-3001"));
      expect(decision.matchedRules).toEqual(["refund-delivered-claim"]);
      expect(checksThatDecided(decision, mandates).map((entry) => entry.verifier)).toEqual([
        "capture.refundable",
        "ticket.from_payer",
        "shipment.status",
      ]);
    });

    it("leave shipment.status out when the matched rule's when doesn't test it", async () => {
      const decision = await beat5();
      expect(decision.matchedRules).toEqual(["refund-damaged"]);
      expect(checksThatDecided(decision, mandates).map((entry) => entry.verifier)).toEqual([
        "capture.refundable",
        "ticket.from_payer",
        "evidence.photo_present",
        "ledger.not_duplicate",
      ]);
    });

    it("are the facts the action's rules test in when, when no rule matched", async () => {
      await writeTicket(db, ticketOf("TKT-1050", BUYER_A, 0));
      const world = sandboxWith([
        { n: 1050, minor: 2000, payerEmail: BUYER_A, shipment: "in_transit" },
      ]);
      const decision = await decisionEntry(world, refund(1050, "20.00", "TKT-1050"));
      expect(decision.matchedRules).toEqual([]);
      expect(checksThatDecided(decision, mandates).map((entry) => entry.verifier)).toEqual([
        "shipment.status",
      ]);
      const pairs = await pairsFor(decision, "KIK-1050");
      expect(pairs.map((pair) => [pair.check, pair.verdict])).toEqual([
        ["shipment.status", "contradicts"],
        ["message", "not_used"],
      ]);
    });

    it("are the whole trace when the gate doesn't hold the decision's mandate", async () => {
      const decision = await beat5();
      expect(checksThatDecided(decision, [])).toEqual(decision.trace);
      const pairs = await pairsFor(decision, "KIK-1037", []);
      expect(pairs.map((pair) => pair.check)).toEqual([
        ...decision.trace.map((entry) => entry.verifier),
        "message",
      ]);
    });
  });

  describe("the beats", () => {
    it("reads beat 3's KIK-1039 as buyer A's sender against buyer B's payment, Contradicts", async () => {
      await writeTicket(db, ticketOf("TKT-3001", BUYER_A, 0));
      const decision = await decisionEntry(beat3World(), refund(1039, null, "TKT-3001"));
      const pairs = await pairsFor(decision, "KIK-1039");
      const sender = pairs.find((pair) => pair.check === "ticket.from_payer");
      expect(sender).toEqual({
        check: "ticket.from_payer",
        claim: { text: `Sent from ${BUYER_A}`, quote: null, simulated: false },
        record: {
          words: "Sender paid for the order",
          detail: `Sender ${BUYER_A}, payer ${BUYER_B}`,
          value: null,
          sources: [
            { words: "PayPal order", call: "GET /v2/checkout/orders/{id}", id: "ORD-1039" },
            { words: "Ticket store", call: "ticket", id: "TKT-3001" },
          ],
        },
        verdict: "contradicts",
      });
      expect(shipmentPair(pairs)).toMatchObject({
        claim: { text: "Says the parcel never arrived" },
        record: { words: "Carrier status", value: "stalled_10d" },
        verdict: "matches",
      });
      expect(pairs.find((pair) => pair.check === "capture.refundable")?.claim?.text).toBe(
        "Asks for Refund $62.00 on KIK-1039",
      );
    });

    it("reads beat 3's KIK-1042 as a never-arrived claim against a delivered parcel, Contradicts", async () => {
      await writeTicket(db, ticketOf("TKT-3001", BUYER_A, 0));
      const decision = await decisionEntry(beat3World(), refund(1042, "96.00", "TKT-3001"));
      const pairs = await pairsFor(decision, "KIK-1042");
      const shipment = shipmentPair(pairs);
      expect(shipment.claim).toEqual({
        text: "Says the parcel never arrived",
        quote: null,
        simulated: false,
      });
      expect(shipment.record.words).toBe("Carrier status");
      expect(shipment.record.value).toBe("delivered");
      expect(shipment.record.sources.map((source) => source.words)).toContain(
        "Carrier (simulated)",
      );
      expect(shipment.verdict).toBe("contradicts");
      expect(pairs.find((pair) => pair.check === "ticket.from_payer")?.verdict).toBe("matches");
    });

    it("reads beat 4 as a never-arrived claim against a parcel stalled 10 days, Matches", async () => {
      await writeTicket(db, ticketOf("TKT-1035", BEAT4_PAYER, 0));
      const world = sandboxWith([
        { n: 1035, minor: 1800, payerEmail: BEAT4_PAYER, shipment: "stalled_10d" },
      ]);
      const decision = await decisionEntry(world, refund(1035, "18.00", "TKT-1035"));
      expect(decision.matchedRules).toEqual(["refund-lost-parcel"]);
      const pairs = await pairsFor(decision, "KIK-1035");
      expect(pairs.map((pair) => [pair.check, pair.verdict])).toEqual([
        ["capture.refundable", "matches"],
        ["ticket.from_payer", "matches"],
        ["dispute.none_open", "passes"],
        ["shipment.status", "matches"],
        ["ledger.not_duplicate", "passes"],
        ["message", "not_used"],
      ]);
      expect(shipmentPair(pairs)).toMatchObject({
        claim: { text: "Says the parcel never arrived" },
        record: { value: "stalled_10d" },
      });
      expect(pairs.find((pair) => pair.check === "dispute.none_open")?.claim).toBeNull();
    });

    it("reads beat 5's photo and capture as Matches", async () => {
      const decision = await beat5();
      const pairs = await pairsFor(decision, "KIK-1037");
      expect(pairs.map((pair) => [pair.check, pair.claim?.text ?? null, pair.verdict])).toEqual([
        ["capture.refundable", "Asks for Refund $240.00 on KIK-1037", "matches"],
        ["ticket.from_payer", `Sent from ${BEAT5_PAYER}`, "matches"],
        ["evidence.photo_present", "1 photo attached", "matches"],
        ["ledger.not_duplicate", null, "passes"],
        ["message", "About my order (TKT-1037)", "not_used"],
      ]);
      const capture = pairs[0];
      expect(capture?.record.words).toBe("Payment can be refunded");
      expect(capture?.record.sources).toEqual([
        { words: "PayPal capture", call: "GET /v2/payments/captures/{id}", id: "CAP-1037" },
      ]);
    });

    it("leaves the order number off the capture claim when it isn't known", async () => {
      const decision = await beat5();
      const pairs = await pairsFor(decision, null);
      expect(pairs[0]?.claim?.text).toBe("Asks for Refund $240.00");
    });
  });

  describe("the message pair", () => {
    it("comes last, marked simulated, with the fixed record line, sourced to the mandate, Not used", async () => {
      const decision = await beat5();
      const pairs = await pairsFor(decision, "KIK-1037");
      expect(pairs.at(-1)).toEqual({
        check: "message",
        claim: {
          text: "About my order (TKT-1037)",
          quote: LONG_BODY.slice(0, 280),
          simulated: true,
        },
        record: {
          words: MESSAGE_RECORD,
          detail: "Mandate kikapu-studio version 3",
          value: null,
          sources: [{ words: "Mandate", call: "mandate.version", id: "kikapu-studio@v3" }],
        },
        verdict: "not_used",
      });
    });

    it("isn't marked simulated when the ticket isn't", async () => {
      const decision = await beat5();
      const ticket = await readTicket(db, "TKT-1037");
      if (!ticket) throw new Error("no ticket");
      const pairs = claimsVsRecords(decision, {
        ticket: { ...ticket, simulated: false },
        orderNumber: "KIK-1037",
        mandates,
      });
      expect(pairs.at(-1)?.claim?.simulated).toBe(false);
    });

    it("gives a decision with no intent the one couldn't-read pair", async () => {
      const world = sandboxWith([]);
      const raw = { tool: "drop_tables", args: { note: "x".repeat(400) } };
      const decision = await decisionEntry(world, raw);
      expect(decision.intent).toBeNull();
      const pairs = await pairsFor(decision, null);
      expect(pairs).toEqual([
        {
          check: "proposal",
          claim: {
            text: UNREADABLE_PROPOSAL_CLAIM,
            quote: JSON.stringify(raw).slice(0, 280),
            simulated: false,
          },
          record: { words: NO_RECORDS_READ, detail: "", value: null, sources: [] },
          verdict: "not_used",
        },
      ]);
    });
  });

  describe("missing tickets", () => {
    it("says a ticket ID the store lacks isn't in the ticket store, No record, and adds no message pair", async () => {
      const world = sandboxWith([
        { n: 1037, minor: 24000, payerEmail: BEAT5_PAYER, shipment: "delivered" },
      ]);
      const decision = await decisionEntry(world, refund(1037, "240.00", "TKT-9999", "damaged"));
      const pairs = await pairsFor(decision, "KIK-1037");
      const byCheck = (check: string) => pairs.find((pair) => pair.check === check);
      expect(byCheck("ticket.from_payer")?.claim?.text).toBe(
        "Ticket TKT-9999 isn't in the ticket store",
      );
      expect(byCheck("ticket.from_payer")?.verdict).toBe("no_record");
      expect(byCheck("evidence.photo_present")?.claim?.text).toBe(
        "Ticket TKT-9999 isn't in the ticket store",
      );
      expect(byCheck("evidence.photo_present")?.verdict).toBe("no_record");
      expect(pairs.some((pair) => pair.check === "message")).toBe(false);
    });

    it("says No ticket named when the intent names none", async () => {
      const decision = await beat5();
      const intent = decision.intent;
      if (!intent) throw new Error("no intent");
      const pairs = claimsVsRecords(
        { ...decision, intent: { ...intent, ticketId: null } },
        { ticket: null, orderNumber: "KIK-1037", mandates },
      );
      expect(pairs.find((pair) => pair.check === "ticket.from_payer")?.claim?.text).toBe(
        "No ticket named",
      );
      expect(pairs.some((pair) => pair.check === "message")).toBe(false);
    });

    it("counts photos and says when there are none", async () => {
      const decision = await beat5();
      const ticket = await readTicket(db, "TKT-1037");
      if (!ticket) throw new Error("no ticket");
      const photoClaim = (images: Ticket["attachments"]) =>
        claimsVsRecords(decision, {
          ticket: { ...ticket, attachments: images },
          orderNumber: null,
          mandates,
        }).find((pair) => pair.check === "evidence.photo_present")?.claim?.text;
      const image = (id: string) => ({ id, contentType: "image/png" });
      expect(photoClaim([])).toBe("No photo attached");
      expect(photoClaim([{ id: "A", contentType: "application/pdf" }])).toBe("No photo attached");
      expect(photoClaim([image("A"), image("B")])).toBe("2 photos attached");
    });
  });

  describe("verdicts", () => {
    const shipmentCases: [string | null, (typeof SHIPMENT_STATUSES)[number], string][] = [
      ["not_received", "lost", "matches"],
      ["not_received", "stalled_10d", "matches"],
      ["not_received", "delivered", "contradicts"],
      ["not_received", "in_transit", "contradicts"],
      ["damaged", "delivered", "matches"],
      ["damaged", "lost", "contradicts"],
      ["damaged", "stalled_10d", "contradicts"],
      ["damaged", "in_transit", "contradicts"],
      ["wrong_item", "delivered", "matches"],
      ["wrong_item", "lost", "contradicts"],
      ["wrong_item", "stalled_10d", "contradicts"],
      ["wrong_item", "in_transit", "contradicts"],
      [null, "delivered", "passes"],
      [null, "lost", "passes"],
    ];

    it("covers every claim and status in the shipment table", () => {
      for (const claim of CLAIMS) {
        for (const status of SHIPMENT_STATUSES) {
          expect(shipmentCases.some(([c, s]) => c === claim && s === status)).toBe(true);
        }
      }
    });

    const shipmentEntry = (
      result: TraceEntry["result"],
      value?: (typeof SHIPMENT_STATUSES)[number],
    ): TraceEntry => ({
      verifier: "shipment.status",
      result,
      records: [{ call: "carrier GET /shipments/{tracking_number}", id: "TRK1037" }],
      detail: "Carrier reading",
      ...(value === undefined ? {} : { value }),
    });

    // Beat 5's decision with its claim and shipment.status entry replaced, read with the whole
    // trace so the shipment pair is always there.
    const readShipment = async (claim: string | null, entry: TraceEntry) => {
      const decision = await beat5();
      const intent = decision.intent;
      if (!intent) throw new Error("no intent");
      const changed: ClaimsDecision = {
        ...decision,
        intent: { ...intent, claim: claim as typeof intent.claim },
        trace: decision.trace.map((each) => (each.verifier === "shipment.status" ? entry : each)),
      };
      return shipmentPair(await pairsFor(changed, "KIK-1037", []));
    };

    it.each(shipmentCases)("a %s claim against %s is %s", async (claim, status, verdict) => {
      const pair = await readShipment(claim, shipmentEntry("pass", status));
      expect(pair.verdict).toBe(verdict);
      expect(pair.claim).toEqual(
        claim === null
          ? null
          : {
              text: {
                not_received: "Says the parcel never arrived",
                damaged: "Says the item arrived damaged",
                wrong_item: "Says they got the wrong item",
              }[claim],
              quote: null,
              simulated: false,
            },
      );
    });

    it("reads an unknown shipment check as No record, whatever the claim", async () => {
      for (const claim of [...CLAIMS, null]) {
        const pair = await readShipment(claim, shipmentEntry("unknown"));
        expect(pair.verdict).toBe("no_record");
      }
    });

    it("never reads a pass with no status as Matches", async () => {
      const pair = await readShipment("not_received", shipmentEntry("pass"));
      expect(pair.verdict).toBe("no_record");
    });

    it("reads any other verifier as Passes, Fails or No record, with no claim side", async () => {
      const decision = await beat5();
      const other = (result: TraceEntry["result"], id: string | null): TraceEntry => ({
        verifier: "mpesa.receipt_verified",
        result,
        records: [{ call: "mpesa receipt", id }],
        detail: "Receipt reading",
      });
      const read = (entry: TraceEntry) =>
        claimsVsRecords(
          { ...decision, trace: [entry] },
          { ticket: null, orderNumber: null, mandates: [] },
        )[0];
      expect(read(other("pass", "R1"))).toEqual({
        check: "mpesa.receipt_verified",
        claim: null,
        record: {
          words: "M-Pesa receipt confirmed",
          detail: "Receipt reading",
          value: null,
          sources: [{ words: "mpesa receipt", call: "mpesa receipt", id: "R1" }],
        },
        verdict: "passes",
      });
      expect(read(other("fail", "R1"))?.verdict).toBe("fails");
      expect(read(other("unknown", null))?.verdict).toBe("no_record");
      expect(read(other("unknown", null))?.record.sources[0]?.id).toBe("none");
    });

    it("reads an unknown check with a claim as No record, never Matches", async () => {
      const decision = await beat5();
      const trace = decision.trace.map((entry) =>
        entry.verifier === "ticket.from_payer" || entry.verifier === "capture.refundable"
          ? { ...entry, result: "unknown" as const }
          : entry,
      );
      const pairs = await pairsFor({ ...decision, trace }, "KIK-1037");
      expect(pairs.find((pair) => pair.check === "ticket.from_payer")?.verdict).toBe("no_record");
      expect(pairs.find((pair) => pair.check === "capture.refundable")?.verdict).toBe("no_record");
    });
  });

  it("has words for every verifier", () => {
    expect(Object.keys(VERIFIER_WORDS).sort()).toEqual([...VERIFIERS].sort());
    for (const verifier of VERIFIERS) expect(VERIFIER_WORDS[verifier]).toMatch(/\S/);
  });
});

// The decision path never imports the claims module (ADR 0034).
describe("claims vs records stays out of the decision path", () => {
  const gateSrc = fileURLToPath(new URL("../src/", import.meta.url));
  const packagesDir = fileURLToPath(new URL("../../../packages/", import.meta.url));
  const importSpecifier = /(?:from\s+|import\s*\(\s*|require\s*\(\s*|import\s+)["']([^"']+)["']/g;
  const importsOf = (file: string) =>
    [...readFileSync(file, "utf8").matchAll(importSpecifier)].map(([, specifier]) => specifier);
  const isClaims = (file: string, specifier: string) =>
    specifier.startsWith(".") &&
    resolve(dirname(file), specifier).replace(/\.ts$/, "") === join(gateSrc, "claims");

  // decide.ts and every gate module it reaches through relative imports.
  function reachedFrom(entry: string): string[] {
    const seen = new Set<string>();
    const queue = [entry];
    while (queue.length > 0) {
      const file = queue.pop();
      if (file === undefined || seen.has(file)) continue;
      seen.add(file);
      for (const specifier of importsOf(file)) {
        if (!specifier?.startsWith(".")) continue;
        queue.push(`${resolve(dirname(file), specifier).replace(/\.ts$/, "")}.ts`);
      }
    }
    return [...seen];
  }

  it("decide and the modules it imports don't import it", () => {
    const files = reachedFrom(join(gateSrc, "decide.ts"));
    expect(files.length).toBeGreaterThan(1);
    const hits = files.flatMap((file) =>
      importsOf(file)
        .filter((specifier) => specifier !== undefined && isClaims(file, specifier))
        .map((specifier) => `${file}: ${specifier}`),
    );
    expect(hits).toEqual([]);
  });

  it.each(["verifiers", "mandate"])("@countersign/%s doesn't import it", (name) => {
    const dir = join(packagesDir, name, "src");
    const hits: string[] = [];
    for (const file of readdirSync(dir, { recursive: true, encoding: "utf8" })) {
      if (!/\.[cm]?[jt]sx?$/.test(file)) continue;
      for (const specifier of importsOf(join(dir, file))) {
        if (specifier && /claims|@countersign\/gate|apps\/gate/.test(specifier)) {
          hits.push(`${file}: ${specifier}`);
        }
      }
    }
    expect(hits).toEqual([]);
  });

  it("would catch decide importing it", () => {
    expect(isClaims(join(gateSrc, "decide.ts"), "./claims")).toBe(true);
  });
});
