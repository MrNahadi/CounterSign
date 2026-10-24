// Claims vs records (ADR 0034): what the message claims beside what the records say, for one
// decision entry. Built only here and shown as it comes on the approval card, the console and
// the `audit` CLI. Pure display: no AI, no network, no database, and nothing in the decision
// path imports it. Verdicts come from a fixed table over the verifier's result and value; the
// message itself is never read to judge anything.

import type { Ticket } from "@countersign/db";
import {
  type Claim,
  formatMoney,
  hashMandate,
  type Intent,
  type Mandate,
  ruleActions,
  type ShipmentStatus,
  type TraceEntry,
  type VerifierName,
} from "@countersign/mandate";
import { ACTION_WORDS, sourceWords, VERIFIER_WORDS } from "./words";

// The most characters of a ticket's body, or of an unreadable proposal, a pair quotes.
export const CLAIM_QUOTE_LENGTH = 280;

export const MESSAGE_RECORD = "Messages can't approve money. Only your signed rules can.";
export const UNREADABLE_PROPOSAL_CLAIM = "The agent sent a proposal Countersign couldn't read.";
export const NO_RECORDS_READ = "No records were read.";
export const NO_TICKET_NAMED = "No ticket named";

export const CLAIM_VERDICTS = [
  "matches",
  "contradicts",
  "passes",
  "fails",
  "no_record",
  "not_used",
] as const;
export type ClaimVerdict = (typeof CLAIM_VERDICTS)[number];

export const VERDICT_WORDS: Record<ClaimVerdict, string> = {
  matches: "Matches",
  contradicts: "Contradicts",
  passes: "Passes",
  fails: "Fails",
  no_record: "No record",
  not_used: "Not used",
};

export const CLAIM_WORDS: Record<Claim, string> = {
  not_received: "Says the parcel never arrived",
  damaged: "Says the item arrived damaged",
  wrong_item: "Says they got the wrong item",
};

// One record a check read: its source in words, the call, and the record's ID ("none" when the
// record had no ID to look it up by).
export type ClaimSource = { words: string; call: string; id: string };

export type ClaimPair = {
  // The verifier the pair is about, "message" for the ticket's own text, or "proposal" for a
  // proposal that never became an intent.
  check: VerifierName | "message" | "proposal";
  // What the message or proposal asserts; null when it asserts nothing this check tests.
  claim: {
    text: string;
    // Quoted text under the claim: the ticket's body or the raw proposal, cut to 280 characters.
    quote: string | null;
    simulated: boolean;
  } | null;
  record: {
    words: string;
    detail: string;
    value: string | null;
    sources: ClaimSource[];
  };
  verdict: ClaimVerdict;
};

// What a decision entry holds that the pairs need. `proposal` is the logged proposal text.
export type ClaimsDecision = {
  intent: Intent | null;
  trace: readonly TraceEntry[];
  matchedRules: readonly string[];
  mandate: { id: string; version: number; hash: string };
  proposal: string;
};

export type ClaimsContext = {
  // The ticket the intent names, read from the ticket store; null when none is named or the
  // store lacks it.
  ticket: Ticket | null;
  // The seeded order the target belongs to, when known.
  orderNumber: string | null;
  // The gate's loaded mandates. The decision's own, by hash, narrows the checks.
  mandates: readonly Mandate[];
};

const quoteOf = (text: string): string => [...text].slice(0, CLAIM_QUOTE_LENGTH).join("");

// The loaded mandate a decision was made under, by hash; undefined when the gate doesn't hold it.
export function mandateByHash(hash: string, mandates: readonly Mandate[]): Mandate | undefined {
  return mandates.find((candidate) => hashMandate(candidate).hash === hash);
}

// The verifiers that decided, or null to show every trace entry (the decision's mandate isn't
// one the gate holds).
function decidingVerifiers(
  decision: Pick<ClaimsDecision, "intent" | "matchedRules" | "mandate">,
  mandates: readonly Mandate[],
): Set<VerifierName> | null {
  const mandate = mandateByHash(decision.mandate.hash, mandates);
  if (mandate === undefined) return null;
  const used = new Set<VerifierName>();
  const { intent } = decision;
  if (intent === null) return used;
  const matched = mandate.rules.filter((rule) => decision.matchedRules.includes(rule.id));
  if (matched.length === 0) {
    // Nothing matched: the facts the action's rules test in `when`.
    for (const rule of mandate.rules) {
      if (!ruleActions(rule).includes(intent.action)) continue;
      if (rule.when?.["shipment.status"]) used.add("shipment.status");
    }
    return used;
  }
  for (const rule of matched) {
    for (const verifier of rule.require ?? []) used.add(verifier);
    if (rule.when?.["shipment.status"]) used.add("shipment.status");
  }
  return used;
}

// The checks that decided, in trace order: the matched rules' `require`, plus `shipment.status`
// when a matched rule's `when` tests it; with no matched rule, the facts the action's rules test
// in `when`; with a mandate the gate doesn't hold, the whole trace.
export function checksThatDecided(
  decision: Pick<ClaimsDecision, "intent" | "trace" | "matchedRules" | "mandate">,
  mandates: readonly Mandate[],
): TraceEntry[] {
  const used = decidingVerifiers(decision, mandates);
  return decision.trace.filter((entry) => used === null || used.has(entry.verifier));
}

// A Matches or Contradicts reading for a check the message asserted something about, Passes or
// Fails for one it didn't. Anything but pass or fail is No record.
function plainVerdict(result: TraceEntry["result"], asserted: boolean): ClaimVerdict {
  if (result === "pass") return asserted ? "matches" : "passes";
  if (result === "fail") return asserted ? "contradicts" : "fails";
  return "no_record";
}

const SHIPMENT_MATCHES: Record<Claim, readonly ShipmentStatus[]> = {
  not_received: ["lost", "stalled_10d"],
  damaged: ["delivered"],
  wrong_item: ["delivered"],
};

function shipmentVerdict(entry: TraceEntry, claim: Claim | null): ClaimVerdict {
  if (entry.result === "unknown") return "no_record";
  if (entry.result !== "pass") return "fails";
  if (claim === null) return "passes";
  // A pass with no status can't be compared, so it fails closed.
  if (entry.value === undefined) return "no_record";
  return SHIPMENT_MATCHES[claim].includes(entry.value) ? "matches" : "contradicts";
}

function imageCount(ticket: Ticket): number {
  return ticket.attachments.filter((attachment) =>
    attachment.contentType.trim().toLowerCase().startsWith("image/"),
  ).length;
}

// The claim a ticket-based check tests, or the fixed sentence for a ticket that isn't there.
function ticketClaim(intent: Intent, ticket: Ticket | null, text: (ticket: Ticket) => string) {
  if (intent.ticketId === null) return NO_TICKET_NAMED;
  if (ticket === null || ticket.id !== intent.ticketId) {
    return `Ticket ${intent.ticketId} isn't in the ticket store`;
  }
  return text(ticket);
}

function senderOf(ticket: Ticket): string | null {
  return ticket.senderEmail ?? ticket.senderPhone;
}

function claimFor(entry: TraceEntry, intent: Intent, context: ClaimsContext): string | null {
  switch (entry.verifier) {
    case "ticket.from_payer":
      return ticketClaim(intent, context.ticket, (ticket) => {
        const sender = senderOf(ticket);
        return sender === null ? `Ticket ${ticket.id} names no sender` : `Sent from ${sender}`;
      });
    case "shipment.status":
      return intent.claim === null ? null : CLAIM_WORDS[intent.claim];
    case "capture.refundable": {
      const asks = `Asks for ${ACTION_WORDS[intent.action]} ${formatMoney(intent.amount)}`;
      return context.orderNumber === null ? asks : `${asks} on ${context.orderNumber}`;
    }
    case "evidence.photo_present":
      return ticketClaim(intent, context.ticket, (ticket) => {
        const photos = imageCount(ticket);
        if (photos === 0) return "No photo attached";
        return photos === 1 ? "1 photo attached" : `${photos} photos attached`;
      });
    default:
      return null;
  }
}

function verdictFor(entry: TraceEntry, intent: Intent, claim: string | null): ClaimVerdict {
  if (entry.verifier === "shipment.status") return shipmentVerdict(entry, intent.claim);
  return plainVerdict(entry.result, claim !== null);
}

function checkPair(entry: TraceEntry, intent: Intent, context: ClaimsContext): ClaimPair {
  const claim = claimFor(entry, intent, context);
  return {
    check: entry.verifier,
    claim: claim === null ? null : { text: claim, quote: null, simulated: false },
    record: {
      words: VERIFIER_WORDS[entry.verifier],
      detail: entry.detail,
      value: entry.value ?? null,
      sources: entry.records.map(({ call, id }) => ({
        words: sourceWords(call),
        call,
        id: id ?? "none",
      })),
    },
    verdict: verdictFor(entry, intent, claim),
  };
}

function messagePair(ticket: Ticket, mandate: ClaimsDecision["mandate"]): ClaimPair {
  const excerpt = quoteOf(ticket.body);
  const subject = ticket.subject?.trim() ? ticket.subject : null;
  return {
    check: "message",
    claim: {
      text: subject ?? excerpt,
      quote: subject === null ? null : excerpt,
      simulated: ticket.simulated,
    },
    record: {
      words: MESSAGE_RECORD,
      detail: `Mandate ${mandate.id} version ${mandate.version}`,
      value: null,
      sources: [
        {
          words: "Mandate",
          call: "mandate.version",
          id: `${mandate.id}@v${mandate.version}`,
        },
      ],
    },
    verdict: "not_used",
  };
}

// The pairs for one decision: one per check that decided, in trace order, then the message pair
// whenever the ticket exists. A decision with no intent gives the one "couldn't read" pair.
export function claimsVsRecords(decision: ClaimsDecision, context: ClaimsContext): ClaimPair[] {
  const { intent } = decision;
  if (intent === null) {
    return [
      {
        check: "proposal",
        claim: {
          text: UNREADABLE_PROPOSAL_CLAIM,
          quote: quoteOf(decision.proposal),
          simulated: false,
        },
        record: { words: NO_RECORDS_READ, detail: "", value: null, sources: [] },
        verdict: "not_used",
      },
    ];
  }
  const pairs = checksThatDecided(decision, context.mandates).map((entry) =>
    checkPair(entry, intent, context),
  );
  // Only the ticket the intent names counts as its message.
  const { ticket } = context;
  if (ticket !== null && intent.ticketId !== null && ticket.id === intent.ticketId) {
    pairs.push(messagePair(ticket, decision.mandate));
  }
  return pairs;
}
