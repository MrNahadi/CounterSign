// Proposal normalization: the agent's tool call and justification become an intent, or a denial.
// Never throws on bad input.

import {
  CLAIMS,
  type Intent,
  isMinorUnits,
  type Money,
  parseMoney,
  type Reason,
} from "@countersign/mandate";
import { captureFor, type RecordSnapshots } from "@countersign/verifiers";
import { z } from "zod";

// The tools the gate knows, by the guarded action each proposes. Anything else is UNKNOWN_ACTION.
const TOOLS = { create_refund: "paypal.refund" } as const;

// An ID with no blank and no leading or trailing spaces.
const Id = z.string().regex(/^\S(?:.*\S)?$/, "Must be a non-blank ID without outer spaces");

// PayPal's `{ value, currency_code }`, read strictly into minor units.
const Amount = z
  .strictObject({ value: z.string(), currency_code: z.string() })
  .transform((amount, ctx): Money => {
    const parsed = parseMoney(amount.value, amount.currency_code);
    if (parsed.ok) return parsed.money;
    ctx.addIssue({ code: "custom", message: parsed.error });
    return z.NEVER;
  });

const CreateRefundProposal = z.strictObject({
  tool: z.literal("create_refund"),
  args: z.strictObject({
    capture_id: Id,
    amount: Amount.optional(),
    note_to_payer: z.string().max(255).optional(),
  }),
  justification: z.strictObject({
    ticket_id: Id,
    claim: z.enum(CLAIMS).nullable().optional(),
  }),
});

export type ProposalInput = {
  proposal: unknown;
  // Who is proposing, from the agent's credentials, never from the proposal itself.
  principal: string;
  mandateVersion: number;
  records: RecordSnapshots;
};

export type Normalized = { ok: true; intent: Intent } | { ok: false; reason: Reason };

function invalid(detail: string): Normalized {
  return { ok: false, reason: { code: "INVALID_PROPOSAL", detail } };
}

function describePath(path: PropertyKey[]): string {
  return path.map((key) => (typeof key === "number" ? `[${key}]` : `.${String(key)}`)).join("");
}

// Read first, alone, so an unknown tool is UNKNOWN_ACTION whatever else is wrong. A missing or
// non-string tool falls through to the full parse, which calls it invalid.
const NamedTool = z.object({ tool: z.string() });

export function normalizeProposal(input: ProposalInput): Normalized {
  const named = NamedTool.safeParse(input.proposal);
  if (named.success && !Object.hasOwn(TOOLS, named.data.tool)) {
    const detail = `Unknown tool ${named.data.tool}`;
    return { ok: false, reason: { code: "UNKNOWN_ACTION", detail } };
  }

  const parsed = CreateRefundProposal.safeParse(input.proposal);
  if (!parsed.success) {
    const [issue] = parsed.error.issues;
    if (!issue) return invalid("Proposal is malformed");
    const keys = issue.code === "unrecognized_keys" ? `: ${issue.keys.join(", ")}` : "";
    return invalid(`Proposal${describePath(issue.path)}: ${issue.message}${keys}`);
  }
  const { args, justification } = parsed.data;

  const capture = captureFor(args.capture_id, input.records);
  let amount = args.amount;
  if (!amount) {
    // No amount means "refund what's left", so the intent states the exact amount that executes.
    if (!capture) return invalid(`No amount, and no record of capture ${args.capture_id}`);
    const leftMinor = capture.amount.minor - capture.refundedMinor;
    if (!isMinorUnits(capture.refundedMinor) || !isMinorUnits(leftMinor) || leftMinor === 0) {
      return invalid(`No amount, and capture ${args.capture_id} has nothing left to refund`);
    }
    amount = { minor: leftMinor, currency: capture.amount.currency };
  }

  return {
    ok: true,
    intent: {
      principal: input.principal,
      rail: "paypal",
      action: TOOLS[parsed.data.tool],
      amount,
      target: { captureId: args.capture_id, orderId: capture?.orderId ?? null },
      ticketId: justification.ticket_id,
      claim: justification.claim ?? null,
      mandateVersion: input.mandateVersion,
    },
  };
}
