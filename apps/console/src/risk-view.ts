import type { Answer } from "./approval-routes";
import { type AuditDeps, loadDecisions } from "./audit-routes";
import type { ChainVerdict, DecisionRow } from "./audit-schemas";
import { type VerdictView, verdictView } from "./audit-view";
import { DECISION_BADGES } from "./decisions-view";
import { type RefundSpike, refundSpike, SPIKE_RULE } from "./risk-spike";
import { formatTime } from "./time";

// The Risk desk (brief §5 item 11): money protected, decisions by reason code and the chain's
// status, all read from the gate's audit API and worked out here, so the page and its AG Studio
// or AG Grid widgets only render them. Nothing here writes anything or decides anything.

export const RISK_COPY = {
  title: "Risk desk",
  subtitle: "What the gate refused, why, and whether the log behind it is intact.",
  signInLine: "Sign in with the approver key to see the Risk desk.",
  moneyTitle: "Money protected",
  moneyLine: (count: number) =>
    count === 0
      ? "No money action has been denied yet."
      : `Kept from moving: the amounts of ${plural(count, "denied action", "denied actions")}.`,
  reasonsTitle: "Decisions by reason code",
  reasonsLine: "A decision with more than one reason counts under each.",
  chainTitle: "Chain status",
  chainBadge: { positive: "Intact", danger: "Broken", neutral: "Not checked" },
  decisionsTitle: "Decisions",
  noReason: "NO_REASON_CODE",
  communityNote: "AG Grid Community view. The AG Studio desk needs its licence key.",
  spikeTitle: "Refund spike",
  spikeBadge: { spike: "Spike", normal: "Normal", unknown: "Not checked" },
  spikeHeading: (recent: number, daily: string) =>
    `${plural(recent, "refund", "refunds")} proposed in the last 24 hours, against ${daily} a day over the 7 days before.`,
  spikeAsked: (asked: string, denied: number, held: number) =>
    `${asked} asked for: ${denied.toLocaleString("en-US")} denied, ${held.toLocaleString("en-US")} held for approval.`,
  spikeRule: `Alerts at ${SPIKE_RULE.minRefunds} or more in 24 hours and ${SPIKE_RULE.factor} times the daily average. It only alerts: the gate decides every refund.`,
} as const;

/** Pages of decisions the desk reads, newest first: at most 1,000 decisions. */
export const RISK_PAGE_SIZE = 200;
export const RISK_MAX_PAGES = 5;

/** The currency the desk charts. The sandbox merchant sells in USD (M-Pesa is cut). */
export const RISK_CHART_CURRENCY = "USD";

const plural = (count: number, one: string, many: string) =>
  `${count.toLocaleString("en-US")} ${count === 1 ? one : many}`;

export type RiskDecisions = {
  rows: DecisionRow[];
  /** Every decision the gate has, read from the first page's counts. */
  total: number;
  /** False when the desk stopped before the oldest decision. */
  complete: boolean;
};

/**
 * The newest decisions, a page at a time, up to `RISK_MAX_PAGES`. Any refused page refuses the
 * whole read, so the desk never adds up part of the log as if it were all of it. A cursor that
 * doesn't move on, or a page with nothing new, ends the read as incomplete.
 */
export async function loadRiskDecisions(
  key: string,
  deps: AuditDeps,
): Promise<Answer<RiskDecisions>> {
  const rows: DecisionRow[] = [];
  const seen = new Set<number>();
  let total = 0;
  let before: number | undefined;
  for (let page = 0; page < RISK_MAX_PAGES; page++) {
    const query = {
      limit: String(RISK_PAGE_SIZE),
      ...(before === undefined ? {} : { before: String(before) }),
    };
    const answer = await loadDecisions(key, query, deps);
    if (!answer.ok) return answer;
    if (page === 0) total = answer.value.counts.all;
    let added = 0;
    for (const row of answer.value.rows) {
      if (seen.has(row.seq)) continue;
      seen.add(row.seq);
      rows.push(row);
      added++;
    }
    const next = answer.value.next_before;
    if (next === null) return { ok: true, value: { rows, total, complete: true } };
    if (added === 0 || (before !== undefined && next >= before)) break;
    before = next;
  }
  return { ok: true, value: { rows, total, complete: false } };
}

// --- The view ------------------------------------------------------------------------------

type Kind = keyof typeof DECISION_BADGES;

export type MoneyLine = { currency: string; minor: number; display: string; count: number };

export type MoneyProtectedView = {
  /** The USD total always, then any other currency with money in it. */
  value: string;
  totals: MoneyLine[];
  line: string;
};

export type ReasonRow = {
  code: string;
  allow: number;
  step_up: number;
  deny: number;
  total: number;
};

/** One readable decision, flat, for the grids and AG Studio's data source. */
export type RiskRow = {
  seq: number;
  at: string;
  when: string;
  /** The day it was decided, `YYYY-MM-DD`, for Studio's date fields. */
  day: string;
  principal: string;
  action: string;
  /** The gate's action name, such as `paypal.refund`, or null when the log has none. */
  actionName: string | null;
  decision: string;
  reasonCode: string;
  claim: string;
  amountDisplay: string | null;
  amountMinor: number | null;
  /** Major units, set only for `RISK_CHART_CURRENCY`, so a chart never mixes currencies. */
  amount: number | null;
  protectedAmount: number;
};

/** One row per decision and reason code, for the chart of decisions by reason. */
export type ReasonPair = { seq: number; decision: string; reasonCode: string };

export type ChainView = VerdictView & { badge: string };

export type SpikeView = RefundSpike & {
  tone: "danger" | "positive" | "neutral";
  badge: string;
  heading: string;
  asked: string;
  rule: string;
};

export type RiskView = {
  /** When the desk read the log, ISO: the "now" its periods are counted back from. */
  asOf: string;
  /** Which decisions the desk read: all of them, or the newest so many. */
  window: string;
  money: MoneyProtectedView;
  reasons: ReasonRow[];
  reasonPairs: ReasonPair[];
  chain: ChainView;
  spike: SpikeView;
  rows: RiskRow[];
  /** What the numbers leave out, each said once. */
  notes: string[];
};

const fractionDigits = (currency: string) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency }).resolvedOptions()
    .maximumFractionDigits ?? 2;

const majorOf = (minor: number, currency: string) => minor / 10 ** fractionDigits(currency);

/** A total in minor units, written the way the console writes money. */
export function formatMinor(minor: number, currency: string): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(
    majorOf(minor, currency),
  );
}

const dayOf = (at: string) => (/^\d{4}-\d{2}-\d{2}/.test(at) ? at.slice(0, 10) : at);

function moneyProtected(rows: Extract<DecisionRow, { readable: true }>[]): MoneyProtectedView {
  const totals = new Map<string, MoneyLine>();
  totals.set(RISK_CHART_CURRENCY, {
    currency: RISK_CHART_CURRENCY,
    minor: 0,
    display: "",
    count: 0,
  });
  let count = 0;
  for (const row of rows) {
    if (row.decision !== "deny" || row.amount === null) continue;
    const { currency, minor } = row.amount;
    const line = totals.get(currency) ?? { currency, minor: 0, display: "", count: 0 };
    line.minor += minor;
    line.count++;
    totals.set(currency, line);
    count++;
  }
  const lines = [...totals.values()]
    .filter((line) => line.currency === RISK_CHART_CURRENCY || line.count > 0)
    .map((line) => ({ ...line, display: formatMinor(line.minor, line.currency) }));
  return {
    value: lines.map((line) => line.display).join(" + "),
    totals: lines,
    line: RISK_COPY.moneyLine(count),
  };
}

function reasonRows(pairs: ReasonPair[]): ReasonRow[] {
  const byCode = new Map<string, ReasonRow>();
  for (const pair of pairs) {
    const row = byCode.get(pair.reasonCode) ?? {
      code: pair.reasonCode,
      allow: 0,
      step_up: 0,
      deny: 0,
      total: 0,
    };
    row[pair.decision as Kind]++;
    row.total++;
    byCode.set(pair.reasonCode, row);
  }
  return [...byCode.values()].sort((a, b) => b.total - a.total || a.code.localeCompare(b.code));
}

/** The chain's status card, from a check the gate ran. Without one it says not checked. */
export function chainView(answer: Answer<ChainVerdict>): ChainView {
  const view = verdictView(answer);
  const badge =
    view.tone === "positive" || view.tone === "danger"
      ? RISK_COPY.chainBadge[view.tone]
      : RISK_COPY.chainBadge.neutral;
  return { ...view, badge };
}

/**
 * The Risk desk from the decisions it read and a fresh chain check. Unreadable decisions are left
 * out of every number and counted in a note; amounts in another currency are added up in the
 * money tile but left out of the charted amounts.
 */
export function riskView(
  decisions: RiskDecisions,
  verdict: Answer<ChainVerdict>,
  now: Date,
): RiskView {
  const readable = decisions.rows.filter(
    (row): row is Extract<DecisionRow, { readable: true }> => row.readable,
  );
  const unreadable = decisions.rows.length - readable.length;

  const reasonPairs: ReasonPair[] = readable.flatMap((row) => {
    const codes = row.reasons.length === 0 ? [RISK_COPY.noReason] : row.reasons.map((r) => r.code);
    return [...new Set(codes)].map((reasonCode) => ({
      seq: row.seq,
      decision: row.decision,
      reasonCode,
    }));
  });

  let otherCurrency = 0;
  const rows: RiskRow[] = readable.map((row) => {
    const charted = row.amount?.currency === RISK_CHART_CURRENCY;
    if (row.amount !== null && !charted) otherCurrency++;
    const amount =
      charted && row.amount !== null ? majorOf(row.amount.minor, row.amount.currency) : null;
    return {
      seq: row.seq,
      at: row.at,
      when: formatTime(row.at, now),
      day: dayOf(row.at),
      principal: row.principal,
      action: row.action_words ?? row.action ?? "Unknown action",
      actionName: row.action,
      decision: DECISION_BADGES[row.decision].label,
      reasonCode: row.reasons[0]?.code ?? RISK_COPY.noReason,
      claim: row.claim_words ?? "None",
      amountDisplay: row.amount?.display ?? null,
      amountMinor: row.amount?.minor ?? null,
      amount,
      protectedAmount: row.decision === "deny" && amount !== null ? amount : 0,
    };
  });

  const notes: string[] = [];
  if (unreadable > 0) {
    notes.push(
      `${plural(unreadable, "decision", "decisions")} couldn't be read and ${unreadable === 1 ? "isn't" : "aren't"} counted.`,
    );
  }
  if (otherCurrency > 0) {
    notes.push(
      `${plural(otherCurrency, "decision", "decisions")} in a currency other than ${RISK_CHART_CURRENCY} ${otherCurrency === 1 ? "is" : "are"} left out of the charted amounts.`,
    );
  }

  const read = decisions.rows.length;
  const window =
    decisions.complete && read >= decisions.total
      ? `Read from all ${plural(read, "decision", "decisions")} in the audit log.`
      : `Read from the newest ${plural(read, "decision", "decisions")} of ${decisions.total.toLocaleString("en-US")} in the audit log.`;

  return {
    asOf: now.toISOString(),
    window,
    money: moneyProtected(readable),
    reasons: reasonRows(reasonPairs),
    reasonPairs: reasonPairs.map((pair) => ({
      ...pair,
      decision: DECISION_BADGES[pair.decision as Kind].label,
    })),
    chain: chainView(verdict),
    spike: spikeView(decisions, readable, now),
    rows,
    notes,
  };
}

/** The refund-spike card: the alert from `risk-spike.ts`, in the desk's words. */
function spikeView(
  decisions: RiskDecisions,
  readable: Extract<DecisionRow, { readable: true }>[],
  now: Date,
): SpikeView {
  const spike = refundSpike(
    readable.map((row) => ({
      at: row.at,
      actionName: row.action,
      decision: row.decision,
      usdMinor: row.amount?.currency === RISK_CHART_CURRENCY ? row.amount.minor : null,
    })),
    {
      complete: decisions.complete && decisions.rows.length >= decisions.total,
      unreadableAt: decisions.rows.filter((row) => !row.readable).map((row) => row.at),
    },
    now,
  );
  const tone =
    spike.status === "spike" ? "danger" : spike.status === "normal" ? "positive" : "neutral";
  return {
    ...spike,
    tone,
    badge: RISK_COPY.spikeBadge[spike.status],
    heading: RISK_COPY.spikeHeading(spike.recent, spike.baselineDaily),
    asked: RISK_COPY.spikeAsked(
      formatMinor(spike.recentUsdMinor, RISK_CHART_CURRENCY),
      spike.recentDenied,
      spike.recentHeld,
    ),
    rule: RISK_COPY.spikeRule,
  };
}
