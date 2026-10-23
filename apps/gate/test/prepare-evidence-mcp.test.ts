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
  readEvidenceDocument,
  sha256Hex,
  sql,
  writeEvidenceDocument,
} from "@countersign/db";
import { parseMandate } from "@countersign/mandate";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { AgentResponseSchema } from "../src/decide";
import { PREPARE_MESSAGES } from "../src/prepare-evidence";
import { propose } from "../src/propose";
import { createFakeSandbox } from "./fake-sandbox";

// prepare_dispute_evidence and provide_dispute_evidence with documents (ADR 0035), through the
// gate's MCP endpoint over real HTTP with a made-up principal key, and through propose(). Beat
// 5's KIK-1037 is delivered and tracked, then disputed. Illustrative people and orders.

const SLOW = 120_000;
const KEY = "test-support-agent-key-0123456789abcdef";
const ENV = { COUNTERSIGN_SUPPORT_AGENT_KEY: KEY };
const PAYER = "wanjiru.m@example.com";
const DISPUTE = "PP-D-1037";
const OTHER_DISPUTE = "PP-D-1040";

const mandateFile = fileURLToPath(
  new URL("../../../packages/mandate/fixtures/kikapu-studio-v3.json", import.meta.url),
);
const parsedMandate = parseMandate(JSON.parse(readFileSync(mandateFile, "utf8")));
if (!parsedMandate.ok) throw new Error(parsedMandate.error);
const mandate = parsedMandate.mandate;

const usd = (minor: number) => ({ minor, currency: "USD" as const });

function world() {
  const rail = createFakeSandbox();
  const captureId = "CAP-1037";
  const capture = { id: captureId, status: "COMPLETED", amount: usd(24000), orderId: "ORD-1037" };
  rail.captures.set(captureId, { ...capture, createTime: "2026-10-01T08:00:05Z" });
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
  for (const id of [DISPUTE, OTHER_DISPUTE]) {
    rail.disputeDetails.set(id, {
      id,
      status: "WAITING_FOR_SELLER_RESPONSE",
      amount: usd(24000),
      captureIds: [captureId],
      reason: "MERCHANDISE_OR_SERVICE_NOT_RECEIVED",
      lifeCycleStage: "CHARGEBACK",
      sellerResponseDueDate: "2026-11-01T23:59:59Z",
    });
  }
  rail.disputeDetails.set("PP-D-9999", {
    id: "PP-D-9999",
    status: "WAITING_FOR_SELLER_RESPONSE",
    amount: usd(1000),
    captureIds: ["CAP-NOT-OURS"],
  });
  const shipments = new Map<string, unknown>([
    [
      "TRK1037",
      {
        trackingNumber: "TRK1037",
        carrierName: "Illustrative Post",
        status: "delivered",
        scanEvents: [
          { at: "2026-10-02T08:00:00Z", description: "Accepted", place: "Nairobi" },
          { at: "2026-10-04T15:30:00Z", description: "Delivered to recipient", place: "Mombasa" },
        ],
        updatedAt: "2026-10-05T08:00:00Z",
      },
    ],
  ]);
  return { rail, carrier: createMockCarrier(createMemoryShipmentStore(shipments)) };
}

let servers: Server[] = [];
let clients: Client[] = [];

afterEach(async () => {
  for (const client of clients) await client.close().catch(() => {});
  for (const server of servers) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  servers = [];
  clients = [];
});

describe("prepare_dispute_evidence and provide_dispute_evidence over MCP", {
  timeout: SLOW,
}, () => {
  let handle: DatabaseHandle;
  let db: Database;
  // The gate's clock, moved by a test to build a second pack.
  let now = new Date("2026-10-22T10:00:00Z");

  beforeAll(async () => {
    handle = await createTestDatabase();
    db = handle.db;
  }, SLOW);

  beforeEach(async () => {
    await db.execute(sql`TRUNCATE audit_log, tickets, evidence_documents`);
    now = new Date("2026-10-22T10:00:00Z");
  });

  afterAll(async () => {
    await handle.close();
  });

  async function gate(w: ReturnType<typeof world>): Promise<Client> {
    const app = createApp({
      db,
      rail: () => w.rail,
      carrier: w.carrier,
      env: ENV,
      clock: () => now,
    });
    const server = app.listen(0, "127.0.0.1");
    servers.push(server);
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const { port } = server.address() as AddressInfo;
    const client = new Client({ name: "test-agent", version: "0.0.0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
        requestInit: { headers: { Authorization: `Bearer ${KEY}` } },
      }),
    );
    clients.push(client);
    return client;
  }

  type Prepared = {
    documents: { id: string; kind: string; name: string; size: number; sha256: string }[];
    suggested: { evidence_type: string; tracking_numbers: string[]; refund_ids: string[] }[];
    [key: string]: unknown;
  };

  async function prepare(client: Client, disputeId = DISPUTE): Promise<Prepared> {
    const result = await client.callTool({
      name: "prepare_dispute_evidence",
      arguments: { dispute_id: disputeId },
    });
    expect(result.isError).toBe(false);
    const text = (result.content as { text: string }[])[0]?.text ?? "";
    expect(JSON.parse(text)).toEqual(result.structuredContent);
    return result.structuredContent as Prepared;
  }

  async function errorOf(client: Client, args: Record<string, unknown>): Promise<string> {
    const result = await client.callTool({ name: "prepare_dispute_evidence", arguments: args });
    expect(result.isError).toBe(true);
    const content = result.content as { type: string; text: string }[];
    expect(content).toHaveLength(1);
    return content[0]?.text ?? "";
  }

  async function provide(client: Client, args: Record<string, unknown>) {
    const result = await client.callTool({ name: "provide_dispute_evidence", arguments: args });
    expect(result.isError).toBe(false);
    return AgentResponseSchema.parse(result.structuredContent);
  }

  const evidenceArgs = (documentIds: string[], notes = "Delivered on 4 October.") => ({
    dispute_id: DISPUTE,
    evidence: [
      { evidence_type: "PROOF_OF_FULFILLMENT", notes, tracking_numbers: ["TRK1037"] },
      { evidence_type: "PROOF_OF_REFUND", notes: "Refunded in part.", refund_ids: ["REF-1"] },
    ],
    document_ids: documentIds,
  });

  const decisions = async () =>
    (await db.select().from(auditLog).orderBy(asc(auditLog.seq)))
      .filter((row) => row.entryType === "decision")
      .map(
        (row) =>
          JSON.parse(row.payload).record as {
            intentHash: string | null;
            intentCanonical: string | null;
            decision: string;
            reasons: { code: string; detail: string }[];
          },
      );

  it("lists prepare_dispute_evidence as an extension taking dispute_id", async () => {
    const client = await gate(world());
    const { tools } = await client.listTools();
    const tool = tools.find((t) => t.name === "prepare_dispute_evidence");
    expect(tool?.description).toMatch(/^Countersign extension: /);
    expect(tool?.description).toContain("Moves no money");
    expect(tool?.inputSchema).toMatchObject({
      type: "object",
      additionalProperties: false,
      required: ["dispute_id"],
    });
    expect(Object.keys(tool?.inputSchema.properties ?? {})).toEqual(["dispute_id"]);
    const provideTool = tools.find((t) => t.name === "provide_dispute_evidence");
    expect(Object.keys(provideTool?.inputSchema.properties ?? {})).toContain("document_ids");
  });

  it("answers the masked facts, documents and suggested items in snake_case, and logs nothing", async () => {
    const w = world();
    const client = await gate(w);
    const answer = await prepare(client);

    expect(Object.keys(answer).sort()).toEqual(
      [
        "dispute",
        "capture",
        "order_number",
        "shipping",
        "refunds",
        "decisions",
        "audit",
        "not_available",
        "prepared_at",
        "documents",
        "suggested",
      ].sort(),
    );
    expect(answer.dispute).toMatchObject({
      id: DISPUTE,
      status: "WAITING_FOR_SELLER_RESPONSE",
      reason: "MERCHANDISE_OR_SERVICE_NOT_RECEIVED",
      life_cycle_stage: "CHARGEBACK",
      seller_response_due_date: "2026-11-01T23:59:59Z",
      amount: { minor: 24000, currency: "USD", display: "$240.00" },
    });
    expect(answer.capture).toMatchObject({ id: "CAP-1037", status: "COMPLETED" });
    expect(answer.shipping).toEqual([
      expect.objectContaining({
        tracking_number: "TRK1037",
        tracker_status: "SHIPPED",
        carrier: expect.objectContaining({
          status: "delivered",
          carrier_name: "Illustrative Post",
        }),
      }),
    ]);
    expect(answer.refunds).toEqual([]);
    expect(answer.decisions).toEqual([]);
    expect(answer.prepared_at).toBe("2026-10-22T10:00:00.000Z");

    // No decisions on the capture, so only the PDF is stored.
    expect(answer.documents).toHaveLength(1);
    const [pdf] = answer.documents;
    expect(pdf).toMatchObject({ kind: "pdf", name: `countersign-evidence-${DISPUTE}.pdf` });
    expect(Object.keys(pdf ?? {}).sort()).toEqual(["id", "kind", "name", "sha256", "size"]);
    const stored = await readEvidenceDocument(db, pdf?.id ?? "");
    expect(stored && sha256Hex(stored.bytes)).toBe(pdf?.sha256);
    expect(stored?.size).toBe(pdf?.size);

    expect(answer.suggested).toEqual([
      { evidence_type: "PROOF_OF_FULFILLMENT", tracking_numbers: ["TRK1037"], refund_ids: [] },
    ]);

    const text = JSON.stringify(answer);
    expect(text).not.toContain(PAYER);
    expect(text).not.toContain(KEY);
    // Every key is snake_case.
    expect(text).not.toMatch(/"[a-z]+[A-Z][A-Za-z]*":/);
    expect(await db.select().from(auditLog)).toEqual([]);
    const moving = ["refundCapture", "acceptClaim", "makeOffer", "provideEvidence"];
    expect(w.rail.calls.some((call) => moving.includes(call.call))).toBe(false);
  });

  it("gives each refund its time from PayPal, or null when PayPal gave none", async () => {
    const w = world();
    const refunds = w.rail.orders.get("ORD-1037")?.purchaseUnits[0]?.refunds;
    if (!refunds) throw new Error("no order");
    refunds.push(
      {
        id: "REF-1",
        status: "COMPLETED",
        amount: usd(5000),
        captureId: "CAP-1037",
        createTime: "2026-10-06T07:00:00Z",
      },
      {
        id: "REF-2",
        status: "PENDING",
        amount: usd(1000),
        captureId: "CAP-1037",
        createTime: null,
      },
    );
    const answer = await prepare(await gate(w));
    expect(answer.refunds).toEqual([
      {
        id: "REF-1",
        amount: { minor: 5000, currency: "USD", display: "$50.00" },
        status: "COMPLETED",
        time: "2026-10-06T07:00:00Z",
      },
      {
        id: "REF-2",
        amount: { minor: 1000, currency: "USD", display: "$10.00" },
        status: "PENDING",
        time: null,
      },
    ]);
  });

  it("answers one fixed sentence for an unreadable dispute, no capture, or bad arguments", async () => {
    const client = await gate(world());
    expect(await errorOf(client, { dispute_id: "PP-D-0000" })).toBe(
      PREPARE_MESSAGES.DISPUTE_UNREADABLE,
    );
    expect(await errorOf(client, { dispute_id: "PP-D-9999" })).toBe(PREPARE_MESSAGES.NO_CAPTURE);
    expect(await errorOf(client, { dispute_id: "PP D 1" })).toBe(PREPARE_MESSAGES.invalidArguments);
    expect(await errorOf(client, { dispute_id: DISPUTE, extra: 1 })).toBe(
      PREPARE_MESSAGES.invalidArguments,
    );
    expect(PREPARE_MESSAGES.STORE_FAILED).toBe("The evidence documents couldn't be stored.");
  });

  it("steps up provide_dispute_evidence with the PDF, and hashes the documents and refund IDs", async () => {
    const client = await gate(world());
    const { documents } = await prepare(client);
    const [pdf] = documents;
    if (pdf === undefined) throw new Error("no PDF");

    const response = await provide(client, evidenceArgs([pdf.id]));
    expect(response.decision).toBe("pending_approval");
    const [decision] = await decisions();
    expect(decision?.decision).toBe("step_up");
    expect(decision?.reasons.map((reason) => reason.code)).toEqual(["ALWAYS_NEEDS_APPROVAL"]);
    const hashed = JSON.parse(decision?.intentCanonical ?? "").params;
    expect(hashed).toEqual({
      evidence: [
        {
          evidenceType: "PROOF_OF_FULFILLMENT",
          notes: "Delivered on 4 October.",
          trackingNumbers: ["TRK1037"],
        },
        {
          evidenceType: "PROOF_OF_REFUND",
          notes: "Refunded in part.",
          trackingNumbers: null,
          refundIds: ["REF-1"],
        },
      ],
      documents: [{ id: pdf.id, name: pdf.name, sha256: pdf.sha256 }],
    });
  });

  it("changes the intent hash when a note or a document changes", async () => {
    const client = await gate(world());
    const first = (await prepare(client)).documents[0];
    now = new Date("2026-10-22T11:00:00Z");
    const second = (await prepare(client)).documents[0];
    if (first === undefined || second === undefined) throw new Error("no PDF");
    expect(second.id).not.toBe(first.id);
    expect(second.sha256).not.toBe(first.sha256);

    await provide(client, evidenceArgs([first.id]));
    await provide(client, evidenceArgs([first.id]));
    await provide(client, evidenceArgs([first.id], "Delivered on 4 October, signed for."));
    await provide(client, evidenceArgs([second.id]));
    const hashes = (await decisions()).map((decision) => decision.intentHash);
    expect(hashes.every((hash) => hash !== null)).toBe(true);
    expect(hashes[1]).toBe(hashes[0]);
    expect(new Set(hashes).size).toBe(3);
  });

  it("denies a missing, non-PDF, other-dispute or repeated document INVALID_PROPOSAL", async () => {
    const client = await gate(world());
    const pdf = (await prepare(client)).documents[0];
    const other = (await prepare(client, OTHER_DISPUTE)).documents[0];
    if (pdf === undefined || other === undefined) throw new Error("no PDF");
    const json = {
      id: "doc_0123456789abcdef01234567",
      disputeId: DISPUTE,
      kind: "export" as const,
      name: "countersign-evidence-capture-CAP-1037.json",
      contentType: "application/json",
      bytes: new TextEncoder().encode("{}\n"),
      createdAt: "2026-10-22T10:00:00.000Z",
    };
    await writeEvidenceDocument(db, json);

    const cases: [string[], string][] = [
      [["doc_ffffffffffffffffffffffff"], "No evidence document doc_ffffffffffffffffffffffff"],
      [[json.id], `Evidence document ${json.id} isn't a PDF`],
      [[other.id], `Evidence document ${other.id} is for another dispute, not ${DISPUTE}`],
      [[pdf.id, pdf.id], "Must not name a document twice"],
      [[], "document_ids"],
    ];
    for (const [ids, detail] of cases) {
      const response = await provide(client, evidenceArgs(ids));
      expect(response).toMatchObject({
        decision: "denied",
        reasons: [{ code: "INVALID_PROPOSAL", detail: expect.stringContaining(detail) }],
      });
    }
    const tooMany = await provide(client, evidenceArgs(Array(6).fill(pdf.id)));
    expect(tooMany.decision).toBe("denied");
    expect((await decisions()).every((decision) => decision.decision === "deny")).toBe(true);
  });

  it("leaves the target unknown when the document store can't be read", async () => {
    const w = world();
    const client = await gate(w);
    const pdf = (await prepare(client)).documents[0];
    if (pdf === undefined) throw new Error("no PDF");
    // Every read outside the audit log's transaction fails, as an unreachable store would.
    const broken = new Proxy(db, {
      get(target, property, receiver) {
        if (property === "select") {
          return () => {
            throw new Error("connection refused");
          };
        }
        return Reflect.get(target, property, receiver);
      },
    });
    const result = await propose({
      mandate,
      principal: "support-agent",
      proposal: { tool: "provide_dispute_evidence", args: evidenceArgs([pdf.id]) },
      now,
      rail: w.rail,
      carrier: w.carrier,
      db: broken,
    });
    if (!result.ok || result.replay) throw new Error("not decided");
    expect(result.record.decision).toBe("deny");
    expect(result.record.reasons).toEqual([
      { code: "TARGET_UNKNOWN", detail: "The evidence document store can't be read" },
    ]);
    expect(result.problems).toEqual([
      { call: "evidence-documents", message: "The evidence document store read failed." },
    ]);
  });
});
