// The Risk desk's refund-spike alert (brief §5 item 11): refunds agents proposed in the last 24
// hours against the daily average of the 7 days before, counted from the audit log's decisions.
// Fixed rules, no model. It only reports: nothing here holds, denies or moves money. When the desk
// can't see every decision in those 8 days it never says "Normal".

export const REFUND_ACTION = "paypal.refund";
export const SPIKE_RULE = {
  windowHours: 24,
  baselineDays: 7,
  /** No alert below this many refunds in the window, however quiet the week before. */
  minRefunds: 5,
  /** An alert needs the window to reach this many times the baseline's daily average. */
  factor: 3,
} as const;

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

export type SpikeStatus = "spike" | "normal" | "unknown";

/** What the alert reads from each decision. `at` is the gate's ISO time. */
export type SpikeInput = {
  at: string;
  actionName: string | null;
  decision: "allow" | "step_up" | "deny";
  /** USD minor units, or null when there's no amount or it's another currency. */
  usdMinor: number | null;
};

export type SpikeCoverage = {
  /** Every decision in the log was read. */
  complete: boolean;
  /** The times of decisions that couldn't be read: their action is unknown. */
  unreadableAt: string[];
};

export type RefundSpike = {
  status: SpikeStatus;
  /** Refund proposals in the last 24 hours. */
  recent: number;
  /** Refund proposals in the 7 days before that. */
  baseline: number;
  /** `baseline / 7`, one decimal, for the card. */
  baselineDaily: string;
  /** What the recent refunds asked for, in USD minor units. */
  recentUsdMinor: number;
  recentDenied: number;
  recentHeld: number;
  /** Why the desk can't call it normal; null when it read everything it needed. */
  unknownWhy: string | null;
};

/**
 * The alert from the decisions the desk read, as of `now`. "spike" needs at least `minRefunds`
 * refunds in the window and `factor` times the baseline's daily average, among the decisions
 * read; "normal" needs every decision in the 8 days to be read and readable; anything short of
 * that is "unknown", with `unknownWhy` (which a spike also keeps, as a caveat).
 */
export function refundSpike(rows: SpikeInput[], coverage: SpikeCoverage, now: Date): RefundSpike {
  const end = now.getTime();
  const windowStart = end - SPIKE_RULE.windowHours * HOUR_MS;
  const baselineStart = windowStart - SPIKE_RULE.baselineDays * DAY_MS;

  let recent = 0;
  let baseline = 0;
  let recentUsdMinor = 0;
  let recentDenied = 0;
  let recentHeld = 0;
  let badTimes = 0;
  let oldest = Number.POSITIVE_INFINITY;
  for (const row of rows) {
    const at = Date.parse(row.at);
    if (Number.isNaN(at)) {
      badTimes++;
      continue;
    }
    oldest = Math.min(oldest, at);
    if (row.actionName !== REFUND_ACTION || at > end || at <= baselineStart) continue;
    if (at > windowStart) {
      recent++;
      recentUsdMinor += row.usdMinor ?? 0;
      if (row.decision === "deny") recentDenied++;
      if (row.decision === "step_up") recentHeld++;
    } else {
      baseline++;
    }
  }

  const unreadableInSpan = coverage.unreadableAt.filter((value) => {
    const at = Date.parse(value);
    return Number.isNaN(at) || at > baselineStart;
  }).length;
  const reachesBack = coverage.complete || oldest <= baselineStart;

  // recent >= factor * baseline / baselineDays, in integers.
  const spike =
    recent >= SPIKE_RULE.minRefunds &&
    recent * SPIKE_RULE.baselineDays >= SPIKE_RULE.factor * baseline;

  let unknownWhy: string | null = null;
  if (badTimes > 0) {
    unknownWhy = `${badTimes === 1 ? "A decision has" : `${badTimes} decisions have`} a time the desk can't read.`;
  } else if (unreadableInSpan > 0) {
    unknownWhy = `${unreadableInSpan === 1 ? "A decision" : `${unreadableInSpan} decisions`} in the last 8 days couldn't be read.`;
  } else if (!reachesBack) {
    unknownWhy = "The decisions the desk read don't reach back 8 days.";
  }

  return {
    // A spike in what was read is shown even when the read is short: an alert leans to alerting.
    status: spike ? "spike" : unknownWhy !== null ? "unknown" : "normal",
    recent,
    baseline,
    baselineDaily: (baseline / SPIKE_RULE.baselineDays).toFixed(1),
    recentUsdMinor,
    recentDenied,
    recentHeld,
    unknownWhy,
  };
}
