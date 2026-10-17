// Decision case files: a moment, a mandate, the record snapshots, and proposals, each with the
// decision expected of it, written before the case is run (brief §4 item 4). Never throws on a
// bad file.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  CURRENCIES,
  DECISIONS,
  firstIssueMessage,
  IdSchema as Id,
  type Mandate,
  parseMandate,
  ReasonCodeSchema,
  SHIPMENT_STATUSES,
  TimestampSchema,
} from "@countersign/mandate";
import { CALLS, type RecordSnapshots } from "@countersign/verifiers";
import { z } from "zod";

const Money = z.strictObject({
  minor: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  currency: z.enum(CURRENCIES),
});

// Each snapshot names the call it came from, filled in here so a case file can't misstate it.
function snapshotSchema<Shape extends z.ZodRawShape>(call: string, shape: Shape) {
  return z.strictObject({ id: Id, ...shape }).transform((record) => ({ call, ...record }));
}

const Records = z.strictObject({
  captures: z
    .array(
      snapshotSchema(CALLS.capture, {
        orderId: Id.nullable(),
        status: z.string(),
        amount: Money,
        refundedMinor: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
      }),
    )
    .optional(),
  orders: z
    .array(
      snapshotSchema(CALLS.order, {
        payerEmail: z.string().nullable(),
        trackers: z.array(z.strictObject({ id: Id, trackingNumber: Id, status: z.string() })),
      }),
    )
    .optional(),
  disputes: z
    .array(
      snapshotSchema(CALLS.disputes, {
        disputes: z.array(z.strictObject({ id: Id, status: z.string() })),
      }),
    )
    .optional(),
  shipments: z
    .array(snapshotSchema(CALLS.carrier, { status: z.enum(SHIPMENT_STATUSES) }))
    .optional(),
  ticket: snapshotSchema(CALLS.ticket, {
    senderEmail: z.string().nullable(),
    attachments: z.array(z.strictObject({ id: Id, contentType: z.string() })),
  }).optional(),
  // Absent means the history wasn't read; an empty list means nothing has executed.
  executions: z
    .array(
      snapshotSchema(CALLS.executions, {
        principal: Id,
        captureId: Id.nullable(),
        amount: Money,
        executedAt: TimestampSchema,
      }),
    )
    .optional(),
});

export const CaseFileSchema = z.strictObject({
  description: z.string().min(1),
  now: TimestampSchema,
  // The mandate file, relative to the case file.
  mandate: z.string().min(1),
  // The agent identity proposing, as its credentials would say.
  principal: Id,
  records: Records,
  proposals: z
    .array(
      z.strictObject({
        // Checked by the gate's own normalization, since a malformed proposal is a case too.
        proposal: z.unknown(),
        expect: z.strictObject({
          decision: z.enum(DECISIONS),
          reasons: z.array(ReasonCodeSchema),
        }),
      }),
    )
    .min(1),
});

export type CaseFile = z.infer<typeof CaseFileSchema>;

export type DecisionCase = {
  description: string;
  now: Date;
  mandate: Mandate;
  principal: string;
  records: RecordSnapshots;
  proposals: CaseFile["proposals"];
};

export type CaseLoad = { ok: true; decisionCase: DecisionCase } | { ok: false; error: string };

function readJson(path: string): { ok: true; json: unknown } | { ok: false; error: string } {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return { ok: false, error: `Can't read ${path}` };
  }
  try {
    return { ok: true, json: JSON.parse(text) };
  } catch {
    return { ok: false, error: `${path} isn't valid JSON` };
  }
}

// Reads and validates a case file and the mandate it names.
export function loadCase(path: string): CaseLoad {
  const file = readJson(path);
  if (!file.ok) return file;
  const parsed = CaseFileSchema.safeParse(file.json);
  if (!parsed.success) return { ok: false, error: firstIssueMessage("Case file", parsed.error) };
  const caseFile = parsed.data;
  const mandatePath = resolve(dirname(path), caseFile.mandate);
  const mandateFile = readJson(mandatePath);
  if (!mandateFile.ok) return mandateFile;
  const mandate = parseMandate(mandateFile.json);
  if (!mandate.ok) return { ok: false, error: `${mandatePath}: ${mandate.error}` };
  return {
    ok: true,
    decisionCase: {
      description: caseFile.description,
      now: new Date(caseFile.now),
      mandate: mandate.mandate,
      principal: caseFile.principal,
      records: caseFile.records,
      proposals: caseFile.proposals,
    },
  };
}
