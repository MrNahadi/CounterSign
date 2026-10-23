import type { Answer } from "./approval-routes";
import {
  type ChainVerdict,
  DECISION_KINDS,
  type DecisionQuery,
  type DecisionRow,
  type DecisionRowsPage,
} from "./audit-schemas";
import { formatTime } from "./time";

// What the Decisions page shows (ADR 0034), worked out from the gate's parsed audit answers. Pure,
// so the page only renders it. Nothing here is guessed: an unreadable row says so, and the chain
// badge comes only from a verdict the gate gave.

export type Tone = "neutral" | "positive" | "warning" | "danger";

export const DECISIONS_COPY = {
  title: "Decisions",
  subtitle: "Every money action your agents proposed, and what the records said.",
  searchLabel: "Search decisions",
  searchPlaceholder: "Order, sender or ID",
  search: "Search",
  filterLabel: "Filter by decision",
  older: "Older decisions",
  empty: "No decisions yet. They appear here when an agent proposes a money action.",
  noMatch: "No decisions match.",
  unreadable: "This entry can't be read.",
  unreadProposal: "Proposal not read",
  noTicket: "No ticket",
  chainIntact: "Chain intact",
  chainBroken: "Chain broken",
  chainUnchecked: "Chain not checked",
  openAuditLog: "Open the audit log",
} as const;

export const DECISION_BADGES = {
  allow: { label: "Allowed", tone: "positive" },
  step_up: { label: "Step-up", tone: "warning" },
  deny: { label: "Denied", tone: "danger" },
} as const satisfies Record<(typeof DECISION_KINDS)[number], { label: string; tone: Tone }>;

type Filters = Pick<DecisionQuery, "decision" | "q">;

export type StatusWords = { words: string; href: string | null };

export type DecisionListRow =
  | {
      readable: true;
      seq: number;
      href: string;
      when: string;
      at: string;
      sender: string | null;
      claim: string | null;
      action: string;
      amount: string | null;
      decision: { label: string; tone: Tone };
      why: { words: string; code: string | null };
      status: StatusWords | null;
      record: string | null;
    }
  | {
      readable: false;
      seq: number;
      href: string;
      when: string;
      at: string;
      why: { words: string; code: null };
      problem: string;
    };

export type Segment = { label: string; count: number; href: string; current: boolean };

export type DecisionsView = {
  rows: DecisionListRow[];
  segments: Segment[];
  search: { q: string; decision: Filters["decision"] | null };
  olderHref: string | null;
  empty: string | null;
};

export type ChainView = {
  label: string;
  tone: Tone;
  line: string;
  link: { href: string; label: string } | null;
};

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

function decisionsHref(query: { decision?: string; q?: string; before?: number }): string {
  const params = new URLSearchParams();
  if (query.decision !== undefined) params.set("decision", query.decision);
  if (query.q !== undefined && query.q !== "") params.set("q", query.q);
  if (query.before !== undefined) params.set("before", String(query.before));
  const text = params.toString();
  return text === "" ? "/decisions" : `/decisions?${text}`;
}

type ReadableRow = Extract<DecisionRow, { readable: true }>;
type Execution = NonNullable<NonNullable<ReadableRow["status"]>["execution"]>;

// What an executed dispute action did, by action (requirements.md, "Audit reader lines").
const DISPUTE_EXECUTED_WORDS = new Map([
  ["paypal.dispute.provide_evidence", "Evidence sent"],
  ["paypal.dispute.accept_claim", "Claim accepted"],
  ["paypal.dispute.make_offer", "Offer sent"],
]);

function executionWords(row: ReadableRow, execution: Execution): string {
  switch (execution.outcome) {
    case "executed":
      return (
        DISPUTE_EXECUTED_WORDS.get(row.action ?? "") ??
        (execution.invoice !== null || row.action === "paypal.invoice.send"
          ? "Invoice sent"
          : "Refunded")
      );
    case "failed":
      return "PayPal refused it";
    case "unknown":
    case "pending":
      return "Not confirmed yet";
  }
}

// Lowercases the first word unless it's a name, such as PayPal.
const lowerFirst = (text: string) =>
  /^[A-Z][a-z]*[A-Z]/.test(text) ? text : text.charAt(0).toLowerCase() + text.slice(1);

/** The Status column's words (requirements.md, "Decisions"); a deny has none. */
export function rowStatusWords(row: ReadableRow): StatusWords | null {
  const status = row.status;
  if (status === null) return null;
  const words = (text: string, href: string | null = null) => ({ words: text, href });
  switch (status.kind) {
    case "executed":
    case "failed":
    case "pending":
      return words(executionWords(row, status.execution));
    case "unknown":
      return words(
        status.execution === null ? "Not confirmed yet" : executionWords(row, status.execution),
      );
    case "not_executable":
      return words("Can't run yet");
    case "open":
      return words("Waiting for you", "/approvals");
    case "approved":
      return words(`Approved, ${lowerFirst(executionWords(row, status.execution))}`);
    case "denied":
      return words("Denied by you");
    case "expired":
      return words("Expired, so denied");
  }
}

function whyOf(row: ReadableRow): { words: string; code: string | null } {
  if (row.decision === "allow") {
    const rule = row.matched_rules[0];
    return { words: rule === undefined ? "Allowed" : `Allowed by rule ${rule}`, code: null };
  }
  const reason = row.reasons[0];
  return reason === undefined
    ? { words: DECISION_BADGES[row.decision].label, code: null }
    : { words: reason.words, code: reason.code };
}

function recordOf(row: ReadableRow): string | null {
  const execution = row.status?.execution ?? null;
  return execution?.refund?.id ?? execution?.invoice?.id ?? row.target?.id ?? null;
}

function listRow(row: DecisionRow, now: Date): DecisionListRow {
  const shared = {
    seq: row.seq,
    href: `/decisions/${row.seq}`,
    when: formatTime(row.at, now),
    at: row.at,
  };
  if (!row.readable) {
    return {
      readable: false,
      ...shared,
      why: { words: DECISIONS_COPY.unreadable, code: null },
      problem: row.problem,
    };
  }
  return {
    readable: true,
    ...shared,
    sender: row.sender,
    claim: row.claim_words,
    action: row.action_words ?? row.action ?? DECISIONS_COPY.unreadProposal,
    amount: row.amount?.display ?? null,
    decision: { ...DECISION_BADGES[row.decision] },
    why: whyOf(row),
    status: rowStatusWords(row),
    record: recordOf(row),
  };
}

/** The Decisions page from one page of rows and the filters that asked for it. */
export function decisionsView(page: DecisionRowsPage, filters: Filters, now: Date): DecisionsView {
  const q = filters.q ?? "";
  const current = filters.decision ?? null;
  const segment = (label: string, count: number, decision: Filters["decision"]) => ({
    label,
    count,
    href: decisionsHref({ decision, q }),
    current: (decision ?? null) === current,
  });
  const searching = q !== "" || current !== null;
  return {
    rows: page.rows.map((row) => listRow(row, now)),
    segments: [
      segment("All", page.counts.all, undefined),
      segment("Allowed", page.counts.allowed, "allow"),
      segment("Step-up", page.counts.stepped_up, "step_up"),
      segment("Denied", page.counts.denied, "deny"),
    ],
    search: { q, decision: current },
    olderHref:
      page.next_before === null
        ? null
        : decisionsHref({ decision: current ?? undefined, q, before: page.next_before }),
    empty:
      page.rows.length > 0
        ? null
        : page.counts.all === 0 && !searching
          ? DECISIONS_COPY.empty
          : DECISIONS_COPY.noMatch,
  };
}

const clockTime = (now: Date) =>
  `${now.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "UTC" })} UTC`;

const auditLink = { href: "/audit", label: DECISIONS_COPY.openAuditLog };

/** The chain card, only ever from the gate's verdict; without one it says it wasn't checked. */
export function chainView(answer: Answer<ChainVerdict>, now: Date): ChainView {
  if (!answer.ok) {
    return {
      label: DECISIONS_COPY.chainUnchecked,
      tone: "neutral",
      line: answer.message,
      link: auditLink,
    };
  }
  const verdict = answer.value;
  if (verdict.intact) {
    return {
      label: DECISIONS_COPY.chainIntact,
      tone: "positive",
      line: `${plural(verdict.entry_count, "entry", "entries")}, checked at ${clockTime(now)}.`,
      link: null,
    };
  }
  return {
    label: DECISIONS_COPY.chainBroken,
    tone: "danger",
    line: `${plural(verdict.problems.length, "problem", "problems")}.`,
    link: auditLink,
  };
}

const isKind = (value: string): value is (typeof DECISION_KINDS)[number] =>
  (DECISION_KINDS as readonly string[]).includes(value);

/**
 * The page's search parameters as the loader's query: only `decision`, `q` and `before`, each
 * when given once as text. Anything else in the address is left out, and the loader reads the
 * rest with zod.
 */
export function decisionFiltersOf(
  params: Record<string, string | string[] | undefined>,
): Pick<DecisionQuery, "decision" | "q"> & { before?: string } {
  const text = (name: string) => {
    const value = params[name];
    return typeof value === "string" && value !== "" ? value : undefined;
  };
  const decision = text("decision");
  const q = text("q");
  const before = text("before");
  return {
    ...(decision !== undefined && isKind(decision) ? { decision } : {}),
    ...(q !== undefined ? { q } : {}),
    ...(before !== undefined ? { before } : {}),
  };
}
