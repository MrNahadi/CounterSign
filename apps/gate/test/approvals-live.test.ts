import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createMemoryShipmentStore, createMockCarrier } from "@countersign/carrier-mock";
import {
  asc,
  auditLog,
  createTestDatabase,
  type DatabaseHandle,
  sql,
  writeTicket,
} from "@countersign/db";
import { parseMandate } from "@countersign/mandate";
import { createPayPalClient, PAYPAL_ENV_NAMES, PayPalError } from "@countersign/rail-paypal";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { answerStepUp } from "../src/answer-step-up";
import { propose } from "../src/propose";

// Live check of a send_invoice step-up against the PayPal sandbox: a fresh draft is decided
// (held for approval), approved through answerStepUp() and sent once. Runs only under LIVE=1
// with the PayPal variables, so `npm test` never calls PayPal. The recipient is on
// example.com. Nothing here prints a secret: failures are reduced to a fixed message.

const present = z.string().min(1);
const LiveEnvSchema = z.object({
  LIVE: z.literal("1"),
  PAYPAL_BASE_URL: present,
  PAYPAL_CLIENT_ID: present,
  PAYPAL_CLIENT_SECRET: present,
});
const live = LiveEnvSchema.safeParse(process.env);
const needs = `needs ${["LIVE=1", ...PAYPAL_ENV_NAMES].join(", ")}`;

const SLOW = 120_000;
const runId = `live${randomBytes(5).toString("hex")}`;
const PAYER = `live-${runId}@example.com`;

const mandateFile = fileURLToPath(
  new URL("../../../packages/mandate/fixtures/kikapu-studio-v3.json", import.meta.url),
);

describe.skipIf(!live.success)(`live approvals (${needs})`, { timeout: SLOW }, () => {
  let handle: DatabaseHandle;

  beforeAll(async () => {
    handle = await createTestDatabase();
  }, SLOW);

  afterAll(async () => {
    await handle?.close();
  });

  it("decides a send_invoice step-up on a fresh draft, approves it, and sends once", async () => {
    try {
      const { db } = handle;
      const parsed = parseMandate(JSON.parse(readFileSync(mandateFile, "utf8")));
      if (!parsed.ok) throw new Error("The mandate fixture doesn't parse.");
      const rail = createPayPalClient({ env: process.env });
      const carrier = createMockCarrier(createMemoryShipmentStore(new Map()));

      const invoiceId = await rail.createDraftInvoice({
        requestId: `countersign-live-${runId}-draft`,
        recipientEmail: PAYER,
        items: [{ name: "Live check", quantity: 1, unitAmount: { minor: 100, currency: "USD" } }],
      });

      await db.execute(sql`TRUNCATE audit_log, tickets`);
      await writeTicket(db, {
        id: "TKT-LIVE",
        channel: "email",
        senderEmail: PAYER,
        senderPhone: null,
        subject: null,
        body: "Simulated ticket.",
        attachments: [],
        receivedAt: "2026-10-17T08:00:00+03:00",
        simulated: true,
      });

      const now = new Date();
      const decided = await propose({
        mandate: parsed.mandate,
        principal: "support-agent",
        proposal: {
          tool: "send_invoice",
          args: { invoice_id: invoiceId },
          justification: { ticket_id: "TKT-LIVE" },
        },
        now,
        rail,
        carrier,
        db,
      });
      if (!decided.ok || decided.replay) throw new Error("The proposal wasn't decided.");
      expect(decided.record.decision).toBe("step_up");
      const hash = decided.record.intentHash;
      if (hash === null) throw new Error("The step-up has no intent hash.");

      const answer = await answerStepUp({
        db,
        rail,
        stepUpSeq: decided.seqs.decision,
        answer: "approve",
        intentHash: hash,
        channel: "cli",
        now: new Date(),
      });
      if (answer.kind !== "answered") throw new Error(`Not answered: ${answer.kind}.`);
      expect(answer.outcome).toBe("approved");
      expect(answer.execution?.outcome).toBe("executed");
      expect(["SENT", "SCHEDULED"]).toContain(answer.execution?.invoice?.status);
      expect(answer.execution?.invoice?.id).toBe(invoiceId);

      const rows = await db.select().from(auditLog).orderBy(asc(auditLog.seq));
      const types = rows.map((row) => row.entryType);
      expect(types.filter((type) => type === "execution.requested")).toHaveLength(1);
      const results = rows.filter((row) => row.entryType === "execution.result");
      expect(results).toHaveLength(1);
      expect(JSON.parse(results[0]?.payload ?? "{}").outcome).toBe("executed");
    } catch (error) {
      if (error instanceof Error && error.name === "AssertionError") throw error;
      if (error instanceof PayPalError) throw new Error(error.message);
      throw new Error(
        `Live check failed with ${error instanceof Error ? error.name : "a non-error"}.`,
      );
    }
  });
});
