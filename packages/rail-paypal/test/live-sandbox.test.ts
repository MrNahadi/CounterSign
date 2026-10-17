// Live check that the client's schemas parse real PayPal sandbox responses, not just the
// recorded fixtures. Runs only under LIVE=1 with the three PAYPAL_* variables set, so
// `npm test` never calls PayPal. Nothing here prints a secret: PayPal errors are reduced to
// the client's own scrubbed message, and the leak check asserts a boolean, never a value.

import { randomBytes } from "node:crypto";
import {
  createPayPalClient,
  PAYPAL_ENV_NAMES,
  type PayPalClient,
  PayPalError,
} from "@countersign/rail-paypal";
import { describe, expect, it } from "vitest";
import { z } from "zod";

const VAULT_ENV_NAME = "PAYPAL_SEED_VAULT_TOKEN";

const present = z.string().min(1);
const LiveEnvSchema = z.object({
  LIVE: z.literal("1"),
  PAYPAL_BASE_URL: present,
  PAYPAL_CLIENT_ID: present,
  PAYPAL_CLIENT_SECRET: present,
});

const live = LiveEnvSchema.safeParse(process.env);
const vaultToken = present.safeParse(process.env[VAULT_ENV_NAME]);
const vault = live.success && vaultToken.success;

const ONE_DOLLAR = { minor: 100, currency: "USD" } as const;
const ORDER_NUMBER = "KIK-LIVE";
const CARRIER_NAME = "Kisumu Couriers (simulated)";

// A fresh run-style ID per test run, so request IDs never replay an earlier run's answers.
const runId = `live${randomBytes(5).toString("hex")}`;
const requestId = (step: string) => `countersign-seed-${runId}-${ORDER_NUMBER}-${step}`;

const needs = `needs ${["LIVE=1", ...PAYPAL_ENV_NAMES].join(", ")}`;

const secrets = (): string[] =>
  [process.env.PAYPAL_CLIENT_SECRET, process.env[VAULT_ENV_NAME]].filter(
    (value): value is string => typeof value === "string" && value.length > 0,
  );

// Fails with a fixed message if any secret appears in what the test would print.
function expectNoSecrets(value: unknown): void {
  const text = JSON.stringify(value) ?? "";
  const leaked = secrets().some((secret) => text.includes(secret));
  expect(leaked, "a secret appeared in a record").toBe(false);
}

// PayPal errors keep only the client's scrubbed message. Assertion failures carry only
// response values, so they pass through for their diff. Anything else is named, not shown.
const redacted = (error: unknown): Error => {
  if (error instanceof Error && error.name === "AssertionError") return error;
  if (error instanceof PayPalError) return new Error(error.message);
  return new Error(
    `Live check failed with ${error instanceof Error ? error.name : "a non-error"}.`,
  );
};

async function guarded(check: () => Promise<void>): Promise<void> {
  try {
    await check();
  } catch (error) {
    throw redacted(error);
  }
}

const client = (): PayPalClient => createPayPalClient({ env: process.env });

describe.skipIf(!live.success)(`live PayPal sandbox (${needs})`, () => {
  it("creates an order awaiting approval with client credentials and reads it back", async () => {
    await guarded(async () => {
      const paypal = client();
      const created = await paypal.createOrder({
        requestId: requestId("approval"),
        referenceId: `${ORDER_NUMBER}-APPROVAL`,
        customId: runId,
        invoiceId: `${ORDER_NUMBER}-APPROVAL-${runId}`,
        items: [{ name: "Live check", sku: "live-check", quantity: 1, unitAmount: ONE_DOLLAR }],
      });
      expect(["CREATED", "PAYER_ACTION_REQUIRED"]).toContain(created.status);

      const read = await paypal.getOrder(created.id);
      expect(read.id).toBe(created.id);
      expect(read.status).toBe(created.status);
      expect(read.purchaseUnits).toHaveLength(1);
      expect(read.purchaseUnits[0]?.referenceId).toBe(`${ORDER_NUMBER}-APPROVAL`);
      expect(read.purchaseUnits[0]?.customId).toBe(runId);
      expect(read.purchaseUnits[0]?.amount).toEqual(ONE_DOLLAR);
      expect(read.purchaseUnits[0]?.captures).toEqual([]);
      expectNoSecrets([created, read]);
    });
  }, 60_000);

  it.skipIf(!vault)(
    `captures, tracks and reads back one $1.00 vault order (needs ${VAULT_ENV_NAME})`,
    async () => {
      await guarded(async () => {
        if (!vaultToken.success) throw new Error(`${VAULT_ENV_NAME} is missing.`);
        const paypal = client();
        const trackingNumber = `KC-${runId}-LIVE`;

        const created = await paypal.createOrder({
          requestId: requestId("create"),
          referenceId: ORDER_NUMBER,
          customId: runId,
          invoiceId: `${ORDER_NUMBER}-${runId}`,
          items: [{ name: "Live check", sku: "live-check", quantity: 1, unitAmount: ONE_DOLLAR }],
          vaultId: vaultToken.data,
        });
        expect(created.status).toBe("COMPLETED");
        expect(created.payerEmail).toBeTypeOf("string");
        const capture = created.purchaseUnits[0]?.captures[0];
        expect(capture?.status).toBe("COMPLETED");
        expect(capture?.amount).toEqual(ONE_DOLLAR);
        if (!capture) throw new Error("The vault order has no capture.");

        await paypal.addTracker(created.id, {
          requestId: requestId("track"),
          captureId: capture.id,
          trackingNumber,
          carrierName: CARRIER_NAME,
        });

        const read = await paypal.getOrder(created.id);
        expect(read.status).toBe("COMPLETED");
        const unit = read.purchaseUnits[0];
        expect(unit?.referenceId).toBe(ORDER_NUMBER);
        expect(unit?.captures.map((c) => [c.id, c.status])).toEqual([[capture.id, "COMPLETED"]]);
        const tracker = unit?.trackers.find((t) => t.trackingNumber === trackingNumber);
        expect(tracker?.id).toBe(`${capture.id}-${trackingNumber}`);
        expect(tracker?.captureId).toBe(capture.id);
        expect(tracker?.status).toBe("SHIPPED");

        const readCapture = await paypal.getCapture(capture.id);
        expect(readCapture.status).toBe("COMPLETED");
        expect(readCapture.amount).toEqual(ONE_DOLLAR);
        expect(readCapture.orderId).toBe(created.id);
        expectNoSecrets([created, read, readCapture]);
      });
    },
    60_000,
  );
});
