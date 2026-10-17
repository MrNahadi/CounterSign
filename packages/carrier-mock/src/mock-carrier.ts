// The mock carrier: reports whatever the store holds, and nothing it can't validate.

import type { CarrierAdapter, ShipmentLookup } from "./adapter";
import { describeIssue, ShipmentSchema, TrackingNumberSchema } from "./shipment";
import type { ShipmentStore } from "./stores";

export const createMockCarrier = (store: ShipmentStore): CarrierAdapter => ({
  async getShipment(trackingNumber): Promise<ShipmentLookup> {
    if (!TrackingNumberSchema.safeParse(trackingNumber).success) {
      return { kind: "not_found", trackingNumber };
    }
    const stored = await store.read(trackingNumber);
    if (!stored) return { kind: "not_found", trackingNumber };
    const parsed = ShipmentSchema.safeParse(stored.record);
    if (!parsed.success) {
      return { kind: "unreadable", trackingNumber, detail: describeIssue(parsed.error) };
    }
    if (parsed.data.trackingNumber !== trackingNumber) {
      return {
        kind: "unreadable",
        trackingNumber,
        detail: "trackingNumber: the record is for another tracking number",
      };
    }
    return { kind: "found", shipment: parsed.data };
  },
});
