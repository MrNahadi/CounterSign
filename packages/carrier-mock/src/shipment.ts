// A shipment as the carrier reports it, and the one zod rule every store and lookup uses.

import { SHIPMENT_STATUSES, type ShipmentStatus, TimestampSchema } from "@countersign/mandate";
import { z } from "zod";

/** 1 to 64 letters, digits or hyphens. Anything else is never looked up. */
export const TrackingNumberSchema = z.string().regex(/^[A-Za-z0-9-]{1,64}$/);

export const ScanEventSchema = z.strictObject({
  at: TimestampSchema,
  description: z.string().trim().min(1),
  place: z.string().trim().min(1),
});

export type ScanEvent = z.infer<typeof ScanEventSchema>;

export const ShipmentSchema = z.strictObject({
  trackingNumber: TrackingNumberSchema,
  carrierName: z.string().trim().min(1),
  status: z.enum(SHIPMENT_STATUSES),
  scanEvents: z.array(ScanEventSchema).check((ctx) => {
    for (let i = 1; i < ctx.value.length; i += 1) {
      const previous = ctx.value[i - 1];
      const current = ctx.value[i];
      if (previous && current && Date.parse(current.at) < Date.parse(previous.at)) {
        ctx.issues.push({
          code: "custom",
          input: ctx.value,
          path: [i, "at"],
          message: "scan events are not in time order",
        });
        return;
      }
    }
  }),
  updatedAt: TimestampSchema,
});

/** The carrier's record for one tracking number. The status is stored, never worked out. */
export type Shipment = {
  trackingNumber: string;
  carrierName: string;
  status: ShipmentStatus;
  scanEvents: ScanEvent[];
  updatedAt: string;
};

/** Thrown by a store asked to write a shipment that fails `ShipmentSchema`. */
export class InvalidShipmentError extends Error {
  override readonly name = "InvalidShipmentError";
}

/** The first issue as one line, `path: message`. Holds no input values. */
export const describeIssue = (error: z.ZodError): string => {
  const issue = error.issues[0];
  if (!issue) return "record: invalid";
  const path = issue.path.length > 0 ? issue.path.map(String).join(".") : "record";
  return `${path}: ${issue.message}`.replace(/\s+/g, " ").trim();
};

/** Validates a shipment for writing, returning a fresh copy. */
export const checkShipment = (shipment: Shipment): Shipment => {
  const parsed = ShipmentSchema.safeParse(shipment);
  if (!parsed.success)
    throw new InvalidShipmentError(`Invalid shipment: ${describeIssue(parsed.error)}`);
  return parsed.data;
};
