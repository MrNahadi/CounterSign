import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createMemoryShipmentStore, createMockCarrier } from "@countersign/carrier-mock";
import { parseMandate } from "@countersign/mandate";
import {
  createPayPalClient,
  type FetchLike,
  PayPalError,
  type PayPalOrder,
} from "@countersign/rail-paypal";
import { CALLS, type TicketSnapshot } from "@countersign/verifiers";
import { describe, expect, it } from "vitest";
import { decide } from "../src/decide";
import { readLiveRecords } from "../src/live-records";
import { createFakeSandbox, httpError } from "./fake-sandbox";

// Illustrative IDs in PayPal's sandbox shapes.
const CAPTURE = "2GG279541U471931P";
const ORDER = "5O190127TN364715T";
const TRACKING = "TRK1035";
const PAYER = "amina.k@example.com";

const mandateFile = fileURLToPath(
  new URL("../../../packages/mandate/fixtures/kikapu-studio-v3.json", import.meta.url),
);
const parsedMandate = parseMandate(JSON.parse(readFileSync(mandateFile, "utf8")));
if (!parsedMandate.ok) throw new Error(parsedMandate.error);
const mandate = parsedMandate.mandate;

const ticket: TicketSnapshot = {
  call: CALLS.ticket,
  id: "TKT-1035",
  senderEmail: PAYER,
  attachments: [],
};

const usd = (minor: number) => ({ minor, currency: "USD" as const });

const shipment = (trackingNumber: string, status: string) => ({
  trackingNumber,
  carrierName: "Illustrative Post",
  status,
  scanEvents: [{ at: "2026-10-02T08:00:00Z", description: "Accepted", place: "Nairobi" }],
  updatedAt: "2026-10-05T08:00:00Z",
});

// KIK-1035: an $18.00 capture whose parcel stalled more than ten days ago.
function stalledParcel() {
  const rail = createFakeSandbox();
  rail.captures.set(CAPTURE, {
    id: CAPTURE,
    status: "COMPLETED",
    amount: usd(1800),
    orderId: ORDER,
  });
  rail.orders.set(ORDER, {
    id: ORDER,
    status: "COMPLETED",
    payerEmail: PAYER,
    payerId: "PAYERFAKE01",
    purchaseUnits: [
      {
        referenceId: "KIK-1035",
        customId: null,
        invoiceId: null,
        amount: usd(1800),
        captures: [{ id: CAPTURE, status: "COMPLETED", amount: usd(1800), orderId: ORDER }],
        trackers: [
          {
            id: `${CAPTURE}-${TRACKING}`,
            captureId: CAPTURE,
            trackingNumber: TRACKING,
            status: "SHIPPED",
          },
        ],
        refunds: [],
      },
    ],
  });
  rail.disputes.set(CAPTURE, { disputes: [], complete: true });
  const shipments = new Map<string, unknown>([[TRACKING, shipment(TRACKING, "stalled_10d")]]);
  const looked: string[] = [];
  const mock = createMockCarrier(createMemoryShipmentStore(shipments));
  const carrier = {
    getShipment(trackingNumber: string) {
      looked.push(trackingNumber);
      return mock.getShipment(trackingNumber);
    },
  };
  return { rail, carrier, shipments, looked };
}

const beat4Proposal = {
  tool: "create_refund",
  args: {
    capture_id: CAPTURE,
    amount: { value: "18.00", currency_code: "USD" },
    note_to_payer: "Sorry your parcel stalled.",
  },
  justification: { ticket_id: "TKT-1035", claim: "not_received" },
};

function unit(order: PayPalOrder) {
  const first = order.purchaseUnits[0];
  if (!first) throw new Error("No purchase unit");
  return first;
}

function orderOf(rail: ReturnType<typeof stalledParcel>["rail"]) {
  const order = rail.orders.get(ORDER);
  if (!order) throw new Error("No order");
  return order;
}

describe("reading live records", () => {
  it("maps a stalled-parcel order into snapshots that let the beat 4 proposal pass every verifier", async () => {
    const { rail, carrier } = stalledParcel();
    const { records, problems } = await readLiveRecords({
      captureId: CAPTURE,
      ticket,
      rail,
      carrier,
    });

    expect(problems).toEqual([]);
    expect(records.captures).toEqual([
      {
        call: CALLS.capture,
        id: CAPTURE,
        orderId: ORDER,
        status: "COMPLETED",
        amount: usd(1800),
        refundedMinor: 0,
      },
    ]);
    expect(records.orders).toEqual([
      {
        call: CALLS.order,
        id: ORDER,
        payerEmail: PAYER,
        trackers: [{ id: `${CAPTURE}-${TRACKING}`, trackingNumber: TRACKING, status: "SHIPPED" }],
      },
    ]);
    expect(records.disputes).toEqual([{ call: CALLS.disputes, id: CAPTURE, disputes: [] }]);
    expect(records.shipments).toEqual([
      { call: CALLS.carrier, id: TRACKING, status: "stalled_10d" },
    ]);
    expect(records.ticket).toEqual(ticket);
    expect(rail.calls.map((call) => call.call)).toEqual(["getCapture", "getOrder", "listDisputes"]);

    const { record } = decide({
      mandate,
      principal: "support-agent",
      proposal: beat4Proposal,
      records: { ...records, executions: [] },
      now: new Date("2026-10-17T09:00:00+03:00"),
    });
    expect(record.reasons).toEqual([]);
    expect(record.decision).toBe("allow");
    expect(record.matchedRules).toEqual(["refund-lost-parcel"]);
    // Every verifier the rule requires, and the shipment status its `when` reads, pass on these.
    const results = Object.fromEntries(record.trace.map((entry) => [entry.verifier, entry.result]));
    expect(results).toMatchObject({
      "ticket.from_payer": "pass",
      "capture.refundable": "pass",
      "dispute.none_open": "pass",
      "ledger.not_duplicate": "pass",
      "shipment.status": "pass",
    });
  });

  it("takes the refunded total from the order's completed and pending refunds", async () => {
    const { rail, carrier } = stalledParcel();
    const refund = (id: string, status: "COMPLETED" | "PENDING" | "FAILED", minor: number) => ({
      id,
      status,
      amount: usd(minor),
      captureId: CAPTURE,
    });
    unit(orderOf(rail)).refunds = [
      refund("R1", "COMPLETED", 300),
      refund("R2", "PENDING", 200),
      refund("R3", "FAILED", 900),
    ];
    const { records, problems } = await readLiveRecords({
      captureId: CAPTURE,
      ticket,
      rail,
      carrier,
    });
    expect(problems).toEqual([]);
    expect(records.captures?.[0]?.refundedMinor).toBe(500);
  });

  it("leaves the capture out when the refunded total is unknown", async () => {
    const { rail, carrier } = stalledParcel();
    const order = unit(orderOf(rail));
    order.captures.push({
      id: "9XX00000000000000",
      status: "COMPLETED",
      amount: usd(500),
      orderId: ORDER,
    });
    order.refunds = [{ id: "R1", status: "COMPLETED", amount: usd(300), captureId: null }];
    const { records, problems } = await readLiveRecords({
      captureId: CAPTURE,
      ticket,
      rail,
      carrier,
    });
    expect(records.captures).toBeUndefined();
    expect(records.orders).toHaveLength(1);
    expect(records.disputes).toHaveLength(1);
    expect(records.shipments).toHaveLength(1);
    expect(problems).toEqual([{ call: "get-order", message: expect.stringContaining("unknown") }]);
  });
});

describe("failed reads", () => {
  it("leaves the capture out on a capture 404, with one problem naming the call", async () => {
    const { rail, carrier } = stalledParcel();
    rail.captures.clear();
    const { records, problems } = await readLiveRecords({
      captureId: CAPTURE,
      ticket,
      rail,
      carrier,
    });
    expect(records.captures).toBeUndefined();
    expect(records.disputes).toHaveLength(1);
    expect(records.ticket).toEqual(ticket);
    expect(problems).toHaveLength(1);
    expect(problems[0]?.call).toBe("get-capture");
    expect(problems[0]?.message).toContain("HTTP 404");
  });

  it("leaves the order, its capture and its shipment out on an order 500", async () => {
    const { rail, carrier, looked } = stalledParcel();
    rail.failures.getOrder = httpError("get-order", 500, "INTERNAL_SERVER_ERROR");
    const { records, problems } = await readLiveRecords({
      captureId: CAPTURE,
      ticket,
      rail,
      carrier,
    });
    expect(records.orders).toBeUndefined();
    expect(records.captures).toBeUndefined();
    expect(records.shipments).toBeUndefined();
    expect(records.disputes).toHaveLength(1);
    expect(looked).toEqual([]);
    expect(problems).toEqual([{ call: "get-order", message: expect.stringContaining("HTTP 500") }]);
  });

  it("leaves the disputes out when the list isn't complete", async () => {
    const { rail, carrier } = stalledParcel();
    rail.disputes.set(CAPTURE, { disputes: [{ id: "PP-D-1", status: "OPEN" }], complete: false });
    const { records, problems } = await readLiveRecords({
      captureId: CAPTURE,
      ticket,
      rail,
      carrier,
    });
    expect(records.disputes).toBeUndefined();
    expect(records.captures).toHaveLength(1);
    expect(records.shipments).toHaveLength(1);
    expect(problems).toEqual([{ call: "list-disputes", message: expect.any(String) }]);
  });

  it("leaves the disputes out when the list can't be read", async () => {
    const { rail, carrier } = stalledParcel();
    rail.failures.listDisputes = new PayPalError({
      kind: "network",
      call: "list-disputes",
      status: null,
    });
    const { records, problems } = await readLiveRecords({
      captureId: CAPTURE,
      ticket,
      rail,
      carrier,
    });
    expect(records.disputes).toBeUndefined();
    expect(problems.map((problem) => problem.call)).toEqual(["list-disputes"]);
  });

  it.each([
    ["not found", undefined],
    ["unreadable", { trackingNumber: TRACKING, status: "teleported" }],
  ])("leaves the shipment out when it's %s", async (_name, stored) => {
    const { rail, carrier, shipments } = stalledParcel();
    if (stored === undefined) shipments.delete(TRACKING);
    else shipments.set(TRACKING, stored);
    const { records, problems } = await readLiveRecords({
      captureId: CAPTURE,
      ticket,
      rail,
      carrier,
    });
    expect(records.shipments).toBeUndefined();
    expect(records.captures).toHaveLength(1);
    expect(records.orders).toHaveLength(1);
    expect(records.disputes).toHaveLength(1);
    expect(problems).toHaveLength(1);
    expect(problems[0]?.call).toBe("carrier-shipment");
    expect(problems[0]?.message).toContain(TRACKING);
  });

  it("never throws, even when the carrier and the rail throw something unexpected", async () => {
    const { rail } = stalledParcel();
    rail.failures.listDisputes = new Error("postgres://user:hunter2@db/countersign");
    const carrier = {
      async getShipment(): Promise<never> {
        throw new Error("postgres://user:hunter2@db/countersign");
      },
    };
    const { records, problems } = await readLiveRecords({
      captureId: CAPTURE,
      ticket,
      rail,
      carrier,
    });
    expect(records.shipments).toBeUndefined();
    expect(records.disputes).toBeUndefined();
    expect(problems.map((problem) => problem.call)).toEqual(["list-disputes", "carrier-shipment"]);
    expect(JSON.stringify(problems)).not.toContain("hunter2");
  });
});

describe("carrier lookups", () => {
  it("looks up only SHIPPED trackers for the intent's capture", async () => {
    const { rail, carrier, shipments, looked } = stalledParcel();
    unit(orderOf(rail)).trackers.push(
      {
        id: `${CAPTURE}-TRKCANCELLED`,
        captureId: CAPTURE,
        trackingNumber: "TRKCANCELLED",
        status: "CANCELLED",
      },
      {
        id: "8YY00000000000000-TRKOTHER",
        captureId: "8YY00000000000000",
        trackingNumber: "TRKOTHER",
        status: "SHIPPED",
      },
    );
    shipments.set("TRKCANCELLED", shipment("TRKCANCELLED", "delivered"));
    shipments.set("TRKOTHER", shipment("TRKOTHER", "delivered"));
    const { records, problems } = await readLiveRecords({
      captureId: CAPTURE,
      ticket,
      rail,
      carrier,
    });
    expect(looked).toEqual([TRACKING]);
    expect(records.shipments).toEqual([
      { call: CALLS.carrier, id: TRACKING, status: "stalled_10d" },
    ]);
    expect(problems).toEqual([]);
  });
});

describe("secrets", () => {
  const SECRET = "fake-client-secret-do-not-leak";
  const TOKEN = "A21AAFAKE-ACCESS-TOKEN-FOR-TESTS-ONLY";
  const env = {
    PAYPAL_BASE_URL: "https://api-m.sandbox.paypal.com",
    PAYPAL_CLIENT_ID: "fake-client-id-for-tests",
    PAYPAL_CLIENT_SECRET: SECRET,
  };
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

  it("no read problem holds a secret, even when PayPal echoes one back", async () => {
    const basic = Buffer.from(`${env.PAYPAL_CLIENT_ID}:${SECRET}`).toString("base64");
    const echo = {
      name: "INVALID_REQUEST",
      message: `Bad ${SECRET} ${TOKEN} ${basic}`,
      debug_id: TOKEN,
    };
    const fetch: FetchLike = async (url) => {
      if (url.endsWith("/v1/oauth2/token"))
        return json(200, { access_token: TOKEN, expires_in: 32400 });
      return json(400, echo);
    };
    const rail = createPayPalClient({ env, fetch, sleep: async () => {}, now: () => 0 });
    const carrier = createMockCarrier(createMemoryShipmentStore());
    const { problems } = await readLiveRecords({ captureId: CAPTURE, ticket, rail, carrier });
    expect(problems.map((problem) => problem.call)).toEqual(["get-capture", "list-disputes"]);
    const text = JSON.stringify(problems);
    for (const secret of [SECRET, TOKEN, basic]) expect(text).not.toContain(secret);
  });
});
