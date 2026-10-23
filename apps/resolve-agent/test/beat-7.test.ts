import type { Server } from "node:http";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import { createDatabaseShipmentStore } from "@countersign/carrier-mock";
import {
  asc,
  auditLog,
  createTestDatabase,
  type DatabaseHandle,
  readEvidenceDocument,
  seedOrders,
  sha256Hex,
} from "@countersign/db";
import { createApp as createGate } from "@countersign/gate/src/app";
import type { NudgeFetch } from "@countersign/gate/src/nudge";
import { createFakeSandbox, type FakeSandbox } from "@countersign/gate/test/fake-sandbox";
import { verifyLog } from "@countersign/ledger";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp as createResolve } from "../src/app";
import { runDisputeDraft } from "../src/drafter";
import { parseProtectedEnv } from "../src/protected";
import { createModeRunner, createRunQueue, type RunQueue } from "../src/queue";

// Beat 7 end to end, with no AI and no PayPal: the signed CUSTOMER.DISPUTE.CREATED fixture
// reaches a listening gate (its fake sandbox and the carrier mock over the store, simulated),
// the nudge reaches a listening Resolve, the template drafts the evidence, and the approver
// approves the step-up through the approval API, which submits the PDF once. KIK-1042 is beat
// 3's delivered order. Illustrative shop and buyer; made-up keys.

const SLOW = 120_000;
const NOW = new Date("2026-10-22T10:00:00Z");
const AGENT_KEY = "test-support-agent-key-0123456789abcdef";
const APPROVER_KEY = "approver-key-illustrative-0123456789abcd";
const WEBHOOK_ID = "WH-FAKE-0123456789";
const PAYER = "amina.k@example.com";
const DISPUTE = "PP-D-1042";
const CAPTURE = "CAP1042";
const TRACKING = "KC-run1-1042";

type WebhookFixture = { headers: Record<string, string>; body: { id: string; event_type: string } };
const fixture = createRequire(import.meta.url)(
  "@countersign/gate/webhooks/beat-7-dispute-created.json",
) as WebhookFixture;

const usd = (minor: number) => ({ minor, currency: "USD" as const });

async function seed(handle: DatabaseHandle): Promise<FakeSandbox> {
  await handle.db.insert(seedOrders).values({
    orderNumber: "KIK-1042",
    runId: "run1",
    paypalOrderId: "ORD1042",
    paypalCaptureId: CAPTURE,
    amountMinor: 4800,
    currency: "USD",
    payerEmail: PAYER,
    buyer: "A",
    trackingNumber: TRACKING,
    role: "demo",
    seededAt: "2026-10-01T08:00:00Z",
  });
  await createDatabaseShipmentStore(handle.db).write({
    trackingNumber: TRACKING,
    carrierName: "Illustrative Post",
    status: "delivered",
    scanEvents: [
      { at: "2026-10-02T08:00:00Z", description: "Picked up", place: "Kisumu" },
      { at: "2026-10-03T14:20:00Z", description: "Delivered to recipient", place: "Nairobi" },
    ],
    updatedAt: "2026-10-03T14:20:00Z",
  });
  const rail = createFakeSandbox();
  const capture = { id: CAPTURE, status: "COMPLETED", amount: usd(4800), orderId: "ORD1042" };
  rail.captures.set(CAPTURE, { ...capture, createTime: "2026-10-01T08:00:05Z" });
  rail.orders.set("ORD1042", {
    id: "ORD1042",
    status: "COMPLETED",
    payerEmail: PAYER,
    payerId: "PAYERA",
    purchaseUnits: [
      {
        referenceId: "KIK-1042",
        customId: null,
        invoiceId: null,
        amount: usd(4800),
        captures: [capture],
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
  rail.disputeDetails.set(DISPUTE, {
    id: DISPUTE,
    status: "WAITING_FOR_SELLER_RESPONSE",
    amount: usd(4800),
    captureIds: [CAPTURE],
    reason: "MERCHANDISE_OR_SERVICE_NOT_RECEIVED",
    lifeCycleStage: "INQUIRY",
    sellerResponseDueDate: "2026-11-01T23:59:59Z",
  });
  return rail;
}

async function listen(app: ReturnType<typeof createGate>, servers: Server[]): Promise<string> {
  const server = app.listen(0, "127.0.0.1");
  servers.push(server);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

const approver = { authorization: `Bearer ${APPROVER_KEY}` };

describe("beat 7: a dispute from webhook to approved submission", { timeout: SLOW }, () => {
  let handle: DatabaseHandle;
  const servers: Server[] = [];
  let queue: RunQueue | undefined;

  beforeAll(async () => {
    handle = await createTestDatabase();
  }, SLOW);

  afterAll(async () => {
    for (const server of servers) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    await queue?.idle();
    await handle.close();
  });

  it("records the dispute, drafts from records, and sends the approved PDF once", async () => {
    const { db } = handle;
    const rail = await seed(handle);
    const clock = () => NOW;

    // Resolve, drafting with the template (no Gemini key), against the gate set below.
    let gateUrl = "";
    queue = createRunQueue(
      createModeRunner({
        db,
        generateContent: null,
        protectedEnv: parseProtectedEnv({}),
        issueToken: async () => {
          throw new Error("Beat 7 has no baseline run.");
        },
        clock,
        runDraft: async (draftId) => {
          await runDisputeDraft({
            db,
            draftId,
            generateContent: null,
            env: parseProtectedEnv({
              COUNTERSIGN_SUPPORT_AGENT_KEY: AGENT_KEY,
              GATE_MCP_URL: `${gateUrl}/mcp`,
            }),
            clock,
          });
        },
      }),
    );
    const resolveUrl = await listen(
      createResolve({ db, model: "gemini-3.5-flash-lite", queue, clock }),
      servers,
    );

    // The gate, whose nudge goes to that Resolve over HTTP; the test waits on it, never sleeps.
    const nudges: Promise<{ ok: boolean }>[] = [];
    const nudgeFetch: NudgeFetch = (url, init) => {
      const sent = fetch(url, init).then((response) => ({ ok: response.ok }));
      nudges.push(sent);
      return sent;
    };
    gateUrl = await listen(
      createGate({
        db,
        rail: () => rail,
        env: {
          COUNTERSIGN_SUPPORT_AGENT_KEY: AGENT_KEY,
          COUNTERSIGN_APPROVER_KEY: APPROVER_KEY,
          PAYPAL_WEBHOOK_ID: WEBHOOK_ID,
          RESOLVE_AGENT_URL: resolveUrl,
        },
        clock,
        fetch: nudgeFetch,
      }),
      servers,
    );

    // 1. PayPal's webhook, verified over the exact raw body.
    const rawBody = JSON.stringify(fixture.body);
    const webhook = await fetch(`${gateUrl}/webhooks/paypal`, {
      method: "POST",
      headers: { "content-type": "application/json", ...fixture.headers },
      body: rawBody,
    });
    expect(webhook.status).toBe(200);
    expect(await webhook.json()).toEqual({ message: "Recorded." });
    expect(rail.calls.find((call) => call.call === "verifyWebhookSignature")?.arg).toEqual(
      expect.objectContaining({ webhookId: WEBHOOK_ID, rawBody }),
    );

    // 2. The nudge queued one draft, which ran to a step-up.
    expect(nudges).toHaveLength(1);
    expect((await nudges[0])?.ok).toBe(true);
    await queue.idle();
    const drafts = (await (await fetch(`${resolveUrl}/disputes`)).json()) as {
      drafts: Record<string, unknown>[];
    };
    expect(drafts.drafts).toEqual([
      expect.objectContaining({
        dispute_id: DISPUTE,
        status: "proposed",
        drafted_by: "template",
        agent_response_status: "pending_approval",
      }),
    ]);

    // 3. The card shows exactly what executes: the item, the note and the PDF.
    const list = await fetch(`${gateUrl}/approvals`, { headers: approver });
    expect(list.status).toBe(200);
    const { open } = (await list.json()) as {
      open: {
        step_up_id: number;
        intent_hash: string;
        action: string;
        target: { kind: string; id: string };
        params: {
          kind: string;
          items: { evidence_type: string; notes: string; tracking_numbers: string[] }[];
          documents: { id: string; name: string; sha256: string; available: boolean }[];
        };
      }[];
    };
    expect(open).toHaveLength(1);
    const card = open[0];
    if (card === undefined) throw new Error("no card");
    expect(card.action).toBe("paypal.dispute.provide_evidence");
    expect(card.target).toMatchObject({ kind: "dispute", id: DISPUTE });
    expect(card.params.kind).toBe("provide_evidence");
    expect(card.params.items).toEqual([
      expect.objectContaining({
        evidence_type: "PROOF_OF_FULFILLMENT",
        tracking_numbers: [TRACKING],
        notes: expect.stringContaining("(simulated carrier data)"),
      }),
    ]);
    const [pdf, ...otherDocuments] = card.params.documents;
    expect(otherDocuments).toEqual([]);
    expect(pdf).toMatchObject({ name: `countersign-evidence-${DISPUTE}.pdf`, available: true });
    if (pdf === undefined) throw new Error("no PDF");

    // 4. The approver can read the PDF before approving.
    const download = await fetch(`${gateUrl}/approvals/documents/${pdf.id}`, { headers: approver });
    expect(download.status).toBe(200);
    expect(download.headers.get("content-type")).toContain("application/pdf");
    const downloaded = new Uint8Array(await download.arrayBuffer());
    expect(sha256Hex(downloaded)).toBe(pdf.sha256);
    expect(rail.calls.some((call) => call.call === "provideEvidence")).toBe(false);

    // 5. One approval, bound to the hash, sends exactly that pack.
    const approve = await fetch(`${gateUrl}/approvals/${card.step_up_id}`, {
      method: "POST",
      headers: { ...approver, "content-type": "application/json" },
      body: JSON.stringify({ answer: "approve", intent_hash: card.intent_hash }),
    });
    expect(approve.status).toBe(200);
    expect(await approve.json()).toMatchObject({
      outcome: "approved",
      execution: { outcome: "executed", dispute: { id: DISPUTE, status: "UNDER_REVIEW" } },
    });
    const sent = rail.calls.filter((call) => call.call === "provideEvidence");
    expect(sent).toHaveLength(1);
    const input = sent[0]?.arg as {
      disputeId: string;
      evidences: { evidenceType: string; notes: string }[];
      documents: { name: string; contentType: string; bytes: Uint8Array }[];
    };
    expect(input.disputeId).toBe(DISPUTE);
    expect(input.evidences.map((item) => [item.evidenceType, item.notes])).toEqual(
      card.params.items.map((item) => [item.evidence_type, item.notes]),
    );
    expect(input.documents).toHaveLength(1);
    expect(input.documents[0]?.name).toBe(pdf.name);
    expect(input.documents[0]?.contentType).toBe("application/pdf");
    expect(sha256Hex(input.documents[0]?.bytes ?? new Uint8Array())).toBe(pdf.sha256);
    expect((await readEvidenceDocument(db, pdf.id))?.sha256).toBe(pdf.sha256);

    // 6. The log holds the whole trail, its chain intact, and no payer email.
    const rows = await db.select().from(auditLog).orderBy(asc(auditLog.seq));
    expect(rows.map((row) => row.entryType)).toEqual([
      "dispute.received",
      "mandate.version",
      "decision",
      "approval",
      "execution.requested",
      "execution.result",
    ]);
    expect(rows.every((row) => !row.payload.includes(PAYER))).toBe(true);
    expect((await verifyLog(db)).intact).toBe(true);
  });
});
