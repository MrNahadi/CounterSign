// Proposal normalization: the agent's tool call and justification become an intent, or a denial.
// Never throws on bad input.

import {
  type Action,
  CLAIMS,
  firstIssueMessage,
  IdSchema as Id,
  type Intent,
  type IntentParams,
  type IntentTarget,
  isCurrency,
  isMinorUnits,
  type Money,
  parseMoney,
  type Reason,
} from "@countersign/mandate";
import { captureFor, disputeRecordFor, type RecordSnapshots } from "@countersign/verifiers";
import { z } from "zod";

// The tools the gate knows, by the guarded action each proposes. Anything else is UNKNOWN_ACTION.
const TOOLS = {
  create_refund: "paypal.refund",
  accept_dispute_claim: "paypal.dispute.accept_claim",
  provide_dispute_evidence: "paypal.dispute.provide_evidence",
  make_offer: "paypal.dispute.make_offer",
} as const satisfies Record<string, Action>;
type Tool = keyof typeof TOOLS;

// PayPal's `{ value, currency_code }`, read strictly into minor units.
const Amount = z
  .strictObject({ value: z.string(), currency_code: z.string() })
  .transform((amount, ctx): Money => {
    const parsed = parseMoney(amount.value, amount.currency_code);
    if (parsed.ok) return parsed.money;
    ctx.addIssue({ code: "custom", message: parsed.error });
    return z.NEVER;
  });

const Claim = z.enum(CLAIMS).nullable().optional();

const CreateRefundProposal = z.strictObject({
  tool: z.literal("create_refund"),
  args: z.strictObject({
    capture_id: Id,
    amount: Amount.optional(),
    note_to_payer: z.string().max(255).optional(),
    // Accepted and ignored, as the note is: the refund executes on the capture alone.
    invoice_id: Id.optional(),
  }),
  justification: z.strictObject({ ticket_id: Id, claim: Claim }),
});

// Only a refund needs a ticket, so every other tool's justification is optional throughout.
const OptionalJustification = z.strictObject({ ticket_id: Id.optional(), claim: Claim }).optional();

const Note = z.string().min(1).max(2000);

// PayPal's evidence types for providing dispute evidence (Customer Disputes v1).
export const EVIDENCE_TYPES = [
  "PROOF_OF_FULFILLMENT",
  "PROOF_OF_REFUND",
  "PROOF_OF_DELIVERY_SIGNATURE",
  "PROOF_OF_RECEIPT_COPY",
  "RETURN_POLICY",
  "BILLING_AGREEMENT",
  "PROOF_OF_RESHIPMENT",
  "ITEM_DESCRIPTION",
  "POLICE_REPORT",
  "AFFIDAVIT",
  "PAID_WITH_OTHER_METHOD",
  "COPY_OF_CONTRACT",
  "TERMINAL_ATM_RECEIPT",
  "PRICE_DIFFERENCE_REASON",
  "SOURCE_CONVERSION_RATE",
  "BANK_STATEMENT",
  "CREDIT_DUE_REASON",
  "REQUEST_CREDIT_RECEIPT",
  "PROOF_OF_RETURN",
  "CREATE",
  "CHANGE_REASON",
  "PROOF_OF_REFUND_OUTSIDE_PAYPAL",
  "RECEIPT_OF_MERCHANDISE",
  "CUSTOMS_DOCUMENT",
  "CUSTOMS_FEE_RECEIPT",
  "INFORMATION_ON_RESOLUTION",
  "ADDITIONAL_INFORMATION_OF_ITEM",
  "DETAILS_OF_PURCHASE",
  "PROOF_OF_SIGNIFICANT_DIFFERENCE",
  "PROOF_OF_SOFTWARE_OR_SERVICE_NOT_AS_DESCRIBED",
  "PROOF_OF_CONFISCATION",
  "PROOF_OF_DAMAGE",
  "COPY_OF_LAW_ENFORCEMENT_AGENCY_REPORT",
  "ADDITIONAL_PROOF_OF_SHIPMENT",
  "PROOF_OF_DENIAL_BY_CARRIER",
  "VALID_SUPPORTING_DOCUMENT",
  "LEGIBLE_SUPPORTING_DOCUMENT",
  "RETURN_TRACKING_INFORMATION",
  "DELIVERY_RECEIPT",
  "PROOF_OF_INSTORE_RECEIPT",
  "ADDITIONAL_TRACKING_INFORMATION",
  "PROOF_OF_SHIPMENT_POSTAGE",
  "ONLINE_TRACKING_INFORMATION",
  "PROOF_OF_INSTORE_REFUND",
  "PROOF_FOR_SOFTWARE_OR_SERVICE_DELIVERED",
  "RETURN_ADDRESS_SHIPPING_LABEL",
  "OTHER",
] as const;

export const OFFER_TYPES = [
  "REFUND",
  "REFUND_WITH_RETURN",
  "REFUND_WITH_REPLACEMENT",
  "REPLACEMENT_WITHOUT_REFUND",
] as const;

const AcceptDisputeClaimProposal = z.strictObject({
  tool: z.literal("accept_dispute_claim"),
  args: z.strictObject({ dispute_id: Id, note: Note }),
  justification: OptionalJustification,
});

const ProvideDisputeEvidenceProposal = z.strictObject({
  tool: z.literal("provide_dispute_evidence"),
  args: z.strictObject({
    dispute_id: Id,
    evidence: z
      .array(
        z.strictObject({
          evidence_type: z.enum(EVIDENCE_TYPES),
          notes: Note,
          tracking_numbers: z.array(Id).max(100).optional(),
        }),
      )
      .min(1)
      .max(10),
  }),
  justification: OptionalJustification,
});

const MakeOfferProposal = z.strictObject({
  tool: z.literal("make_offer"),
  args: z
    .strictObject({
      dispute_id: Id,
      offer_type: z.enum(OFFER_TYPES),
      offer_amount: Amount.optional(),
      note: Note,
    })
    .superRefine((args, ctx) => {
      const replacement = args.offer_type === "REPLACEMENT_WITHOUT_REFUND";
      if (replacement && args.offer_amount) {
        const message = "Must be left out for a replacement without a refund";
        ctx.addIssue({ code: "custom", path: ["offer_amount"], message });
      }
      if (!replacement && !args.offer_amount) {
        const message = `Is required for an offer of type ${args.offer_type}`;
        ctx.addIssue({ code: "custom", path: ["offer_amount"], message });
      }
    }),
  justification: OptionalJustification,
});

const PROPOSALS = {
  create_refund: CreateRefundProposal,
  accept_dispute_claim: AcceptDisputeClaimProposal,
  provide_dispute_evidence: ProvideDisputeEvidenceProposal,
  make_offer: MakeOfferProposal,
} as const satisfies Record<Tool, z.ZodType>;

export type ProposalInput = {
  proposal: unknown;
  // Who is proposing, from the agent's credentials, never from the proposal itself.
  principal: string;
  mandateVersion: number;
  records: RecordSnapshots;
};

type Denial = { ok: false; reason: Reason };

export type Normalized = { ok: true; intent: Intent } | Denial;

function invalid(detail: string): Denial {
  return { ok: false, reason: { code: "INVALID_PROPOSAL", detail } };
}

function targetUnknown(detail: string): Denial {
  return { ok: false, reason: { code: "TARGET_UNKNOWN", detail } };
}

// Read first, alone, so an unknown tool is UNKNOWN_ACTION whatever else is wrong. A missing or
// non-string tool falls through to the full parse, which calls it invalid.
const NamedTool = z.object({ tool: z.string() });

// What a tool's arguments normalize into, before the intent's shared fields are added.
type Normalizing =
  | { ok: true; amount: Money; target: IntentTarget; params?: IntentParams }
  | Denial;

function normalizeRefund(
  args: z.infer<typeof CreateRefundProposal>["args"],
  records: RecordSnapshots,
): Normalizing {
  const capture = captureFor(args.capture_id, records);
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
  const orderId = capture?.orderId ?? null;
  const target: IntentTarget = { kind: "capture", captureId: args.capture_id, orderId };
  return { ok: true, amount, target };
}

// A dispute action always reads its dispute, which supplies the amount unless an offer states one.
function normalizeDispute(
  disputeId: string,
  records: RecordSnapshots,
  params: IntentParams,
  offerAmount?: Money,
): Normalizing {
  const record = disputeRecordFor(disputeId, records);
  if (!record) return targetUnknown(`No record of dispute ${disputeId}`);
  const { minor, currency } = record.amount;
  if (!isCurrency(currency)) {
    return targetUnknown(
      `Dispute ${disputeId} is in ${currency}, which Countersign doesn't support`,
    );
  }
  if (!isMinorUnits(minor) || minor === 0) {
    return targetUnknown(`Dispute ${disputeId} has no amount Countersign can read`);
  }
  if (offerAmount && offerAmount.currency !== currency) {
    return invalid(
      `The offer is in ${offerAmount.currency}, but dispute ${disputeId} is in ${currency}`,
    );
  }
  const target: IntentTarget = { kind: "dispute", disputeId };
  return { ok: true, amount: offerAmount ?? { minor, currency }, target, params };
}

type Parsed = { [T in Tool]: z.infer<(typeof PROPOSALS)[T]> }[Tool];

function normalizeArgs(parsed: Parsed, records: RecordSnapshots): Normalizing {
  switch (parsed.tool) {
    case "create_refund":
      return normalizeRefund(parsed.args, records);
    case "accept_dispute_claim":
      return normalizeDispute(parsed.args.dispute_id, records, { note: parsed.args.note });
    case "provide_dispute_evidence": {
      const evidence = parsed.args.evidence.map((item) => ({
        evidenceType: item.evidence_type,
        notes: item.notes,
        trackingNumbers: item.tracking_numbers ?? null,
      }));
      return normalizeDispute(parsed.args.dispute_id, records, { evidence });
    }
    case "make_offer": {
      const { dispute_id, offer_type, offer_amount, note } = parsed.args;
      return normalizeDispute(dispute_id, records, { offerType: offer_type, note }, offer_amount);
    }
  }
}

export function normalizeProposal(input: ProposalInput): Normalized {
  const named = NamedTool.safeParse(input.proposal);
  if (named.success && !Object.hasOwn(TOOLS, named.data.tool)) {
    const detail = `Unknown tool ${named.data.tool}`;
    return { ok: false, reason: { code: "UNKNOWN_ACTION", detail } };
  }

  // A known tool is checked against its own schema; anything else against a refund's.
  const tool: Tool = named.success ? (named.data.tool as Tool) : "create_refund";
  const parsed = PROPOSALS[tool].safeParse(input.proposal);
  if (!parsed.success) return invalid(firstIssueMessage("Proposal", parsed.error));
  const proposal = parsed.data as Parsed;

  const normalized = normalizeArgs(proposal, input.records);
  if (!normalized.ok) return normalized;
  const { justification } = proposal;
  return {
    ok: true,
    intent: {
      principal: input.principal,
      rail: "paypal",
      action: TOOLS[proposal.tool],
      amount: normalized.amount,
      target: normalized.target,
      ticketId: justification?.ticket_id ?? null,
      ...(normalized.params ? { params: normalized.params } : {}),
      claim: justification?.claim ?? null,
      mandateVersion: input.mandateVersion,
    },
  };
}
