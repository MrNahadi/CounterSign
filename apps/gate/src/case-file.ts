// Decision case files: a moment, a mandate, the record snapshots, and proposals, each with the
// decision expected of it, written before the case is run (brief §4 item 4). Never throws on a
// bad file.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  CURRENCIES,
  type Mandate,
  OUTCOMES,
  parseMandate,
  REASONS,
  type ReasonCode,
  SHIPMENT_STATUSES,
} from "@countersign/mandate";
import { CALLS, type RecordSnapshots } from "@countersign/verifiers";
import { z } from "zod";

const Id = z.string().regex(/^\S(?:.*\S)?$/, "Must be a non-blank ID without outer spaces");

// An ISO 8601 timestamp with seconds and an offset, so the day never depends on the server's zone.
const Timestamp = z
  .string()
  .regex(
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/,
    "Must be an ISO 8601 timestamp with seconds and an offset",
  )
  .refine((value) => !Number.isNaN(new Date(value).getTime()), "Must be a real time");

const Money = z.strictObject({
  minor: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  currency: z.enum(CURRENCIES),
});

export const ReasonCodeSchema = z.custom<ReasonCode>(
  (value) => typeof value === "string" && Object.hasOwn(REASONS, value),
  "Must be a known reason code",
);

// Each snapshot names the call it came from, filled in here so a case file can't misstate it.
function from<Shape extends z.ZodRawShape>(call: string, shape: Shape) {
  return z.strictObject({ id: Id, ...shape }).transform((record) => ({ call, ...record }));
}

const Records = z.strictObject({
  captures: z
    .array(
      from(CALLS.capture, {
        orderId: Id.nullable(),
        status: z.string(),
        amount: Money,
        refundedMinor: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
      }),
    )
    .optional(),
  orders: z
    .array(
      from(CALLS.order, {
        payerEmail: z.string().nullable(),
        trackers: z.array(z.strictObject({ id: Id, trackingNumber: Id, status: z.string() })),
      }),
    )
    .optional(),
  disputes: z
    .array(
      from(CALLS.disputes, {
        disputes: z.array(z.strictObject({ id: Id, status: z.string() })),
      }),
    )
    .optional(),
  shipments: z.array(from(CALLS.carrier, { status: z.enum(SHIPMENT_STATUSES) })).optional(),
  ticket: from(CALLS.ticket, {
    senderEmail: z.string().nullable(),
    attachments: z.array(z.strictObject({ id: Id, contentType: z.string() })),
  }).optional(),
  // Absent means the history wasn't read; an empty list means nothing has executed.
  executions: z
    .array(
      from(CALLS.executions, {
        principal: Id,
        captureId: Id.nullable(),
        amount: Money,
        executedAt: Timestamp,
      }),
    )
    .optional(),
});

export const CaseFileSchema = z.strictObject({
  description: z.string().min(1),
  now: Timestamp,
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
          decision: z.enum(OUTCOMES),
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

function describePath(path: PropertyKey[]): string {
  return path.map((key) => (typeof key === "number" ? `[${key}]` : `.${String(key)}`)).join("");
}

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
  if (!parsed.success) {
    const [issue] = parsed.error.issues;
    const keys = issue?.code === "unrecognized_keys" ? `: ${issue.keys.join(", ")}` : "";
    const where = issue ? describePath(issue.path) : "";
    return { ok: false, error: `Case file${where}: ${issue?.message ?? "invalid"}${keys}` };
  }
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
