// shipment.status: the carrier's status for the tracking number on the order's tracker.

import type { Intent, RecordRef, ShipmentStatus, TraceEntry } from "@countersign/mandate";
import { orderFor } from "./lookups";
import { CALLS, type RecordSnapshots, recordRef } from "./snapshots";

// The only tracker status that counts as a live shipment. PayPal's other is CANCELLED.
const SHIPPED = "SHIPPED";

// Never fails: it passes with a value, or it's unknown. Only the capture's own live trackers
// count, linked by the tracker ID (spike S2). With several, the carrier must give them all the
// same status, or the status is unknown.
export function shipmentStatus(intent: Intent, records: RecordSnapshots): TraceEntry {
  const { captureId } = intent.target;
  const found = orderFor(intent, records);
  const recordsRead: RecordRef[] = [found.ref];
  const result = (detail: string, value?: ShipmentStatus): TraceEntry => ({
    verifier: "shipment.status",
    result: value ? "pass" : "unknown",
    records: recordsRead,
    detail,
    ...(value ? { value } : {}),
  });
  if (!found.order) return result(found.missing);
  const { order } = found;
  const trackers = order.trackers.filter(
    (tracker) =>
      tracker.status === SHIPPED && tracker.id === `${captureId}-${tracker.trackingNumber}`,
  );
  if (trackers.length === 0) {
    return result(`No live tracker for capture ${captureId} on order ${order.id}`);
  }
  const readings: string[] = [];
  const statuses = new Set<ShipmentStatus>();
  for (const { trackingNumber } of trackers) {
    const shipment = records.shipments?.find((record) => record.id === trackingNumber);
    recordsRead.push(shipment ? recordRef(shipment) : { call: CALLS.carrier, id: trackingNumber });
    if (!shipment) return result(`No carrier record for ${trackingNumber}`);
    readings.push(`${trackingNumber} ${shipment.status}`);
    statuses.add(shipment.status);
  }
  const [status] = statuses;
  if (statuses.size > 1 || !status) {
    return result(`Carrier records disagree: ${readings.join(", ")}`);
  }
  return result(`Carrier shows ${readings.join(", ")}`, status);
}
