import { z } from "zod";
import { MessageAcceptedSchema } from "./resolve-schemas";

// What the console's demo routes read: the scenario request and Resolve's answer, and the gate's
// reset report (ADR 0042, ADR 0043). The IDs of real scenarios are Resolve's to decide.

export const SCENARIO_BODY_LIMIT = 1024;

export const SCENARIO_MODES = ["protected", "baseline"] as const;

export const ScenarioRequestSchema = z.strictObject({
  scenario_id: z.string().regex(/^[a-z0-9-]{1,40}$/),
  mode: z.enum(SCENARIO_MODES),
});

export const ScenarioAcceptedSchema = MessageAcceptedSchema;

const Count = z.int().min(0);
const OrderNumber = z.string().regex(/^KIK-\d{4}$/);

const Head = z.object({ seq: Count, hash: z.string().min(1).max(128) });

export const ResetReportSchema = z.object({
  complete: z.boolean(),
  reset_at: z.string().min(1).max(40),
  took_ms: Count,
  orders: z.object({
    kept: Count.max(30),
    replaced: z.array(OrderNumber).max(30),
    run_id: z.string().min(1).max(64).nullable(),
    failed: z
      .array(
        z.object({
          order_number: OrderNumber,
          call: z.string().min(1).max(40),
          reason: z.string().min(1).max(500),
        }),
      )
      .max(30),
  }),
  cleared: z
    .object({
      previous_head: Head.nullable(),
      entries: Count,
      tickets: Count,
      attachments: Count,
      runs: Count,
      drafts: Count,
      documents: Count,
    })
    .nullable(),
  disputes: z
    .union([
      z.object({ recorded: Count, already_recorded: Count, problems: Count }),
      z.object({ error: z.string().min(1).max(300) }),
    ])
    .nullable(),
});

export type ScenarioRequest = z.infer<typeof ScenarioRequestSchema>;
export type ScenarioAccepted = z.infer<typeof ScenarioAcceptedSchema>;
export type ResetReport = z.infer<typeof ResetReportSchema>;
