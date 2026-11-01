import { randomUUID } from "node:crypto";
import { createTestDatabase, type DatabaseHandle, eq, seedOrders } from "@countersign/db";
import { createPayPalClient, PAYPAL_ENV_NAMES, PayPalError } from "@countersign/rail-paypal";
import { VAULT_ENV_NAMES } from "@countersign/seed";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { RESET_COOLDOWN_MS, type ResetReport, resetDemo } from "../src/demo-reset";

// The live check of the demo reset (live check 1). With LIVE=1, the PayPal variables and both
// seed vault tokens, three resets run against the sandbox and a fresh in-memory database, with
// the real rail client and the real seed run:
//   1. the first replaces all 30 orders and is complete;
//   2. the second keeps all 30;
//   3. after a $1.00 refund on KIK-1013's capture, the third replaces exactly KIK-1013.
// Each `took_ms` is logged. `npm test` never calls PayPal. Nothing here prints a secret: failures
// are reduced to a fixed message, and only counts, order numbers and times are logged.

const present = z.string().min(1);
const LiveEnvSchema = z.object({
  LIVE: z.literal("1"),
  PAYPAL_BASE_URL: present,
  PAYPAL_CLIENT_ID: present,
  PAYPAL_CLIENT_SECRET: present,
  PAYPAL_SEED_VAULT_TOKEN: present,
  PAYPAL_SEED_VAULT_TOKEN_B: present,
});
const live = LiveEnvSchema.safeParse(process.env);
const needs = `needs ${["LIVE=1", ...PAYPAL_ENV_NAMES, ...VAULT_ENV_NAMES].join(", ")}`;

const SLOW = 180_000;
const ORDER_COUNT = 30;
const REFUNDED_ORDER = "KIK-1013";

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

describe.skipIf(!live.success)(`live demo reset (${needs})`, { timeout: SLOW }, () => {
  let handle: DatabaseHandle | undefined;

  beforeAll(async () => {
    handle = await createTestDatabase();
  }, SLOW);

  afterAll(async () => {
    await handle?.close();
  });

  it("replaces 30, keeps 30, then replaces only the refunded order", async () => {
    await guarded(async () => {
      if (!handle) throw new Error("No database.");
      const { db } = handle;
      const rail = createPayPalClient({ env: process.env });
      // Real time plus an offset that moves 61 seconds past the cooldown after each reset, so
      // `took_ms` stays the real wall time.
      let offsetMs = 0;
      const clock = () => new Date(Date.now() + offsetMs);
      const run = async (label: string): Promise<ResetReport> => {
        const result = await resetDemo({
          db,
          rail: () => rail,
          env: process.env,
          clock,
          // Nobody listens for the nudge here.
          nudgeFetch: async () => ({ ok: false }),
        });
        if (!result.ok) throw new Error(`The ${label} reset was refused: ${result.message}`);
        console.log(`${label} reset: took_ms=${result.report.tookMs}`);
        offsetMs += RESET_COOLDOWN_MS + 1_000;
        return result.report;
      };

      const first = await run("first");
      expect(first.orders.failed).toEqual([]);
      expect(first.orders.replaced).toHaveLength(ORDER_COUNT);
      expect(first.orders.kept).toBe(0);
      expect(first.cleared).not.toBeNull();
      expect(first.complete).toBe(true);

      const second = await run("second");
      expect(second.orders.failed).toEqual([]);
      expect(second.orders.replaced).toEqual([]);
      expect(second.orders.kept).toBe(ORDER_COUNT);
      expect(second.complete).toBe(true);

      const [row] = await db
        .select()
        .from(seedOrders)
        .where(eq(seedOrders.orderNumber, REFUNDED_ORDER));
      if (!row) throw new Error(`${REFUNDED_ORDER} isn't seeded.`);
      await rail.refundCapture({
        requestId: `live-reset-${randomUUID()}`,
        captureId: row.paypalCaptureId,
        amount: { minor: 100, currency: "USD" },
        customId: "live-reset-check",
      });

      const third = await run("third");
      expect(third.orders.failed).toEqual([]);
      expect(third.orders.replaced).toEqual([REFUNDED_ORDER]);
      expect(third.orders.kept).toBe(ORDER_COUNT - 1);
      expect(third.complete).toBe(true);
    });
  });
});
