import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createMemoryShipmentStore, createMockCarrier } from "@countersign/carrier-mock";
import {
  asc,
  auditLog,
  createTestDatabase,
  type Database,
  type DatabaseHandle,
  sql,
} from "@countersign/db";
import { verifyLog } from "@countersign/ledger";
import { type Mandate, parseMandate } from "@countersign/mandate";
import { PayPalError } from "@countersign/rail-paypal";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { type AnswerStepUpResult, answerStepUp } from "../src/answer-step-up";
import { readExecutionHistory, readIntentRecord } from "../src/execution-log";
import { PAYOUT_EMAIL_SUBJECT } from "../src/executors";
import { type ProposeResult, propose } from "../src/propose";
import { createFakeSandbox, type FakeSandbox, httpError } from "./fake-sandbox";

// The payout executor (ADR 0039) through propose() and answerStepUp(), with the ops mandate, the
// fake sandbox, PGlite and an injected clock: an approved payout is sent once with exactly the
// stored intent, its batch is read once, and the batch and first item are logged. Illustrative
// suppliers and bills.

const SLOW = 60_000;
const NOW = new Date("2026-10-24T09:00:00+03:00");
const LATER = new Date(NOW.getTime() + 5 * 60 * 1000);
const PRINCIPAL = "ops-agent";
const PAYEE = "dyeworks@example.com";

const mandateFile = fileURLToPath(
  new URL("../../../packages/mandate/fixtures/kikapu-studio-ops-v1.json", import.meta.url),
);
const shipped = JSON.parse(readFileSync(mandateFile, "utf8"));

function mandateOf(json: unknown): Mandate {
  const parsed = parseMandate(json);
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.mandate;
}
const mandate = mandateOf(shipped);

// The ops mandate with listed payouts allowed outright, for the allowed path.
const allowingPayouts = mandateOf({
  ...structuredClone(shipped),
  rules: [
    {
      id: "payout-listed-supplier",
      action: "paypal.payout",
      require: ["payee.allowlisted"],
      decide: "allow",
    },
  ],
});

const usd = (minor: number) => ({ minor, currency: "USD" as const });

function world() {
  const rail = createFakeSandbox();
  const carrier = createMockCarrier(createMemoryShipmentStore(new Map()));
  return { rail, carrier };
}
type World = ReturnType<typeof world>;

const payout = {
  tool: "create_payout",
  args: {
    receiver: "DyeWorks@Example.com ",
    amount: { value: "45.00", currency_code: "USD" },
    reference: "KDW-2026-0412",
    note: "April dye order",
  },
};
const withoutNote = {
  tool: "create_payout",
  args: {
    receiver: PAYEE,
    amount: { value: "12.50", currency_code: "USD" },
    reference: "KDW-2026-0413",
  },
};

const railCalls = (rail: FakeSandbox, call: string) =>
  rail.calls.filter((entry) => entry.call === call);

function answered(result: AnswerStepUpResult) {
  if (result.kind !== "answered") throw new Error(`not answered: ${result.kind}`);
  return result;
}

describe("the payout executor", { timeout: SLOW }, () => {
  let handle: DatabaseHandle;
  let db: Database;

  beforeAll(async () => {
    handle = await createTestDatabase();
    db = handle.db;
  }, SLOW);

  beforeEach(async () => {
    await db.execute(sql`TRUNCATE audit_log`);
  });

  afterAll(async () => {
    await handle.close();
  });

  const entries = () => db.select().from(auditLog).orderBy(asc(auditLog.seq));
  const payloadsOf = async (type: string) =>
    (await entries()).filter((row) => row.entryType === type).map((row) => JSON.parse(row.payload));

  const run = (w: World, proposal: unknown, now = NOW, using = mandate) =>
    propose({ mandate: using, principal: PRINCIPAL, proposal, now, ...w, db, clock: () => now });
  const decided = (result: ProposeResult) => {
    if (!result.ok || result.replay) throw new Error("not decided");
    return result;
  };

  const stepUp = async (w: World, proposal: unknown, now = NOW) => {
    const result = decided(await run(w, proposal, now));
    expect(result.record.decision).toBe("step_up");
    const { intentId, intentHash } = result.record;
    if (intentId === null || intentHash === null) throw new Error("no intent");
    return { seq: result.seqs.decision, id: intentId, hash: intentHash, result };
  };

  const approve = async (w: World, step: { seq: number; hash: string }, now = LATER) =>
    answered(
      await answerStepUp({
        db,
        rail: w.rail,
        stepUpSeq: step.seq,
        answer: "approve",
        intentHash: step.hash,
        channel: "approvals_page",
        now,
        clock: () => now,
      }),
    );

  it("sends an approved payout once with exactly the stored intent, reads the batch, and logs its first item", async () => {
    const w = world();
    const step = await stepUp(w, payout);
    expect(w.rail.calls).toEqual([]);

    const result = await approve(w, step);

    expect(result.outcome).toBe("approved");
    expect(w.rail.calls.map((call) => call.call)).toEqual(["createPayout", "getPayoutBatch"]);
    expect(w.rail.payoutsSent).toEqual([
      {
        requestId: step.hash,
        senderBatchId: step.id,
        emailSubject: "You have a payment from Kikapu Studio (illustrative)",
        receiver: PAYEE,
        amount: usd(4500),
        note: "April dye order",
        senderItemId: "KDW-2026-0412",
      },
    ]);
    expect(PAYOUT_EMAIL_SUBJECT).toBe("You have a payment from Kikapu Studio (illustrative)");
    const logged = { batchId: "FAKEBATCH0001", batchStatus: "PENDING" };
    expect(result.execution).toMatchObject({
      outcome: "executed",
      sent: true,
      refund: null,
      error: null,
      payout: { ...logged, item: { id: "FAKEITEM0001", status: "UNCLAIMED" } },
    });

    const [request] = await payloadsOf("execution.requested");
    expect(request).toMatchObject({
      action: "paypal.payout",
      principal: PRINCIPAL,
      approvalSeq: result.approvalSeq,
      requestId: step.hash,
      captureId: null,
      target: { email: PAYEE },
      amount: usd(4500),
    });
    expect(await payloadsOf("execution.result")).toEqual([
      {
        requestSeq: result.requestSeq,
        outcome: "executed",
        payout: { ...logged, item: { id: "FAKEITEM0001", status: "UNCLAIMED" } },
      },
    ]);
    expect((await verifyLog(db)).intact).toBe(true);
  });

  it("leaves the note out when the intent has none", async () => {
    const w = world();
    await approve(w, await stepUp(w, withoutNote));

    const [sent] = w.rail.payoutsSent;
    expect(sent).not.toHaveProperty("note");
    expect(sent).toMatchObject({ amount: usd(1250), senderItemId: "KDW-2026-0413" });
  });

  it("sends nothing when the step-up is approved again or the same payout is proposed and approved again", async () => {
    const w = world();
    const first = await stepUp(w, payout);
    expect((await approve(w, first)).execution?.outcome).toBe("executed");

    const again = await approve(w, first);
    expect(again).toMatchObject({ outcome: "rejected", code: "ALREADY_ANSWERED", execution: null });

    const second = await stepUp(w, payout, LATER);
    expect(second.hash).toBe(first.hash);
    const reapproved = await approve(w, second, LATER);
    expect(reapproved).toMatchObject({
      outcome: "rejected",
      code: "ALREADY_REQUESTED",
      execution: null,
    });

    expect(railCalls(w.rail, "createPayout")).toHaveLength(1);
    expect(await payloadsOf("execution.requested")).toHaveLength(1);
  });

  it("never re-sends a payout whose outcome is unknown", async () => {
    const w = world();
    const first = await stepUp(w, payout);
    w.rail.failures.createPayout = httpError("create-payout", 500, "INTERNAL_SERVER_ERROR");
    expect((await approve(w, first)).execution?.outcome).toBe("unknown");

    const second = await stepUp(w, payout, LATER);
    expect((await approve(w, second, LATER)).code).toBe("ALREADY_REQUESTED");
    expect(railCalls(w.rail, "createPayout")).toHaveLength(1);
  });

  it("sends an allowed payout once, and answers a re-proposal from the log without sending", async () => {
    const w = world();
    const first = decided(await run(w, payout, NOW, allowingPayouts));
    expect(first.record.decision).toBe("allow");
    expect(first.execution).toMatchObject({
      outcome: "executed",
      sent: true,
      payout: { batchId: "FAKEBATCH0001", item: { id: "FAKEITEM0001" } },
    });
    const [request] = await payloadsOf("execution.requested");
    expect(request).toMatchObject({
      decisionSeq: first.seqs.decision,
      requestId: first.record.intentHash,
    });

    const second = decided(await run(w, payout, LATER, allowingPayouts));
    expect(second.record.intentId).toBe(first.record.intentId);
    expect(second.seqs.request).toBeNull();
    expect(second.execution).toMatchObject({
      outcome: "executed",
      sent: false,
      payout: { batchId: "FAKEBATCH0001", batchStatus: "PENDING" },
      resultSeq: first.execution?.resultSeq,
    });
    expect(railCalls(w.rail, "createPayout")).toHaveLength(1);
  });

  it.each([
    ["PENDING", "executed"],
    ["PROCESSING", "executed"],
    ["SUCCESS", "executed"],
    ["NEW", "executed"],
    ["DENIED", "failed"],
    ["CANCELED", "failed"],
    ["SOMETHING_NEW", "unknown"],
  ] as const)("records a batch that reads %s as %s", async (batchStatus, outcome) => {
    const w = world();
    w.rail.payoutBatchStatus = batchStatus;
    const result = await approve(w, await stepUp(w, payout));

    expect(result.execution).toMatchObject({ outcome, error: null });
    expect(await payloadsOf("execution.result")).toEqual([
      {
        requestSeq: result.requestSeq,
        outcome,
        payout: {
          batchId: "FAKEBATCH0001",
          batchStatus,
          item: { id: "FAKEITEM0001", status: "UNCLAIMED" },
        },
      },
    ]);
  });

  it.each([
    ["a 4xx", httpError("create-payout", 422, "INSUFFICIENT_FUNDS"), "failed"],
    [
      "a duplicate-batch refusal",
      new PayPalError({
        kind: "http",
        call: "create-payout",
        status: 400,
        paypalName: "USER_BUSINESS_ERROR",
        issues: ["Batch with given sender_batch_id already exists"],
        debugId: "fake-debug",
      }),
      "unknown",
    ],
    ["a 5xx", httpError("create-payout", 503, "SERVICE_UNAVAILABLE"), "unknown"],
    [
      "a network failure",
      new PayPalError({ kind: "network", call: "create-payout", status: null }),
      "unknown",
    ],
  ] as const)(
    "records %s as %s, with PayPal's error and no batch read",
    async (_label, error, outcome) => {
      const w = world();
      const step = await stepUp(w, payout);
      w.rail.failures.createPayout = error;

      const result = await approve(w, step);

      expect(result.execution?.outcome).toBe(outcome);
      expect(result.execution?.payout ?? null).toBeNull();
      expect(railCalls(w.rail, "getPayoutBatch")).toHaveLength(0);
      const [logged] = await payloadsOf("execution.result");
      expect(logged).toEqual({
        requestSeq: result.requestSeq,
        outcome,
        error: {
          name: error.paypalName,
          issues: [...error.issues],
          debugId: error.debugId,
        },
      });
    },
  );

  it("records the batch with a null item when the batch read fails, still executed", async () => {
    const w = world();
    const step = await stepUp(w, payout);
    w.rail.failures.getPayoutBatch = httpError("get-payout-batch", 503);

    const result = await approve(w, step);

    expect(result.execution).toMatchObject({
      outcome: "executed",
      payout: { batchId: "FAKEBATCH0001", batchStatus: "PENDING", item: null },
    });
    expect(railCalls(w.rail, "createPayout")).toHaveLength(1);
    expect(railCalls(w.rail, "getPayoutBatch")).toHaveLength(1);
    expect(await payloadsOf("execution.result")).toEqual([
      {
        requestSeq: result.requestSeq,
        outcome: "executed",
        payout: { batchId: "FAKEBATCH0001", batchStatus: "PENDING", item: null },
      },
    ]);
  });

  it("counts an executed payout in the ops agent's usage, and a denied batch not", async () => {
    const w = world();
    await approve(w, await stepUp(w, payout));
    w.rail.payoutBatchStatus = "DENIED";
    await approve(w, await stepUp(w, withoutNote));

    const later = await stepUp(
      w,
      { ...payout, args: { ...payout.args, reference: "KDW-2026-0414" } },
      LATER,
    );
    const usage = later.result.record.usage;
    if (!usage.known) throw new Error("usage unknown");
    expect(usage.perCurrency.USD).toEqual({ count: 1, total: usd(4500) });
    const history = await readExecutionHistory(db);
    expect(history).toMatchObject({ known: true, executions: [{ principal: PRINCIPAL }] });
  });

  it("reads an executed payout back from the intent's trail", async () => {
    const w = world();
    const step = await stepUp(w, payout);
    const result = await approve(w, step);

    expect(await readIntentRecord(db, step.id)).toMatchObject({
      known: true,
      trail: {
        executed: {
          seq: result.execution?.resultSeq,
          payout: { batchId: "FAKEBATCH0001", item: { id: "FAKEITEM0001" } },
        },
        lastOutcome: "executed",
      },
    });
  });
});
