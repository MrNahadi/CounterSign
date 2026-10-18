// Live records: the capture, order, disputes and shipment for one capture, read from the PayPal
// sandbox and the carrier and mapped into the verifiers' snapshots (brief §6 step 3). Fail closed:
// a read that fails, or a record that can't be mapped, leaves its snapshot out, so the verifiers
// that need it return unknown. Reading never throws; each failed read is one line for the CLI.

import type { CarrierAdapter } from "@countersign/carrier-mock";
import { type PayPalClient, PayPalError, refundedTotal } from "@countersign/rail-paypal";
import {
  CALLS,
  type CaptureSnapshot,
  type DisputesSnapshot,
  type OrderSnapshot,
  type RecordSnapshots,
  type ShipmentSnapshot,
  type TicketSnapshot,
} from "@countersign/verifiers";

// The reads the gate makes, named as the rail client names its calls.
export const READ_CALLS = {
  capture: "get-capture",
  order: "get-order",
  disputes: "list-disputes",
  shipment: "carrier-shipment",
} as const;

// One read that failed: the call, and a one-line message that never holds a credential.
export type ReadProblem = { call: string; message: string };

export type LiveRecords = { records: RecordSnapshots; problems: ReadProblem[] };

export type LiveRecordsInput = {
  captureId: string;
  // The ticket comes from the caller: simulated in phase 6, from Resolve in phase 8.
  ticket?: TicketSnapshot;
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

export async function readLiveRecords(input: LiveRecordsInput): Promise<LiveRecords> {
  const { captureId, rail, carrier } = input;
  const problems: ReadProblem[] = [];
  const records: RecordSnapshots = {};
  if (input.ticket) records.ticket = input.ticket;

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

  if (order) {
    const snapshot: OrderSnapshot = {
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
    records.orders = [snapshot];
  }

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
