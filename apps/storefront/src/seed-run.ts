// A seed run: creates the seed catalog's orders as real sandbox orders paid by the two seed
// buyers, adds each one's tracker, reads it back, and records its shipment and seed row
// (ADR 0023). Rerunning the same run ID resumes it rather than repeating it.

import { createDatabaseShipmentStore } from "@countersign/carrier-mock";
import { type Database, eq, seedOrders } from "@countersign/db";
import {
  formatMoney,
  type Money,
  SHIPMENT_STATUSES,
  type ShipmentStatus,
  TimestampSchema,
} from "@countersign/mandate";
import { type PayPalClient, PayPalError, type PayPalOrder } from "@countersign/rail-paypal";
import { z } from "zod";
import {
  buildDemoShipment,
  CARRIER_NAME,
  type DemoOrder,
  productFor,
  RunIdSchema,
  type SeedBuyer,
  trackingNumberFor,
} from "./seed-catalog";

export const SAME_BUYER_PROBLEM = "Buyers A and B are the same PayPal account";

/** The most demo orders in flight at once, to stay inside sandbox rate limits. */
export const SEED_CONCURRENCY = 3;

export type SeedRunInput = {
  paypal: PayPalClient;
  db: Database;
  /** The seed catalog. */
  orders: readonly DemoOrder[];
  runId: string;
  /** Vault payment tokens for seed buyers A and B. Never reported. */
  vaultTokens: Readonly<Record<SeedBuyer, string>>;
  /** The time of seeding, as an ISO 8601 timestamp. Read once per run. */
  clock: () => string;
  /** One line on why the rows couldn't be written, with no secret in it. */
  databaseReason?: (error: unknown) => string;
};

export type SeedFailure = {
  orderNumber: string;
  /** The step that failed: create-order, add-tracker, get-order or write-rows. */
  call: string;
  reason: string;
  debugId: string | null;
};

export type SeedReport = {
  runId: string;
  /** Orders in the catalog. */
  total: number;
  /** Orders this run has seeded, earlier attempts included. */
  seeded: number;
  /** Seeded orders by shipment status. */
  counts: Record<ShipmentStatus, number>;
  /** In order number order. */
  failures: SeedFailure[];
  /** A problem that fails the whole run, such as both buyers being one account. */
  problem: string | null;
};

// Why a seed run can't start, or null when it can. Names what's wrong, never a value.
function inputProblem(runId: string, vaultTokens: SeedRunInput["vaultTokens"], seededAt: string) {
  if (!RunIdSchema.safeParse(runId).success)
    return "The run ID must be 4 to 24 lowercase letters and digits.";
  for (const buyer of ["A", "B"] as const) {
    if (!z.string().min(1).safeParse(vaultTokens[buyer]).success)
      return `The vault token for buyer ${buyer} is missing.`;
  }
  if (!TimestampSchema.safeParse(seededAt).success)
    return "The seeding time isn't an ISO 8601 timestamp.";
  return null;
}

// A seed row read back from `seed_orders`. One that fails this is treated as not seeded.
const StoredRowSchema = z.object({
  orderNumber: z.string().regex(/^KIK-\d{4}$/),
  runId: RunIdSchema,
  paypalOrderId: z.string().min(1),
  paypalCaptureId: z.string().min(1),
  amountMinor: z.number().int().positive(),
  currency: z.string().min(1),
  payerEmail: z.string().min(1),
  buyer: z.enum(["A", "B"]),
  trackingNumber: z.string().min(1),
  role: z.string().min(1),
  seededAt: TimestampSchema,
});

// A response that came back but doesn't show what the seed needs.
class SeedCheckError extends Error {}

const sameMoney = (a: Money, b: Money) => a.minor === b.minor && a.currency === b.currency;
const plural = (n: number, word: string) => (n === 1 ? `1 ${word}` : `${n} ${word}s`);

/** Checks a vault order's create answer, returning its capture ID and payer email. */
function checkCreated(order: PayPalOrder, demo: DemoOrder, price: Money) {
  if (order.status !== "COMPLETED")
    throw new SeedCheckError(`returned order status ${order.status}`);
  const [unit, ...more] = order.purchaseUnits;
  if (!unit || more.length > 0)
    throw new SeedCheckError(`returned ${plural(order.purchaseUnits.length, "purchase unit")}`);
  if (unit.referenceId !== demo.orderNumber)
    throw new SeedCheckError("returned an order for another reference ID");
  const [capture, ...others] = unit.captures;
  if (!capture || others.length > 0)
    throw new SeedCheckError(`returned ${plural(unit.captures.length, "capture")}`);
  if (capture.status !== "COMPLETED")
    throw new SeedCheckError(`returned capture status ${capture.status}`);
  if (!sameMoney(capture.amount, price))
    throw new SeedCheckError(
      `returned a capture for ${formatMoney(capture.amount)}, not ${formatMoney(price)}`,
    );
  if (!order.payerEmail) throw new SeedCheckError("returned no payer email");
  return { captureId: capture.id, amount: capture.amount, payerEmail: order.payerEmail };
}

const trackerId = (captureId: string, trackingNumber: string) => `${captureId}-${trackingNumber}`;

function hasShippedTracker(order: PayPalOrder, captureId: string, trackingNumber: string) {
  const id = trackerId(captureId, trackingNumber);
  return order.purchaseUnits.some((unit) =>
    unit.trackers.some((tracker) => tracker.id === id && tracker.status === "SHIPPED"),
  );
}

/** Checks the read-back: the capture still COMPLETED, and the SHIPPED tracker (spike S2). */
function checkReadBack(order: PayPalOrder, captureId: string, trackingNumber: string) {
  const capture = order.purchaseUnits
    .flatMap((unit) => unit.captures)
    .find((c) => c.id === captureId);
  if (!capture) throw new SeedCheckError("doesn't show the capture");
  if (capture.status !== "COMPLETED")
    throw new SeedCheckError(`shows capture status ${capture.status}`);
  if (!hasShippedTracker(order, captureId, trackingNumber))
    throw new SeedCheckError("doesn't show a SHIPPED tracker for the capture");
}

function paypalReason(error: PayPalError): string {
  let reason = error.message;
  if (reason.startsWith(`${error.call} `)) reason = reason.slice(error.call.length + 1);
  if (error.debugId) reason = reason.replace(` Debug ID ${error.debugId}.`, "");
  return reason.trim().replace(/\.$/, "");
}

/**
 * Runs one seed run over the catalog, in order number order, with at most 3 orders in flight.
 * One order failing doesn't stop the others. Throws, before any call, on a malformed run ID,
 * a missing vault token or an unreadable seeding time.
 */
export async function runSeed(input: SeedRunInput): Promise<SeedReport> {
  const { paypal, db, runId, vaultTokens } = input;
  const seededAt = input.clock();
  const refusal = inputProblem(runId, vaultTokens, seededAt);
  if (refusal) throw new Error(refusal);
  const catalog = [...input.orders].sort((a, b) => a.orderNumber.localeCompare(b.orderNumber));

  const seeded = new Set<string>();
  const emails: Record<SeedBuyer, Set<string>> = { A: new Set(), B: new Set() };
  const failures: SeedFailure[] = [];
  let problem: string | null = null;

  const notePayer = (buyer: SeedBuyer, email: string) => {
    const key = email.trim().toLowerCase();
    emails[buyer].add(key);
    if (emails[buyer === "A" ? "B" : "A"].has(key)) problem = SAME_BUYER_PROBLEM;
  };

  // Step 1: what this run has already seeded.
  const stored = await db.select().from(seedOrders).where(eq(seedOrders.runId, runId));
  for (const demo of catalog) {
    const row = StoredRowSchema.safeParse(stored.find((r) => r.orderNumber === demo.orderNumber));
    if (
      row.success &&
      row.data.buyer === demo.buyer &&
      row.data.trackingNumber === trackingNumberFor(runId, demo.orderNumber)
    ) {
      seeded.add(demo.orderNumber);
      notePayer(demo.buyer, row.data.payerEmail);
    }
  }

  async function seedOne(demo: DemoOrder): Promise<void> {
    const product = productFor(demo);
    const trackingNumber = trackingNumberFor(runId, demo.orderNumber);
    const requestId = (step: string) => `countersign-seed-${runId}-${demo.orderNumber}-${step}`;
    let call = "create-order";
    try {
      // Step 2: the order, paid by the seed buyer's vault token and captured in the same call.
      const created = await paypal.createOrder({
        requestId: requestId("create"),
        referenceId: demo.orderNumber,
        customId: runId,
        invoiceId: `${demo.orderNumber}-${runId}`,
        items: [{ name: product.name, sku: product.id, quantity: 1, unitAmount: product.price }],
        vaultId: vaultTokens[demo.buyer],
      });
      const { captureId, amount, payerEmail } = checkCreated(created, demo, product.price);
      notePayer(demo.buyer, payerEmail);
      if (problem) return;

      // Step 3: the tracker, unless the order already shows it.
      call = "add-tracker";
      if (!hasShippedTracker(created, captureId, trackingNumber)) {
        await paypal.addTracker(created.id, {
          requestId: requestId("track"),
          captureId,
          trackingNumber,
          carrierName: CARRIER_NAME,
        });
      }

      // Step 4: read the order back.
      call = "get-order";
      checkReadBack(await paypal.getOrder(created.id), captureId, trackingNumber);

      // Step 5: the shipment and the seed row, together or not at all.
      call = "write-rows";
      const row = {
        orderNumber: demo.orderNumber,
        runId,
        paypalOrderId: created.id,
        paypalCaptureId: captureId,
        amountMinor: amount.minor,
        currency: amount.currency,
        payerEmail,
        buyer: demo.buyer,
        trackingNumber,
        role: demo.role,
        seededAt,
      };
      const { orderNumber: _, ...replacement } = row;
      await db.transaction(async (tx) => {
        await createDatabaseShipmentStore(tx).write(buildDemoShipment(demo, { runId, seededAt }));
        await tx
          .insert(seedOrders)
          .values(row)
          .onConflictDoUpdate({ target: seedOrders.orderNumber, set: replacement });
      });
      seeded.add(demo.orderNumber);
    } catch (error) {
      failures.push(describeFailure(demo.orderNumber, call, error));
    }
  }

  function describeFailure(orderNumber: string, call: string, error: unknown): SeedFailure {
    if (error instanceof PayPalError) {
      return { orderNumber, call: error.call, reason: paypalReason(error), debugId: error.debugId };
    }
    if (error instanceof SeedCheckError) {
      return { orderNumber, call, reason: error.message, debugId: null };
    }
    const reason =
      call === "write-rows"
        ? (input.databaseReason?.(error) ?? "the shipment and seed row couldn't be written")
        : "failed unexpectedly";
    return { orderNumber, call, reason, debugId: null };
  }

  const queue = catalog.filter((demo) => !seeded.has(demo.orderNumber));
  let next = 0;
  const worker = async () => {
    while (!problem && next < queue.length) {
      const demo = queue[next];
      next += 1;
      if (demo) await seedOne(demo);
    }
  };
  await Promise.all(Array.from({ length: Math.min(SEED_CONCURRENCY, queue.length) }, worker));

  const counts = Object.fromEntries(SHIPMENT_STATUSES.map((status) => [status, 0])) as Record<
    ShipmentStatus,
    number
  >;
  for (const demo of catalog) if (seeded.has(demo.orderNumber)) counts[demo.status] += 1;
  failures.sort((a, b) => a.orderNumber.localeCompare(b.orderNumber));

  return { runId, total: catalog.length, seeded: seeded.size, counts, failures, problem };
}
