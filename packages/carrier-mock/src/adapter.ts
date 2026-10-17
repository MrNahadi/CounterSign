// The carrier adapter: the one way the gate, Resolve and the seed learn a shipment's status.

import type { Shipment } from "./shipment";

/**
 * The result of looking up one tracking number. Only `found` carries a status; the other two
 * never do, so a caller can't read a status out of a missing or broken record.
 */
export type ShipmentLookup =
  /** The carrier has a valid record for this tracking number. */
  | { kind: "found"; shipment: Shipment }
  /**
   * The carrier has no record for this tracking number, or the tracking number isn't 1 to 64
   * letters, digits or hyphens (such a number is never sent to the carrier).
   */
  | { kind: "not_found"; trackingNumber: string }
  /**
   * The carrier holds a record that fails validation. `detail` is one line naming the first
   * field that failed, and never contains the record's values.
   */
  | { kind: "unreadable"; trackingNumber: string; detail: string };

/**
 * A carrier that reports shipments by tracking number. The mock implements it over a store; a
 * real tracking API would implement it the same way:
 *
 * - `getShipment` takes the tracking number exactly as written on the PayPal tracker. It must
 *   reject a number that isn't 1 to 64 letters, digits or hyphens as `not_found` without calling
 *   the carrier.
 * - It maps the carrier's own states onto the four shipment statuses (`lost`, `stalled_10d`,
 *   `in_transit`, `delivered`). A state it can't map is `unreadable`, never a guess.
 * - Scan events are returned oldest first, each with an ISO 8601 time with an offset, a
 *   description and a place. `updatedAt` is when the carrier last changed the record.
 * - A response that fails validation is `unreadable` with a one-line detail. A network or
 *   carrier failure is thrown, so it can never be mistaken for `not_found`.
 * - It never derives a status from the clock (ADR 0023).
 */
export interface CarrierAdapter {
  getShipment(trackingNumber: string): Promise<ShipmentLookup>;
}
