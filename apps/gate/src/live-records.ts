// Live records: what each guarded action is decided on, read from the PayPal sandbox, the carrier
// and the ticket store, and mapped into the verifiers' snapshots (brief §6 step 3). A refund reads
// its capture, order, disputes and shipment; a dispute action its dispute; an invoice send its
// invoice; an order capture its order; a payout nothing; and every action its ticket. Fail closed:
// a read that fails, or a record that can't be mapped, leaves its snapshot out, so the verifiers
// that need it return unknown. Reading never throws; each failed read is one line for the CLI.

import type { CarrierAdapter } from "@countersign/carrier-mock";
import { type Database, readTicket } from "@countersign/db";
import { IdSchema } from "@countersign/mandate";
import {
  type PayPalClient,
  PayPalError,
  type PayPalOrder,
  refundedTotal,
} from "@countersign/rail-paypal";
import {
  CALLS,
  type CaptureSnapshot,
  type DisputeRecordSnapshot,
  type DisputesSnapshot,
  type InvoiceSnapshot,
  type OrderSnapshot,
  type RecordSnapshots,
  type ShipmentSnapshot,
  type TicketSnapshot,
} from "@countersign/verifiers";
import { z } from "zod";

// The reads the gate makes, named as the rail client names its calls.
export const READ_CALLS = {
  capture: "get-capture",
  order: "get-order",
  disputes: "list-disputes",
  dispute: "get-dispute",
  invoice: "get-invoice",
  shipment: "carrier-shipment",
  ticket: "ticket-store",
} as const;

// One read that failed: the call, and a one-line message that never holds a credential.
export type ReadProblem = { call: string; message: string };

export type LiveRecords = { records: RecordSnapshots; problems: ReadProblem[] };

export type LiveRecordsInput = {
  captureId: string;
  rail: Pick<PayPalClient, "getCapture" | "getOrder" | "listDisputes">;
  carrier: CarrierAdapter;
};

// PayPal's tracker status for a parcel that's on its way. The other is CANCELLED.
const SHIPPED = "SHIPPED";

const oneLine = (text: string): string => text.replace(/\s+/g, " ").trim();

// A rail error's message is already scrubbed of credentials by the client. Anything else could
// hold anything, so only a fixed line is kept.
function failed(call: string, error: unknown): ReadProblem {
  if (error instanceof PayPalError) return { call, message: oneLine(error.message) };
  return { call, message: `${call} failed unexpectedly.` };
}

function orderSnapshot(order: PayPalOrder): OrderSnapshot {
  return {
    call: CALLS.order,
    id: order.id,
    payerEmail: order.payerEmail,
    trackers: order.purchaseUnits.flatMap((unit) =>
      unit.trackers.map((tracker) => ({
        id: tracker.id,
        trackingNumber: tracker.trackingNumber,
        status: tracker.status,
      })),
    ),
  };
}

// A record read by its ID that came back with another ID proves nothing about the one asked for.
function wrongId(call: string, kind: string, got: string, wanted: string): ReadProblem {
  return { call, message: `${call} returned ${kind} ${got}, not ${wanted}.` };
}

/** Reads one dispute by its ID, for the dispute actions. */
export async function readDisputeRecord(
  rail: Pick<PayPalClient, "getDispute">,
  disputeId: string,
): Promise<LiveRecords> {
  const call = READ_CALLS.dispute;
  try {
    const dispute = await rail.getDispute(disputeId);
    if (dispute.id !== disputeId) {
      return { records: {}, problems: [wrongId(call, "dispute", dispute.id, disputeId)] };
    }
    const snapshot: DisputeRecordSnapshot = {
      call: CALLS.dispute,
      id: dispute.id,
      status: dispute.status,
      amount: { minor: dispute.amount.minor, currency: dispute.amount.currency },
    };
    return { records: { disputeRecords: [snapshot] }, problems: [] };
  } catch (error) {
    return { records: {}, problems: [failed(call, error)] };
  }
}

/** Reads one invoice by its ID, for sending it. */
export async function readInvoiceRecord(
  rail: Pick<PayPalClient, "getInvoice">,
  invoiceId: string,
): Promise<LiveRecords> {
  const call = READ_CALLS.invoice;
  try {
    const invoice = await rail.getInvoice(invoiceId);
    if (invoice.id !== invoiceId) {
      return { records: {}, problems: [wrongId(call, "invoice", invoice.id, invoiceId)] };
    }
    const snapshot: InvoiceSnapshot = {
      call: CALLS.invoice,
      id: invoice.id,
      status: invoice.status,
      amount: { minor: invoice.amount.minor, currency: invoice.amount.currency },
    };
    return { records: { invoices: [snapshot] }, problems: [] };
  } catch (error) {
    return { records: {}, problems: [failed(call, error)] };
  }
}

/** Reads one order by its ID with each purchase unit's amount, for capturing it. */
export async function readOrderRecord(
  rail: Pick<PayPalClient, "getOrder">,
  orderId: string,
): Promise<LiveRecords> {
  const call = READ_CALLS.order;
  try {
    const order = await rail.getOrder(orderId);
    if (order.id !== orderId) {
      return { records: {}, problems: [wrongId(call, "order", order.id, orderId)] };
    }
    const snapshot: OrderSnapshot = {
      ...orderSnapshot(order),
      amounts: order.purchaseUnits.map((unit) => ({
        minor: unit.amount.minor,
        currency: unit.amount.currency,
      })),
    };
    return { records: { orders: [snapshot] }, problems: [] };
  } catch (error) {
    return { records: {}, problems: [failed(call, error)] };
  }
}

/**
 * Reads the ticket a proposal names from the ticket store (ADR 0029). An unknown ID leaves the
 * snapshot out with no problem; a failed read leaves it out with one.
 */
export async function readTicketRecord(db: Database, ticketId: string): Promise<LiveRecords> {
  try {
    const ticket = await readTicket(db, ticketId);
    if (ticket === null) return { records: {}, problems: [] };
    const snapshot: TicketSnapshot = {
      call: CALLS.ticket,
      id: ticket.id,
      senderEmail: ticket.senderEmail,
      attachments: ticket.attachments.map(({ id, contentType }) => ({ id, contentType })),
    };
    return { records: { ticket: snapshot }, problems: [] };
  } catch {
    // A fixed line, so nothing the database error carries leaks.
    const call = READ_CALLS.ticket;
    return {
      records: {},
      problems: [{ call, message: `The ticket store read for ${ticketId} failed.` }],
    };
  }
}

// Only what's needed to know which records to read. A proposal without a readable ID reads
// nothing for it, and normalizing denies it.
const Named = z.object({ tool: z.string(), args: z.record(z.string(), z.unknown()) });
const NamedTicket = z.object({ justification: z.object({ ticket_id: IdSchema }) });

function idIn(args: Record<string, unknown>, key: string): string | null {
  const parsed = IdSchema.safeParse(args[key]);
  return parsed.success ? parsed.data : null;
}

export type ProposalRecordsInput = {
  proposal: unknown;
  rail: Pick<
    PayPalClient,
    "getCapture" | "getOrder" | "listDisputes" | "getDispute" | "getInvoice"
  >;
  carrier: CarrierAdapter;
  db: Database;
};

// The target's reads, by the proposal's tool.
async function readTargetRecords(
  proposal: unknown,
  rail: ProposalRecordsInput["rail"],
  carrier: CarrierAdapter,
): Promise<LiveRecords> {
  const named = Named.safeParse(proposal);
  if (!named.success) return { records: {}, problems: [] };
  const { tool, args } = named.data;
  const none: LiveRecords = { records: {}, problems: [] };
  switch (tool) {
    case "create_refund": {
      const captureId = idIn(args, "capture_id");
      return captureId === null ? none : readLiveRecords({ captureId, rail, carrier });
    }
    case "accept_dispute_claim":
    case "provide_dispute_evidence":
    case "make_offer": {
      const disputeId = idIn(args, "dispute_id");
      return disputeId === null ? none : readDisputeRecord(rail, disputeId);
    }
    case "send_invoice": {
      const invoiceId = idIn(args, "invoice_id");
      return invoiceId === null ? none : readInvoiceRecord(rail, invoiceId);
    }
    case "pay_order": {
      const orderId = idIn(args, "id");
      return orderId === null ? none : readOrderRecord(rail, orderId);
    }
    // A payout's amount and payee are the agent's own, so there's nothing to read.
    default:
      return none;
  }
}

/**
 * Every live read a proposal needs, by its tool, plus the ticket its justification names. Never
 * throws; each failed read leaves its snapshot out and adds one problem.
 */
export async function readProposalRecords(input: ProposalRecordsInput): Promise<LiveRecords> {
  const { proposal, rail, carrier, db } = input;
  const target = await readTargetRecords(proposal, rail, carrier);
  const named = NamedTicket.safeParse(proposal);
  if (!named.success) return target;
  const ticket = await readTicketRecord(db, named.data.justification.ticket_id);
  return {
    records: { ...target.records, ...ticket.records },
    problems: [...target.problems, ...ticket.problems],
  };
}

export async function readLiveRecords(input: LiveRecordsInput): Promise<LiveRecords> {
  const { captureId, rail, carrier } = input;
  const problems: ReadProblem[] = [];
  const records: RecordSnapshots = {};

  // 1. The capture, for its status, amount and order ID.
  let capture: Awaited<ReturnType<typeof rail.getCapture>> | null = null;
  try {
    capture = await rail.getCapture(captureId);
  } catch (error) {
    problems.push(failed(READ_CALLS.capture, error));
  }
  if (capture && capture.id !== captureId) {
    problems.push({
      call: READ_CALLS.capture,
      message: `${READ_CALLS.capture} returned capture ${capture.id}, not ${captureId}.`,
    });
    capture = null;
  }
  if (capture && capture.orderId === null) {
    problems.push({
      call: READ_CALLS.capture,
      message: `Capture ${captureId} names no order, so its order and refunds can't be read.`,
    });
  }

  // 2. The order, for the payer email, trackers and refunds. Without it the refunded total is
  // unknown, so the capture snapshot is left out too.
  const orderId = capture?.orderId ?? null;
  let order: Awaited<ReturnType<typeof rail.getOrder>> | null = null;
  if (orderId !== null) {
    try {
      order = await rail.getOrder(orderId);
    } catch (error) {
      problems.push(failed(READ_CALLS.order, error));
    }
    if (order && order.id !== orderId) {
      problems.push({
        call: READ_CALLS.order,
        message: `${READ_CALLS.order} returned order ${order.id}, not ${orderId}.`,
      });
      order = null;
    }
  }

  if (order) records.orders = [orderSnapshot(order)];

  if (capture && order) {
    const refunded = refundedTotal(order, captureId);
    if (refunded === null) {
      problems.push({
        call: READ_CALLS.order,
        message: `The refunded total of capture ${captureId} on order ${order.id} is unknown.`,
      });
    } else {
      const snapshot: CaptureSnapshot = {
        call: CALLS.capture,
        id: capture.id,
        orderId: capture.orderId,
        status: capture.status,
        amount: capture.amount,
        refundedMinor: refunded,
      };
      records.captures = [snapshot];
    }
  }

  // 3. The capture's disputes. A partial list proves nothing, so it's left out.
  try {
    const list = await rail.listDisputes(captureId);
    if (list.complete) {
      const snapshot: DisputesSnapshot = {
        call: CALLS.disputes,
        id: captureId,
        disputes: list.disputes.map((dispute) => ({ id: dispute.id, status: dispute.status })),
      };
      records.disputes = [snapshot];
    } else {
      problems.push({
        call: READ_CALLS.disputes,
        message: `The disputes list for capture ${captureId} has more pages than were read.`,
      });
    }
  } catch (error) {
    problems.push(failed(READ_CALLS.disputes, error));
  }

  // 4. The carrier's shipment for each of this capture's live trackers.
  const trackingNumbers = new Set<string>();
  for (const unit of order?.purchaseUnits ?? []) {
    for (const tracker of unit.trackers) {
      if (tracker.status !== SHIPPED) continue;
      if (tracker.id !== `${captureId}-${tracker.trackingNumber}`) continue;
      trackingNumbers.add(tracker.trackingNumber);
    }
  }
  const shipments: ShipmentSnapshot[] = [];
  for (const trackingNumber of trackingNumbers) {
    const call = READ_CALLS.shipment;
    try {
      const lookup = await carrier.getShipment(trackingNumber);
      if (lookup.kind === "found") {
        shipments.push({ call: CALLS.carrier, id: trackingNumber, status: lookup.shipment.status });
      } else if (lookup.kind === "not_found") {
        problems.push({ call, message: `The carrier has no record of ${trackingNumber}.` });
      } else {
        problems.push({
          call,
          message: oneLine(
            `The carrier's record of ${trackingNumber} is unreadable: ${lookup.detail}.`,
          ),
        });
      }
    } catch {
      problems.push({ call, message: `The carrier lookup for ${trackingNumber} failed.` });
    }
  }
  if (shipments.length > 0) records.shipments = shipments;

  return { records, problems };
}
