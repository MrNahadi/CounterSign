import { createHash } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createMemoryShipmentStore, createMockCarrier } from "@countersign/carrier-mock";
import {
  asc,
  auditLog,
  countDraftsOnDate,
  createTestDatabase,
  type Database,
  type DatabaseHandle,
  eq,
  listLatestDrafts,
  queueDraft,
  readDraft,
  sql,
} from "@countersign/db";
import { createApp } from "@countersign/gate/src/app";
import { createFakeSandbox } from "@countersign/gate/test/fake-sandbox";
import type { GenerateContentParameters, GenerateContentResponse } from "@google/genai";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  DRAFT_SYSTEM_INSTRUCTION,
  modelFacts,
  type Prepared,
  PreparedSchema,
  runDisputeDraft,
  TEMPLATE,
  templateNotes,
} from "../src/drafter";
import type { GenerateContent } from "../src/model";
import { connectGate, parseProtectedEnv } from "../src/protected";
import { runResolve } from "../src/resolve-cli";
import { RECORDED_FACTS } from "./dispute-facts";

// The dispute drafter end to end (ADR 0035): a listening gate (its fake sandbox and a memory
// carrier, simulated) on 127.0.0.1 sharing one PGlite store with Resolve, and a scripted model.
// Beat 5's KIK-1037 is delivered and tracked, then disputed. Illustrative people and orders;
// a made-up principal key.

const SLOW = 120_000;
const NOW = new Date("2026-10-22T10:00:00Z");
const KEY = "test-support-agent-key-0123456789abcdef";
const MODEL = "gemini-3.5-flash-lite";
const PAYER = "wanjiru.m@example.com";
const DISPUTE = "PP-D-1037";
const DELIVERED_NOTE =
  "Shipped with Illustrative Post under tracking TRK1037; the carrier shows it delivered on 4 Oct 2026 (simulated carrier data). Records attached.";

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
  rail.disputeDetails.set(DISPUTE, {
    id: DISPUTE,
    status: "WAITING_FOR_SELLER_RESPONSE",
    amount: usd(24000),
    captureIds: [captureId],
    reason: "MERCHANDISE_OR_SERVICE_NOT_RECEIVED",
    lifeCycleStage: "CHARGEBACK",
    sellerResponseDueDate: "2026-11-01T23:59:59Z",
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

// ---- The scripted model ----

const answer = (text: string, finishReason = "STOP"): GenerateContentResponse =>
  ({
    candidates: [{ content: { role: "model", parts: [{ text }] }, finishReason }],
    modelVersion: "gemini-3.5-flash-lite-001",
  }) as never;

const MODEL_NOTE = "The parcel was delivered on 4 Oct 2026, per simulated carrier data. Attached.";
const goodAnswer = () =>
  answer(JSON.stringify({ summary: "Delivered and tracked.", notes: [MODEL_NOTE] }));

function scripted(response: GenerateContentResponse | (() => never)) {
  const requests: GenerateContentParameters[] = [];
  const generateContent: GenerateContent = async (request) => {
    requests.push(request);
    if (typeof response === "function") return response();
    return response;
  };
  return { generateContent, requests };
}

// ---- The gate ----

let servers: Server[] = [];

afterEach(async () => {
  for (const server of servers) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  servers = [];
});

describe("the dispute drafter", { timeout: SLOW }, () => {
  let handle: DatabaseHandle;
  let db: Database;

  beforeAll(async () => {
    handle = await createTestDatabase();
    db = handle.db;
  }, SLOW);

  beforeEach(async () => {
    await db.execute(sql`TRUNCATE audit_log, tickets, evidence_documents, dispute_drafts`);
  });

  afterAll(async () => {
    await handle.close();
  });

  async function gateUrl(): Promise<string> {
    const w = world();
    const server = createApp({
      db,
      rail: () => w.rail,
      carrier: w.carrier,
      env: { COUNTERSIGN_SUPPORT_AGENT_KEY: KEY },
      clock: () => NOW,
    }).listen(0, "127.0.0.1");
    servers.push(server);
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const { port } = server.address() as AddressInfo;
    return `http://127.0.0.1:${port}/mcp`;
  }

  async function queued(disputeId = DISPUTE): Promise<string> {
    const { draft } = await queueDraft(db, {
      id: `drf_${disputeId.replace(/-/g, "").toLowerCase()}`,
      disputeId,
      model: MODEL,
      queuedAt: NOW.toISOString(),
    });
    return draft.id;
  }

  // Runs one draft against the gate, recording every MCP tool call it makes.
  async function draft(generateContent: GenerateContent | null, disputeId = DISPUTE) {
    const env = parseProtectedEnv({
      COUNTERSIGN_SUPPORT_AGENT_KEY: KEY,
      GATE_MCP_URL: await gateUrl(),
    });
    const calls: { name: string; arguments: Record<string, unknown> }[] = [];
    const connect = async (): Promise<Client | null> => {
      const client = await connectGate(env);
      if (client === null) return null;
      const callTool = client.callTool.bind(client);
      client.callTool = ((params, ...rest) => {
        calls.push({ name: params.name, arguments: params.arguments ?? {} });
        return callTool(params, ...rest);
      }) as typeof client.callTool;
      return client;
    };
    const draftId = await queued(disputeId);
    const finished = await runDisputeDraft({
      db,
      draftId,
      generateContent,
      env,
      clock: () => NOW,
      connect,
    });
    return { finished, calls };
  }

  it("prepares, makes one model call and one proposal, with all but the notes set by code", async () => {
    const model = scripted(goodAnswer());
    const { finished, calls } = await draft(model.generateContent);

    expect(calls.map((call) => call.name)).toEqual([
      "prepare_dispute_evidence",
      "provide_dispute_evidence",
    ]);
    expect(model.requests).toHaveLength(1);
    expect(finished.status).toBe("proposed");
    expect(finished.outcome).toBe("pending_approval");
    expect(finished.draftedBy).toBe(MODEL);
    expect(finished.modelVersions).toEqual(["gemini-3.5-flash-lite-001"]);
    expect(finished.notes).toEqual({ summary: "Delivered and tracked.", notes: [MODEL_NOTE] });
    expect(finished.intentId).toMatch(/^int_[0-9a-f]{24}$/);
    expect(finished.agentResponse).toMatchObject({
      decision: "pending_approval",
      intent_id: finished.intentId,
    });

    const pdf = (finished.factsSummary as Prepared).documents.find((d) => d.kind === "pdf");
    expect(pdf?.name).toBe("countersign-evidence-PP-D-1037.pdf");
    expect(calls[1]?.arguments).toEqual({
      dispute_id: DISPUTE,
      evidence: [
        { evidence_type: "PROOF_OF_FULFILLMENT", notes: MODEL_NOTE, tracking_numbers: ["TRK1037"] },
      ],
      document_ids: [pdf?.id],
    });

    // The gate stepped it up, with the PDF inside the decided intent.
    const decisions = await db
      .select({ refId: auditLog.refId, payload: auditLog.payload })
      .from(auditLog)
      .where(eq(auditLog.entryType, "decision"))
      .orderBy(asc(auditLog.seq));
    expect(decisions).toHaveLength(1);
    expect(decisions[0]?.payload).toContain("step_up");
    expect(decisions[0]?.payload).toContain(String(pdf?.sha256));
  });

  it("sends the fixed config and the masked facts, never a payer email", async () => {
    const model = scripted(goodAnswer());
    await draft(model.generateContent);

    const request = model.requests[0] as GenerateContentParameters;
    expect(request.model).toBe(MODEL);
    const config = request.config ?? {};
    expect(config.systemInstruction).toBe(DRAFT_SYSTEM_INSTRUCTION);
    expect(config.responseMimeType).toBe("application/json");
    expect(config.thinkingConfig).toEqual({ thinkingLevel: "MEDIUM" });
    expect(config.responseJsonSchema).toMatchObject({
      type: "object",
      properties: { summary: { type: "string" }, notes: { type: "array" } },
      required: ["summary", "notes"],
    });
    expect(config.safetySettings).toHaveLength(5);
    expect(config.safetySettings?.every((setting) => setting.threshold === "OFF")).toBe(true);
    for (const key of ["temperature", "topP", "topK", "tools", "toolConfig"]) {
      expect(config).not.toHaveProperty(key);
    }
    expect(config.thinkingConfig).not.toHaveProperty("thinkingBudget");

    const turn = JSON.stringify(request.contents);
    expect(turn).toContain("TRK1037");
    expect(turn).toContain("Carrier (simulated)");
    expect(turn).not.toContain(PAYER);
    expect(turn).not.toContain("doc_");
  });

  const fallbacks: [string, () => GenerateContent | null][] = [
    ["no API key", () => null],
    [
      "a blocked response",
      () =>
        scripted({ promptFeedback: { blockReason: "PROHIBITED_CONTENT" } } as never)
          .generateContent,
    ],
    ["a non-STOP finish", () => scripted(answer('{"summary":"x"', "MAX_TOKENS")).generateContent],
    ["invalid JSON", () => scripted(answer("Here are your notes.")).generateContent],
    [
      "JSON outside the schema",
      () => scripted(answer(JSON.stringify({ summary: "x", notes: [] }))).generateContent,
    ],
    [
      "a note count that doesn't match the items",
      () => scripted(answer(JSON.stringify({ summary: "x", notes: ["a", "b"] }))).generateContent,
    ],
    [
      "a model call that throws",
      () =>
        scripted(() => {
          throw new Error("socket hang up");
        }).generateContent,
    ],
  ];

  it.each(fallbacks)("uses the template after %s", async (_name, model) => {
    const { finished, calls } = await draft(model());

    expect(finished.status).toBe("proposed");
    expect(finished.outcome).toBe("pending_approval");
    expect(finished.draftedBy).toBe(TEMPLATE);
    expect(finished.notes).toEqual({ summary: null, notes: [DELIVERED_NOTE] });
    expect(calls[1]?.arguments).toMatchObject({
      evidence: [{ evidence_type: "PROOF_OF_FULFILLMENT", notes: DELIVERED_NOTE }],
    });
  });

  it("fails gate_unavailable before any model call when the gate can't be reached", async () => {
    const model = scripted(goodAnswer());
    const draftId = await queued();
    const finished = await runDisputeDraft({
      db,
      draftId,
      generateContent: model.generateContent,
      env: parseProtectedEnv({}),
      clock: () => NOW,
    });

    expect(finished).toMatchObject({ status: "failed", outcome: "gate_unavailable" });
    expect(model.requests).toHaveLength(0);
  });

  it("fails with the gate's sentence when the evidence can't be prepared", async () => {
    const model = scripted(goodAnswer());
    const { finished, calls } = await draft(model.generateContent, "PP-D-0000");

    expect(finished).toMatchObject({
      status: "failed",
      outcome: "prepare_failed:The dispute can't be read from PayPal.",
      agentResponse: null,
      intentId: null,
    });
    expect(calls.map((call) => call.name)).toEqual(["prepare_dispute_evidence"]);
    expect(model.requests).toHaveLength(0);
  });

  it("runs one draft from the CLI and prints its outcome, notes and agent response", async () => {
    const env = { COUNTERSIGN_SUPPORT_AGENT_KEY: KEY, GATE_MCP_URL: await gateUrl() };
    const result = await runResolve(["dispute", DISPUTE], env, { db, clock: () => NOW });

    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(`Dispute ${DISPUTE}`);
    expect(result.stdout).toContain("proposed, pending_approval");
    expect(result.stdout).toContain("Template, no AI");
    expect(result.stdout).toContain(DELIVERED_NOTE);
    expect(result.stdout).toMatch(/pending_approval, intent int_[0-9a-f]{24}/);
    expect(result.stdout).not.toContain(KEY);

    const again = await runResolve(["dispute", DISPUTE], env, { db, clock: () => NOW });
    expect(again.exitCode).toBe(0);
    expect(again.stdout).toContain("already has a draft");
    expect(await listLatestDrafts(db)).toHaveLength(1);
    expect(await countDraftsOnDate(db, "2026-10-22")).toBe(1);
  });

  it("can't run the CLI without the support agent's key", async () => {
    const result = await runResolve(["dispute", DISPUTE], {}, { db, clock: () => NOW });
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("COUNTERSIGN_SUPPORT_AGENT_KEY");
  });

  it("refuses to start a draft that isn't queued", async () => {
    const { finished } = await draft(null);
    await expect(
      runDisputeDraft({
        db,
        draftId: finished.id,
        generateContent: null,
        env: parseProtectedEnv({}),
        clock: () => NOW,
      }),
    ).rejects.toThrow("isn't a queued draft");
    expect((await readDraft(db, finished.id))?.status).toBe("proposed");
  });
});

describe("the drafter's fixed parts", () => {
  it("pins the system instruction byte for byte", () => {
    expect(createHash("sha256").update(DRAFT_SYSTEM_INSTRUCTION).digest("hex")).toBe(
      "71fcc01939434a4979625725959875db34de2b63e22536e7394a34f65422c1f1",
    );
  });

  it("writes the template notes from the facts, with the simulated carrier labelled", () => {
    const other: Prepared = {
      ...RECORDED_FACTS,
      suggested: [
        ...RECORDED_FACTS.suggested,
        { evidence_type: "OTHER", tracking_numbers: [], refund_ids: [] },
      ],
    };
    expect(templateNotes(other)).toEqual({
      summary: null,
      notes: [
        DELIVERED_NOTE,
        "Refunded $20.00 (refund RF-1037). Records attached.",
        "Order KIK-1037, paid $240.00 on 1 Oct 2026. Countersign's records for this payment are attached.",
      ],
    });
  });

  it("never shows the model a key the facts schema doesn't name", () => {
    const planted = {
      ...RECORDED_FACTS,
      payer_email: PAYER,
      capture: { ...RECORDED_FACTS.capture, payer: { email: PAYER } },
      decisions: [{ ...RECORDED_FACTS.decisions?.[0], ticket_text: "Please refund me" }],
    };
    const seen = JSON.stringify(modelFacts(PreparedSchema.parse(planted)));
    expect(seen).toContain("PP-D-1037");
    expect(seen).toContain("Item damaged");
    expect(seen).not.toContain(PAYER);
    expect(seen).not.toContain("Please refund me");
    expect(seen).not.toContain("doc_");
  });
});
