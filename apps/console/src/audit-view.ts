import type { Answer } from "./approval-routes";
import type { ChainVerdict, EntryPage } from "./audit-schemas";
import { hashView } from "./decision-view";
import { formatTime } from "./time";

// What the Audit log page shows (ADR 0034), worked out from the gate's parsed answers. Pure, so
// the page only renders it. The chain line comes only from a verdict the gate gave; without one
// it says the chain wasn't checked, never that it's intact.

export const AUDIT_COPY = {
  title: "Audit log",
  subtitle: "Every entry, hash-chained. Each one's hash covers the one before it.",
  check: "Check the chain",
  older: "Older entries",
  empty: "No entries yet. They appear here when the gate records something.",
  unreadable: "This entry can't be read.",
} as const;

export type Tone = "neutral" | "positive" | "warning" | "danger";

export type EntryRow = {
  seq: number;
  at: string;
  when: string;
  type: string;
  summary: string;
  ref: string | null;
  hash: { short: string; full: string };
  href: string | null;
};

export type VerdictView = {
  tone: Tone;
  heading: string;
  problems: { seq: number; code: string; detail: string }[];
};

export type AuditView = {
  total: string;
  rows: EntryRow[];
  olderHref: string | null;
  empty: string | null;
  checkHref: string;
  verdict: VerdictView | null;
};

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

export const CHECK_PARAM = "check";

/** The page's address for a page of entries, keeping the check when it was asked for. */
export function auditHref(query: { before?: number; check?: boolean }): string {
  const params = new URLSearchParams();
  if (query.before !== undefined) params.set("before", String(query.before));
  if (query.check === true) params.set(CHECK_PARAM, "1");
  const text = params.toString();
  return text === "" ? "/audit" : `/audit?${text}`;
}

/** The chain check's result: the line the page shows and one line per problem. */
export function verdictView(answer: Answer<ChainVerdict>): VerdictView {
  if (!answer.ok) return { tone: "neutral", heading: answer.message, problems: [] };
  const verdict = answer.value;
  if (verdict.intact) {
    const head = verdict.head === null ? "" : ` Head #${verdict.head.seq} ${verdict.head.hash}.`;
    return {
      tone: "positive",
      heading: `Chain intact: ${plural(verdict.entry_count, "entry", "entries")}.${head}`,
      problems: [],
    };
  }
  return {
    tone: "danger",
    heading: `Chain broken: ${plural(verdict.problems.length, "problem", "problems")}.`,
    problems: verdict.problems.map(({ seq, code, detail }) => ({ seq, code, detail })),
  };
}

/**
 * The Audit log page from one page of entries. `verdict` is the chain check, given only when the
 * merchant asked for it; paging keeps the check in the address so the result stays in view.
 */
export function auditView(
  page: EntryPage,
  verdict: Answer<ChainVerdict> | null,
  now: Date,
): AuditView {
  return {
    total: plural(page.total, "entry", "entries"),
    rows: page.entries.map((entry) => ({
      seq: entry.seq,
      at: entry.at,
      when: formatTime(entry.at, now),
      type: entry.type,
      summary: entry.readable ? entry.summary : (entry.problem ?? AUDIT_COPY.unreadable),
      ref: entry.ref,
      hash: hashView(entry.hash),
      href: entry.type === "decision" ? `/decisions/${entry.seq}` : null,
    })),
    olderHref:
      page.next_before === null
        ? null
        : auditHref({ before: page.next_before, check: verdict !== null }),
    empty: page.entries.length === 0 ? AUDIT_COPY.empty : null,
    checkHref: auditHref({ check: true }),
    verdict: verdict === null ? null : verdictView(verdict),
  };
}

/** The page's `before` cursor and whether the check was asked for, from its address. */
export function auditParamsOf(params: Record<string, string | string[] | undefined>): {
  before?: string;
  check: boolean;
} {
  const before = params.before;
  return {
    ...(typeof before === "string" && before !== "" ? { before } : {}),
    check: params[CHECK_PARAM] === "1",
  };
}
