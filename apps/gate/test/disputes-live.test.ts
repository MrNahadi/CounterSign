import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createMemoryShipmentStore, createMockCarrier } from "@countersign/carrier-mock";
import {
  asc,
  auditLog,
  createTestDatabase,
  type DatabaseHandle,
  readEvidenceDocument,
  sha256Hex,
  sql,
} from "@countersign/db";
import { parseMandate } from "@countersign/mandate";
import { createPayPalClient, PAYPAL_ENV_NAMES, PayPalError } from "@countersign/rail-paypal";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { answerStepUp } from "../src/answer-step-up";
import { buildEvidencePack } from "../src/dispute-evidence";
import { propose } from "../src/propose";

// Live checks of spike S3 against the PayPal sandbox. With LIVE=1 and the PayPal variables, the
// merchant's disputes are listed and one is read. With PAYPAL_LIVE_DISPUTE_ID too, that sandbox
// dispute is moved along: require evidence, build the pack from records, propose
// provide_dispute_evidence, approve the step-up through answerStepUp() so the PDF is sent once,
// then adjudicate SELLER_FAVOR. `npm test` never calls PayPal. Nothing here prints a secret:
// failures are reduced to a fixed message.

const present = z.string().min(1);
const PayPalEnvSchema = z.object({
  LIVE: z.literal("1"),
  PAYPAL_BASE_URL: present,
  PAYPAL_CLIENT_ID: present,
  PAYPAL_CLIENT_SECRET: present,
});
const DisputeEnvSchema = PayPalEnvSchema.extend({
  PAYPAL_LIVE_DISPUTE_ID: z.string().regex(/^[A-Za-z0-9-]{1,64}$/),
});
const paypal = PayPalEnvSchema.safeParse(process.env);
const dispute = DisputeEnvSchema.safeParse(process.env);
const needs = (names: string[]) => `needs ${["LIVE=1", ...PAYPAL_ENV_NAMES, ...names].join(", ")}`;

const SLOW = 180_000;
const NOTE = "Countersign's records for this payment are attached. Live sandbox check.";

const mandateFile = fileURLToPath(
  new URL("../../../packages/mandate/fixtures/kikapu-studio-v3.json", import.meta.url),
);

// Rethrows assertions as they are; anything else becomes a message with no secret in it.
async function guarded(check: () => Promise<void>): Promise<void> {
  try {
    await check();
  } catch (error) {
    if (error instanceof Error && error.name === "AssertionError") throw error;
    if (error instanceof PayPalError) throw new Error(error.message);
    throw new Error(
      `Live check failed with ${error instanceof Error ? error.name : "a non-error"}.`,
    );
  }
}

describe.skipIf(!paypal.success)(`live disputes read (${needs([])})`, { timeout: SLOW }, () => {
  it("lists the merchant's disputes and reads one", async () => {
    await guarded(async () => {
      const rail = createPayPalClient({ env: process.env });
      const list = await rail.listMerchantDisputes({ pageSize: 10 });
      const first = list.disputes[0];
      if (first === undefined) return;
      const detail = await rail.getDispute(first.id);
      expect(detail.id).toBe(first.id);
      expect(Number.isInteger(detail.amount.minor)).toBe(true);
    });
  });
});

describe.skipIf(!dispute.success)(
  `live dispute evidence (${needs(["PAYPAL_LIVE_DISPUTE_ID"])})`,
  { timeout: SLOW },
  () => {
    let handle: DatabaseHandle;

    beforeAll(async () => {
      handle = await createTestDatabase();
    }, SLOW);

    afterAll(async () => {
      await handle?.close();
    });

    it("requires evidence, sends the approved pack with its PDF once, and adjudicates", async () => {
      await guarded(async () => {
        if (!dispute.success) throw new Error("No live dispute.");
        const disputeId = dispute.data.PAYPAL_LIVE_DISPUTE_ID;
        const { db } = handle;
        const parsed = parseMandate(JSON.parse(readFileSync(mandateFile, "utf8")));
        if (!parsed.ok) throw new Error("The mandate fixture doesn't parse.");
        const rail = createPayPalClient({ env: process.env });
        // No seeded shipments here, so the carrier facts say "Not available".
        const carrier = createMockCarrier(createMemoryShipmentStore(new Map()));
        await db.execute(sql`TRUNCATE audit_log, evidence_documents`);

        expect(await rail.requireEvidence({ disputeId, action: "SELLER_EVIDENCE" })).toBe(200);

        const pack = await buildEvidencePack(disputeId, { db, rail, carrier, now: new Date() });
        if (!pack.ok) throw new Error(`The pack wasn't built: ${pack.code}.`);
        const pdf = pack.documents.find((document) => document.kind === "pdf");
        if (pdf === undefined) throw new Error("The pack has no PDF.");
        expect(pdf.size).toBeLessThan(1024 * 1024);

        const decided = await propose({
          mandate: parsed.mandate,
          principal: "support-agent",
          proposal: {
            tool: "provide_dispute_evidence",
            args: {
              dispute_id: disputeId,
              evidence: pack.suggested.map((item) => ({
                evidence_type: item.evidenceType,
                notes: NOTE,
                ...(item.trackingNumbers.length > 0
                  ? { tracking_numbers: item.trackingNumbers }
                  : {}),
                ...(item.refundIds.length > 0 ? { refund_ids: item.refundIds } : {}),
              })),
              document_ids: [pdf.id],
            },
          },
          now: new Date(),
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
        // PayPal took the PDF: a 2xx to the multipart provide-evidence call.
        expect(answer.execution?.outcome).toBe("executed");
        expect(answer.execution?.dispute?.id).toBe(disputeId);
        const stored = await readEvidenceDocument(db, pdf.id);
        expect(stored && sha256Hex(stored.bytes)).toBe(pdf.sha256);

        const rows = await db.select().from(auditLog).orderBy(asc(auditLog.seq));
        expect(rows.filter((row) => row.entryType === "execution.requested")).toHaveLength(1);
        expect(rows.filter((row) => row.entryType === "execution.result")).toHaveLength(1);

        expect(await rail.adjudicate({ disputeId, outcome: "SELLER_FAVOR" })).toBe(200);
      });
    });
  },
);
