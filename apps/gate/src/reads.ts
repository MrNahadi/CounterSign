// The gate's read-only tools (ADR 0028): PayPal's names and argument shapes, answered by the rail
// client and the carrier mock, never by the Agent Toolkit. A read needs a principal key (the MCP
// route checks it) but isn't decided or written to the audit log. Records come back as the rail
// client parses them, with money in PayPal's `{ value, currency_code }`. A failed read answers one
// fixed line that holds nothing from PayPal's body and no secret. No AI.

import type { CarrierAdapter, ShipmentLookup } from "@countersign/carrier-mock";
import {
  DISPUTE_STATES,
  type PayPalClient,
  PayPalError,
  toPayPalDisplayAmount,
} from "@countersign/rail-paypal";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

// PayPal's resource IDs: 1 to 64 letters, digits or hyphens. Anything else is never sent.
const ResourceId = z.string().regex(/^[A-Za-z0-9-]{1,64}$/);

const DAY_MS = 24 * 60 * 60_000;
export const MAX_TRANSACTION_DAYS = 31;
export const DEFAULT_DISPUTE_PAGE_SIZE = 10;

// A date-time with an offset, or a plain date read as midnight UTC.
const SearchDate = z.union([z.iso.datetime({ offset: true }), z.iso.date()]);

const READS = {
  get_order: z.strictObject({ id: ResourceId }),
  get_refund: z.strictObject({ refund_id: ResourceId }),
  list_disputes: z.strictObject({
    disputed_transaction_id: ResourceId.optional(),
    dispute_state: z.enum(DISPUTE_STATES).optional(),
    page_size: z.number().int().min(1).max(50).optional(),
  }),
  get_dispute: z.strictObject({ dispute_id: ResourceId }),
  get_shipment_tracking: z.strictObject({
    order_id: ResourceId,
    transaction_id: ResourceId.optional(),
  }),
  list_transactions: z.strictObject({
    transaction_id: ResourceId.optional(),
    start_date: SearchDate.optional(),
    end_date: SearchDate.optional(),
  }),
} as const;

export type ReadTool = keyof typeof READS;

export const READ_TOOLS = Object.keys(READS) as ReadTool[];

export function isReadTool(name: string): name is ReadTool {
  return Object.hasOwn(READS, name);
}

export function readToolArguments(tool: ReadTool): z.ZodObject {
  return READS[tool];
}

const SIMULATED_CARRIER =
  "Carrier data is simulated: Countersign's carrier mock stands in for a tracking API.";

export const READ_DESCRIPTIONS: Record<ReadTool, string> = {
  get_order: "Read an order: its status, payer, amounts, captures, refunds and trackers.",
  get_refund: "Read a refund: its status, amount and the capture it refunds.",
  list_disputes:
    "List disputes. With disputed_transaction_id, every dispute on that capture; without it, the first page of the merchant's disputes (page_size, default 10), optionally in one dispute_state.",
  get_dispute: "Read a dispute: its status, amount and the captures it disputes.",
  get_shipment_tracking: `Read an order's trackers and, for each tracking number, the carrier's status and scan events. transaction_id narrows it to one capture. ${SIMULATED_CARRIER}`,
  list_transactions: `Search transactions in a range of at most ${MAX_TRANSACTION_DAYS} days (ISO 8601 start_date and end_date; default the last ${MAX_TRANSACTION_DAYS} days), optionally for one transaction_id.`,
};

export type ReadDeps = {
  rail?: () => PayPalClient;
  carrier?: CarrierAdapter;
  clock: () => Date;
};

// What each tool reads, for its failure line.
const SUBJECT: Record<ReadTool, string> = {
  get_order: "order",
  get_refund: "refund",
  list_disputes: "dispute list",
  get_dispute: "dispute",
  get_shipment_tracking: "order",
  list_transactions: "transaction search",
};

export const READ_MESSAGES = {
  unavailable: "Countersign can't reach PayPal right now, so nothing was read.",
  invalidArguments: (tool: ReadTool) =>
    `The arguments for ${tool} are invalid. Check them against the tool's input schema.`,
  badDate: "list_transactions needs ISO 8601 dates, such as 2026-10-01 or 2026-10-01T00:00:00Z.",
  badRange: `list_transactions takes a range of at most ${MAX_TRANSACTION_DAYS} days, with the end after the start.`,
  carrierFailed: "The simulated carrier lookup failed, so nothing was read.",
} as const;

// One fixed line per kind of failure. PayPal's own name, message and issues are never repeated.
export function readFailure(tool: ReadTool, error: unknown): string {
  const subject = `The ${SUBJECT[tool]} read failed`;
  if (!(error instanceof PayPalError)) return `${subject} unexpectedly.`;
  switch (error.kind) {
    case "http":
      return error.status === 404
        ? `${subject}: PayPal has no such record.`
        : `${subject}: PayPal answered HTTP ${error.status}.`;
    case "network":
      return `${subject}: PayPal couldn't be reached.`;
    case "invalid_response":
      return `${subject}: PayPal's answer couldn't be read.`;
    case "invalid_request":
      return `${subject}: the request was refused before calling PayPal.`;
  }
}

const failure = (message: string): CallToolResult => ({
  content: [{ type: "text", text: message }],
  isError: true,
});

const success = (record: Record<string, unknown>): CallToolResult => ({
  content: [{ type: "text", text: JSON.stringify(record) }],
  structuredContent: record,
  isError: false,
});

const isMoney = (value: object): value is { minor: number; currency: "USD" | "KES" } => {
  const keys = Object.keys(value);
  return (
    keys.length === 2 &&
    typeof (value as { minor?: unknown }).minor === "number" &&
    typeof (value as { currency?: unknown }).currency === "string"
  );
};

class UnshowableAmount extends Error {}

// The record as the agent sees it: every amount in PayPal's `{ value, currency_code }`.
export function showRecord(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(showRecord);
  if (value === null || typeof value !== "object") return value;
  if (isMoney(value)) {
    const amount = toPayPalDisplayAmount(value);
    if (amount === null) throw new UnshowableAmount();
    return amount;
  }
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, showRecord(item)]));
}

// The simulated carrier's answer for one tracking number, labelled simulated.
function carrierFields(lookup: ShipmentLookup): Record<string, unknown> {
  switch (lookup.kind) {
    case "found":
      return {
        carrier: "simulated",
        lookup: "found",
        carrierName: lookup.shipment.carrierName,
        status: lookup.shipment.status,
        scanEvents: lookup.shipment.scanEvents,
        updatedAt: lookup.shipment.updatedAt,
      };
    case "not_found":
      return { carrier: "simulated", lookup: "not_found" };
    case "unreadable":
      return { carrier: "simulated", lookup: "unreadable", detail: lookup.detail };
  }
}

// The range to search: the agent's dates, or the last 31 days by the gate's clock.
function transactionRange(
  args: z.infer<(typeof READS)["list_transactions"]>,
  now: Date,
): { startDate: string; endDate: string } | string {
  const end = args.end_date === undefined ? now.getTime() : Date.parse(args.end_date);
  const start =
    args.start_date === undefined
      ? end - MAX_TRANSACTION_DAYS * DAY_MS
      : Date.parse(args.start_date);
  if (Number.isNaN(start) || Number.isNaN(end)) return READ_MESSAGES.badDate;
  const span = end - start;
  if (span < 0 || span > MAX_TRANSACTION_DAYS * DAY_MS) return READ_MESSAGES.badRange;
  return { startDate: new Date(start).toISOString(), endDate: new Date(end).toISOString() };
}

class CarrierFailed extends Error {}

async function read(
  tool: ReadTool,
  args: unknown,
  rail: PayPalClient,
  deps: ReadDeps,
): Promise<Record<string, unknown> | string> {
  switch (tool) {
    case "get_order": {
      const { id } = READS.get_order.parse(args);
      return await rail.getOrder(id);
    }
    case "get_refund": {
      const { refund_id } = READS.get_refund.parse(args);
      return await rail.getRefund(refund_id);
    }
    case "list_disputes": {
      const parsed = READS.list_disputes.parse(args);
      if (parsed.disputed_transaction_id !== undefined) {
        return await rail.listDisputes(parsed.disputed_transaction_id);
      }
      return await rail.listMerchantDisputes({
        pageSize: parsed.page_size ?? DEFAULT_DISPUTE_PAGE_SIZE,
        ...(parsed.dispute_state === undefined ? {} : { disputeState: parsed.dispute_state }),
      });
    }
    case "get_dispute": {
      const { dispute_id } = READS.get_dispute.parse(args);
      return await rail.getDispute(dispute_id);
    }
    case "get_shipment_tracking": {
      const { order_id, transaction_id } = READS.get_shipment_tracking.parse(args);
      const carrier = deps.carrier;
      if (carrier === undefined) return READ_MESSAGES.carrierFailed;
      const order = await rail.getOrder(order_id);
      const trackers = order.purchaseUnits
        .flatMap((unit) => unit.trackers)
        .filter((tracker) => transaction_id === undefined || tracker.captureId === transaction_id);
      const lookups = new Map<string, Promise<ShipmentLookup>>();
      const shown = [];
      for (const tracker of trackers) {
        let lookup = lookups.get(tracker.trackingNumber);
        if (lookup === undefined) {
          lookup = carrier.getShipment(tracker.trackingNumber);
          lookups.set(tracker.trackingNumber, lookup);
        }
        const answer = await lookup.catch(() => {
          throw new CarrierFailed();
        });
        shown.push({ ...tracker, shipment: carrierFields(answer) });
      }
      return { orderId: order.id, trackers: shown };
    }
    case "list_transactions": {
      const parsed = READS.list_transactions.parse(args);
      const range = transactionRange(parsed, deps.clock());
      if (typeof range === "string") return range;
      return await rail.searchTransactions({
        ...range,
        ...(parsed.transaction_id === undefined ? {} : { transactionId: parsed.transaction_id }),
      });
    }
  }
}

/** Answers one read-only tool call. Never throws. */
export async function callRead(
  tool: ReadTool,
  args: Record<string, unknown> | undefined,
  deps: ReadDeps,
): Promise<CallToolResult> {
  const input = args ?? {};
  const checked = READS[tool].safeParse(input);
  if (!checked.success) {
    const dated =
      tool === "list_transactions" &&
      checked.error.issues.some(
        (issue) => issue.path[0] === "start_date" || issue.path[0] === "end_date",
      );
    return failure(dated ? READ_MESSAGES.badDate : READ_MESSAGES.invalidArguments(tool));
  }
  if (deps.rail === undefined) return failure(READ_MESSAGES.unavailable);
  let rail: PayPalClient;
  try {
    rail = deps.rail();
  } catch {
    return failure(READ_MESSAGES.unavailable);
  }
  try {
    const record = await read(tool, input, rail, deps);
    if (typeof record === "string") return failure(record);
    return success(showRecord(record) as Record<string, unknown>);
  } catch (error) {
    if (error instanceof CarrierFailed) return failure(READ_MESSAGES.carrierFailed);
    if (error instanceof UnshowableAmount) return failure(readFailure(tool, null));
    return failure(readFailure(tool, error));
  }
}
