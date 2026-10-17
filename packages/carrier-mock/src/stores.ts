// Where the mock carrier keeps shipments: `carrier_shipments`, or memory for tests.

import { carrierShipments, type Database, eq } from "@countersign/db";
import { checkShipment, type Shipment } from "./shipment";

/**
 * Storage behind the mock carrier. `read` returns the stored record as it is, unvalidated, or
 * null when there is none; the carrier validates it. `write` validates the shipment with zod
 * and replaces any earlier record for its tracking number.
 */
export interface ShipmentStore {
  read(trackingNumber: string): Promise<{ record: unknown } | null>;
  write(shipment: Shipment): Promise<void>;
}

/** An open database, or a transaction on one, so a shipment can be written with other rows. */
export type Queryable = Database | Parameters<Parameters<Database["transaction"]>[0]>[0];

/** A store over the `carrier_shipments` table. */
export const createDatabaseShipmentStore = (db: Queryable): ShipmentStore => ({
  async read(trackingNumber) {
    const [row] = await db
      .select()
      .from(carrierShipments)
      .where(eq(carrierShipments.trackingNumber, trackingNumber))
      .limit(1);
    return row ? { record: row } : null;
  },
  async write(shipment) {
    const row = checkShipment(shipment);
    const { trackingNumber: _, ...rest } = row;
    await db
      .insert(carrierShipments)
      .values(row)
      .onConflictDoUpdate({ target: carrierShipments.trackingNumber, set: rest });
  },
});

/**
 * A store in memory, for tests. `records` maps tracking numbers to stored records; a test may
 * put an invalid record in it directly to stand for a damaged row.
 */
export const createMemoryShipmentStore = (
  records: Map<string, unknown> = new Map(),
): ShipmentStore => ({
  async read(trackingNumber) {
    return records.has(trackingNumber)
      ? { record: structuredClone(records.get(trackingNumber)) }
      : null;
  },
  async write(shipment) {
    const row = checkShipment(shipment);
    records.set(row.trackingNumber, row);
  },
});
