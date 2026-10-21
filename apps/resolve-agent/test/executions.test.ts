import type { AddressInfo } from "node:net";
import { createTestDatabase, type DatabaseHandle, finishRun, startRun } from "@countersign/db";
import { appendEntry } from "@countersign/ledger";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { allowedIntentIds, readExecutions } from "../src/executions";
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
