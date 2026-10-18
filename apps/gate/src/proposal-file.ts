// The proposal file the propose CLI and the stand-in agent CLI share: its schema, how each file
// proposal becomes the agent's proposal from `seed_orders`, and how its simulated ticket is
// written to the ticket store, labelled simulated, as Resolve will (ADR 0029; brief §8: simulated
// parts are labeled). No AI.

import {
  asc,
  type Database,
  eq,
  readTicket,
  seedOrders,
  type Ticket,
  writeTicket,
} from "@countersign/db";
import { DECISIONS, IdSchema as Id, ReasonCodeSchema } from "@countersign/mandate";
import { z } from "zod";

export const REFUND_TOOL = "create_refund";

const OrderNumber = z.string().regex(/^KIK-\d{4}$/, { error: "must be KIK- and four digits" });
const Sender = z.union([
  z.literal("payer"),
  z.literal("buyer:A"),
  z.literal("buyer:B"),
  z.email({ error: "must be payer, buyer:A, buyer:B or an email address" }),
]);
type Sender = z.infer<typeof Sender>;

const FileTicketSchema = z.strictObject({
  id: Id,
  sender: Sender,
  attachments: z.array(z.strictObject({ id: Id, contentType: z.string().min(1) })),
});

const FileProposal = z
  .strictObject({
    // The guarded tool to call. A refund unless it says otherwise.
    tool: z.string().min(1).optional(),
    // A refund's seed order or capture ID. Only create_refund proposals name either.
    order: OrderNumber.optional(),
    capture: Id.optional(),
    // pay_order's seed order, whose PayPal order ID becomes args.id: the sandbox picks that ID,
    // so the file can't hold it.
    seed_order: OrderNumber.optional(),
    // Every refund has a simulated ticket; other actions may.
    ticket: FileTicketSchema.optional(),
    // The tool's arguments (for a refund, other than the capture), and the justification other
    // than the ticket ID. The gate's own normalization checks both, since a malformed proposal is a
    // case.
    args: z.record(z.string(), z.unknown()),
    justification: z.record(z.string(), z.unknown()).optional(),
    // Written before the file is run.
    expect: z.strictObject({
      decision: z.enum(DECISIONS),
      reasons: z.array(ReasonCodeSchema),
    }),
  })
  .refine(
    (proposal) =>
      (proposal.tool ?? REFUND_TOOL) !== REFUND_TOOL ||
      (proposal.order === undefined) !== (proposal.capture === undefined),
    { error: "Each proposal names an order or a capture, not both" },
  )
  .refine(
    (proposal) =>
      (proposal.tool ?? REFUND_TOOL) === REFUND_TOOL ||
      (proposal.order === undefined && proposal.capture === undefined),
    { error: "Only create_refund proposals name an order or a capture" },
  )
  .refine((proposal) => proposal.seed_order === undefined || proposal.tool === "pay_order", {
    error: "Only pay_order proposals name a seed_order",
  })
  .refine((proposal) => proposal.seed_order === undefined || !Object.hasOwn(proposal.args, "id"), {
    error: "The order ID comes from seed_order, not args.id",
  })
  .refine((proposal) => (proposal.tool ?? REFUND_TOOL) !== REFUND_TOOL || proposal.ticket, {
    error: "Each create_refund proposal has a ticket",
  })
  .refine(
    (proposal) =>
      (proposal.tool ?? REFUND_TOOL) !== REFUND_TOOL || !Object.hasOwn(proposal.args, "capture_id"),
    { error: "The capture comes from order or capture, not args.capture_id" },
  )
  .refine(
    (proposal) =>
      proposal.justification === undefined || !Object.hasOwn(proposal.justification, "ticket_id"),
    { error: "The ticket ID comes from ticket.id, not justification.ticket_id" },
  );

export const ProposalFileSchema = z.strictObject({
  description: z.string().min(1),
  // The mandate file, relative to the proposal file.
  mandate: z.string().min(1),
  // The agent identity proposing, as its credentials would say.
  principal: Id,
  proposals: z.array(FileProposal).min(1),
});

export type ProposalFile = z.infer<typeof ProposalFileSchema>;
export type FileProposal = ProposalFile["proposals"][number];
export type Expected = FileProposal["expect"];

// The simulated ticket's fields that come from the file; the rest are filled in when it's written.
export type FileTicket = Pick<Ticket, "id" | "senderEmail" | "attachments">;

// The agent's proposal, as MCP carries it: the tool, its arguments and the justification.
export type AgentProposal = {
  tool: string;
  args: Record<string, unknown>;
  justification?: Record<string, unknown>;
};

export type Resolved = {
  proposal: AgentProposal;
  ticket: FileTicket | null;
  expect: Expected;
  label: string;
};

const notSeeded = (what: string) => `${what} isn't seeded. Run npm run seed first.`;

type Resolving = { ok: true; resolved: Resolved } | { ok: false; error: string };

async function senderEmail(
  db: Database,
  sender: Sender,
  payerEmail: string | null,
): Promise<{ ok: true; email: string } | { ok: false; error: string | null }> {
  if (sender === "payer") {
    return payerEmail === null ? { ok: false, error: null } : { ok: true, email: payerEmail };
  }
  if (sender === "buyer:A" || sender === "buyer:B") {
    const buyer = sender.slice("buyer:".length);
    const [row] = await db
      .select()
      .from(seedOrders)
      .where(eq(seedOrders.buyer, buyer))
      .orderBy(asc(seedOrders.orderNumber))
      .limit(1);
    if (!row) return { ok: false, error: notSeeded(`Buyer ${buyer}`) };
    return { ok: true, email: row.payerEmail };
  }
  return { ok: true, email: sender };
}

const ticketLabel = (ticket: FileTicket) =>
  `ticket ${ticket.id} from ${ticket.senderEmail} (simulated)`;

async function resolveRefund(db: Database, item: FileProposal): Promise<Resolving> {
  let captureId: string;
  let payerEmail: string | null = null;
  if (item.order !== undefined) {
    const [row] = await db
      .select()
      .from(seedOrders)
      .where(eq(seedOrders.orderNumber, item.order))
      .limit(1);
    if (!row) return { ok: false, error: notSeeded(`Order ${item.order}`) };
    captureId = row.paypalCaptureId;
    payerEmail = row.payerEmail;
  } else {
    captureId = item.capture as string;
    const [row] = await db
      .select()
      .from(seedOrders)
      .where(eq(seedOrders.paypalCaptureId, captureId))
      .limit(1);
    payerEmail = row?.payerEmail ?? null;
  }

  // The schema requires a refund's ticket.
  const fileTicket = item.ticket as z.infer<typeof FileTicketSchema>;
  const sender = await senderEmail(db, fileTicket.sender, payerEmail);
  if (!sender.ok) {
    const what =
      item.order === undefined ? `The payer of capture ${captureId}` : `Order ${item.order}`;
    return { ok: false, error: sender.error ?? notSeeded(what) };
  }
  const ticket: FileTicket = {
    id: fileTicket.id,
    senderEmail: sender.email,
    attachments: fileTicket.attachments,
  };
  const proposal: AgentProposal = {
    tool: REFUND_TOOL,
    args: { capture_id: captureId, ...item.args },
    justification: { ticket_id: fileTicket.id, ...item.justification },
  };
  const label = item.order === undefined ? `capture ${captureId}` : `${item.order}`;
  return {
    ok: true,
    resolved: { proposal, ticket, expect: item.expect, label: `${label}, ${ticketLabel(ticket)}` },
  };
}

// Any other tool carries its full arguments, except pay_order's seed order.
async function resolveOther(db: Database, tool: string, item: FileProposal): Promise<Resolving> {
  let args = item.args;
  let payerEmail: string | null = null;
  if (item.seed_order !== undefined) {
    const [row] = await db
      .select()
      .from(seedOrders)
      .where(eq(seedOrders.orderNumber, item.seed_order))
      .limit(1);
    if (!row) return { ok: false, error: notSeeded(`Order ${item.seed_order}`) };
    args = { id: row.paypalOrderId, ...item.args };
    payerEmail = row.payerEmail;
  }
  let ticket: FileTicket | null = null;
  if (item.ticket !== undefined) {
    const sender = await senderEmail(db, item.ticket.sender, payerEmail);
    if (!sender.ok) {
      return {
        ok: false,
        error:
          sender.error ??
          `Ticket ${item.ticket.id} is from the payer, but its ${tool} proposal names no seed order.`,
      };
    }
    ticket = {
      id: item.ticket.id,
      senderEmail: sender.email,
      attachments: item.ticket.attachments,
    };
  }
  const justification =
    ticket === null ? item.justification : { ticket_id: ticket.id, ...item.justification };
  const proposal: AgentProposal = {
    tool,
    args,
    ...(justification === undefined ? {} : { justification }),
  };
  const on = item.seed_order === undefined ? tool : `${tool} on ${item.seed_order}`;
  return {
    ok: true,
    resolved: {
      proposal,
      ticket,
      expect: item.expect,
      label: ticket === null ? on : `${on}, ${ticketLabel(ticket)}`,
    },
  };
}

// Turns a file proposal into the agent's proposal and its simulated ticket, from `seed_orders`.
function resolveProposal(db: Database, item: FileProposal): Promise<Resolving> {
  const tool = item.tool ?? REFUND_TOOL;
  return tool === REFUND_TOOL ? resolveRefund(db, item) : resolveOther(db, tool, item);
}

const SIMULATED_BODY = "Simulated ticket from a proposal file.";

const sameTicket = (stored: Ticket, ticket: FileTicket): boolean =>
  stored.senderEmail === ticket.senderEmail &&
  stored.attachments.length === ticket.attachments.length &&
  stored.attachments.every(
    (item, i) =>
      item.id === ticket.attachments[i]?.id &&
      item.contentType === ticket.attachments[i]?.contentType,
  );

// Writes a file ticket to the store, labelled simulated. A ticket already stored with the same
// sender and attachments, from an earlier run or an earlier proposal, is kept as it is, since a
// ticket is never changed once written; one stored with another sender or attachments can't run.
async function storeTicket(
  db: Database,
  ticket: FileTicket,
  receivedAt: Date,
): Promise<string | null> {
  const stored = await readTicket(db, ticket.id);
  if (stored !== null) {
    return sameTicket(stored, ticket)
      ? null
      : `Ticket ${ticket.id} is already stored with another sender or attachments.`;
  }
  await writeTicket(db, {
    ...ticket,
    channel: "email",
    senderPhone: null,
    subject: null,
    body: SIMULATED_BODY,
    receivedAt: receivedAt.toISOString(),
    simulated: true,
  });
  return null;
}

/**
 * Resolves every file proposal, then stores every simulated ticket, before anything is proposed,
 * so a bad file proposes nothing. `storeFailure` words an error from the ticket store.
 */
export async function prepareProposals(
  db: Database,
  items: readonly FileProposal[],
  receivedAt: Date,
  storeFailure: (ticketId: string, error: unknown) => string,
): Promise<{ ok: true; resolved: Resolved[] } | { ok: false; error: string }> {
  const resolved: Resolved[] = [];
  for (const item of items) {
    const one = await resolveProposal(db, item);
    if (!one.ok) return one;
    resolved.push(one.resolved);
  }
  for (const { ticket } of resolved) {
    if (ticket === null) continue;
    let conflict: string | null;
    try {
      conflict = await storeTicket(db, ticket, receivedAt);
    } catch (error) {
      return { ok: false, error: storeFailure(ticket.id, error) };
    }
    if (conflict !== null) return { ok: false, error: conflict };
  }
  return { ok: true, resolved };
}

export const sameCodes = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && [...a].sort().every((code, index) => code === [...b].sort()[index]);

export const plural = (count: number, one: string, many: string) =>
  `${count} ${count === 1 ? one : many}`;
