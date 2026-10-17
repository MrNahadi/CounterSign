// Today's usage: what the principal has already executed today, per currency, which the
// mandate's daily limits are checked against.

import type { Currency, Money } from "./money";

export type CurrencyUsage = { count: number; total: Money };

// `date` is today's calendar date in the mandate's time zone, as YYYY-MM-DD. Unknown usage
// escalates an allow to step-up (DAILY_LIMIT_UNKNOWN).
export type Usage =
  | { known: true; date: string; perCurrency: Record<Currency, CurrencyUsage> }
  | { known: false; detail: string };
