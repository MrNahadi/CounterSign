import type { AddressInfo } from "node:net";
import { createTestDatabase, type DatabaseHandle, finishRun, startRun } from "@countersign/db";
import { appendEntry } from "@countersign/ledger";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { allowedIntentIds, heldCalls, readExecutions, readHeld } from "../src/executions";
import { storeMessage } from "../src/intake";
import { createRunQueue } from "../src/queue";

// The thread answer carries what the gate executed for each allowed call, read from the audit
// log's `execution.result`, so the inbox can show an allowed refund's PayPal refund ID.

const ALLOWED = "int_0123456789abcdef01234567";
const DENIED = "int_fedcba9876543210fedcba98";
const NO_RESULT = "int_aaaaaaaaaaaaaaaaaaaaaaaa";
const NOW = new Date("2026-10-20T08:00:00Z");

const toolStep = (structuredContent: unknown) => ({
  kind: "tool",
  step: 2,
  id: "call_1",
  name: "create_refund",
  args: {},
  result: { content: [{ type: "text", text: "{}" }], structuredContent, isError: false },
  latencyMs: 12,
  local: false,
});

const trace = {
  mode: "protected",
  tools: [],
  rewrites: [],
  steps: [
    { kind: "model", step: 1 },
    toolStep({ decision: "allowed", intent_id: ALLOWED, intent_hash: "a".repeat(64) }),
    toolStep({ decision: "allowed", intent_id: ALLOWED, intent_hash: "a".repeat(64) }),
    toolStep({
      decision: "denied",
      intent_id: DENIED,
      reasons: [{ code: "TICKET_NOT_FROM_PAYER", detail: "x" }],
      safe_reply_hint: "x",
    }),
    toolStep({ decision: "allowed", intent_id: NO_RESULT, intent_hash: "b".repeat(64) }),
  ],
};

let handle: DatabaseHandle;
beforeEach(async () => {
  handle = await createTestDatabase();
});
afterEach(async () => {
  await handle.close();
});

const result = (intentId: string, payload: unknown) =>
  appendEntry(handle.db, {
    entryType: "execution.result",
    refId: intentId,
    at: NOW.toISOString(),
    payload,
  });

describe("allowed intents and their executions", () => {
  it("lists each allowed intent once, and nothing from junk traces", () => {
    expect(allowedIntentIds(trace)).toEqual([ALLOWED, NO_RESULT]);
    expect(allowedIntentIds(null)).toEqual([]);
    expect(allowedIntentIds({ steps: "no" })).toEqual([]);
  });

  it("reads each intent's latest result and leaves out intents with none", async () => {
    await result(ALLOWED, {
      requestSeq: 1,
      outcome: "failed",
      error: { name: "X", issues: [], debugId: null },
    });
    await result(ALLOWED, {
      requestSeq: 1,
      outcome: "executed",
      refund: { id: "8RT45612AB", status: "COMPLETED" },
    });
    expect(await readExecutions(handle.db, [ALLOWED, NO_RESULT])).toEqual([
      {
        intent_id: ALLOWED,
        outcome: "executed",
        refund_id: "8RT45612AB",
        refund_status: "COMPLETED",
      },
    ]);
  });

  it("puts them on each run of GET /threads/:id", async () => {
    const stored = await storeMessage(
      handle.db,
      {
        channel: "email",
        senderEmail: "payer@example.com",
        senderPhone: null,
        subject: "Stalled parcel",
        body: "My parcel hasn't moved.",
        attachments: [],
      },
      { mode: "protected", model: "gemini-3.5-flash-lite", clock: () => NOW },
    );
    await startRun(handle.db, stored.runId, NOW.toISOString());
    await finishRun(handle.db, stored.runId, {
      status: "replied",
      outcome: "replied",
      reply: "Done.",
      modelVersions: [],
      trace,
      finishedAt: NOW.toISOString(),
    });
    await result(ALLOWED, {
      requestSeq: 1,
      outcome: "executed",
      refund: { id: "8RT45612AB", status: "COMPLETED" },
    });

    const app = createApp({
      db: handle.db,
      model: "gemini-3.5-flash-lite",
      queue: createRunQueue(async () => undefined),
    });
    const server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server.once("listening", resolve));
    try {
      const port = (server.address() as AddressInfo).port;
      const answer = (await (
        await fetch(`http://127.0.0.1:${port}/threads/${stored.threadId}`)
      ).json()) as { runs: { executions: unknown }[] };
      expect(answer.runs[0]?.executions).toEqual([
        {
          intent_id: ALLOWED,
          outcome: "executed",
          refund_id: "8RT45612AB",
          refund_status: "COMPLETED",
        },
      ]);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe("held calls and what happened to them", () => {
  const HELD_APPROVED = "int_111111111111111111111111";
  const HELD_DENIED = "int_222222222222222222222222";
  const HELD_EXPIRED = "int_333333333333333333333333";
  const HELD_WAITING = "int_444444444444444444444444";
  const HELD_REJECTED = "int_555555555555555555555555";
  const FUTURE = "2026-10-20T08:15:00.000Z";
  const PAST = "2026-10-20T07:45:00.000Z";

  const held = (intentId: string, expiresAt: string) =>
    toolStep({
      decision: "pending_approval",
      intent_id: intentId,
      reasons: [{ code: "AMOUNT_OVER_CAP", detail: "x" }],
      expires_at: expiresAt,
    });

  const heldTrace = {
    steps: [
      held(HELD_APPROVED, FUTURE),
      held(HELD_APPROVED, FUTURE),
      held(HELD_DENIED, FUTURE),
      held(HELD_EXPIRED, PAST),
      held(HELD_WAITING, FUTURE),
      held(HELD_REJECTED, PAST),
      toolStep({ decision: "allowed", intent_id: ALLOWED }),
    ],
  };

  const answer = (intentId: string, outcome: string, extra: object = {}) =>
    appendEntry(handle.db, {
      entryType: "approval",
      refId: intentId,
      at: NOW.toISOString(),
      payload: {
        stepUpSeq: 1,
        intentHash: "a".repeat(64),
        answer: outcome === "denied" ? "deny" : "approve",
        outcome,
        approver: "merchant",
        channel: "approvals_page",
        ...extra,
      },
    });

  it("finds each held intent once, with its expiry", () => {
    expect(heldCalls(heldTrace).map((call) => call.intentId)).toEqual([
      HELD_APPROVED,
      HELD_DENIED,
      HELD_EXPIRED,
      HELD_WAITING,
      HELD_REJECTED,
    ]);
    expect(heldCalls(heldTrace)[0]?.expiresAt).toBe(FUTURE);
    expect(heldCalls(null)).toEqual([]);
  });

  it("reports approved with the refund, denied, expired and waiting", async () => {
    await answer(HELD_APPROVED, "approved");
    await result(HELD_APPROVED, {
      requestSeq: 2,
      outcome: "executed",
      refund: { id: "4XJ12345AB", status: "COMPLETED" },
    });
    await answer(HELD_DENIED, "denied");
    await answer(HELD_REJECTED, "rejected", { code: "EXPIRED" });
    const views = await readHeld(handle.db, heldCalls(heldTrace), NOW);
    const by = (id: string) => views.find((view) => view.intent_id === id);
    expect(by(HELD_APPROVED)).toMatchObject({
      state: "approved",
      outcome: "executed",
      refund_id: "4XJ12345AB",
      refund_status: "COMPLETED",
      invoice_id: null,
    });
    expect(by(HELD_DENIED)?.state).toBe("denied");
    expect(by(HELD_EXPIRED)?.state).toBe("expired");
    expect(by(HELD_WAITING)?.state).toBe("waiting");
    expect(by(HELD_REJECTED)?.state).toBe("expired");
  });

  it("reports an approved invoice send, and an approval with no result yet", async () => {
    await answer(HELD_APPROVED, "approved");
    await answer(HELD_DENIED, "approved");
    await result(HELD_DENIED, {
      requestSeq: 3,
      outcome: "executed",
      invoice: { id: "INV2-AB12", status: "SENT" },
    });
    const views = await readHeld(handle.db, heldCalls(heldTrace), NOW);
    expect(views.find((view) => view.intent_id === HELD_APPROVED)).toMatchObject({
      state: "approved",
      outcome: null,
      refund_id: null,
    });
    expect(views.find((view) => view.intent_id === HELD_DENIED)).toMatchObject({
      state: "approved",
      invoice_id: "INV2-AB12",
      invoice_status: "SENT",
    });
  });

  it("never reads an unreadable answer as approved", async () => {
    await answer(HELD_WAITING, "maybe");
    const views = await readHeld(handle.db, heldCalls(heldTrace), NOW);
    expect(views.find((view) => view.intent_id === HELD_WAITING)?.state).toBe("waiting");
  });
});
