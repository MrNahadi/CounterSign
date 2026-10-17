// Today's usage: the principal's executed money actions on today's calendar date in the
// mandate's time zone (ADR 0019), counted and totalled per currency.

import {
  CURRENCIES,
  type Currency,
  type CurrencyUsage,
  isCurrency,
  isMinorUnits,
  TimestampSchema,
  type Usage,
} from "@countersign/mandate";
import type { RecordSnapshots } from "./snapshots";

// Whose usage, the mandate's IANA time zone, and the moment that says which day is today.
export type UsageScope = { principal: string; timeZone: string; now: Date };

// The shared timestamp rule, checked before parsing, since date parsing rolls 31 Feb over to 3 Mar.
function readTime(value: string): Date | null {
  if (!TimestampSchema.safeParse(value).success) return null;
  const time = new Date(value);
  return Number.isNaN(time.getTime()) ? null : time;
}

// The calendar date in the time zone as YYYY-MM-DD, or null if either can't be read.
function dateIn(time: Date, timeZone: string): string | null {
  if (Number.isNaN(time.getTime())) return null;
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(time);
    const part = (type: string) => parts.find((each) => each.type === type)?.value;
    return `${part("year")}-${part("month")}-${part("day")}`;
  } catch {
    return null;
  }
}

// Unknown without a history, or when any of the principal's executions can't be placed on a day
// or counted.
export function todaysUsage(records: RecordSnapshots, scope: UsageScope): Usage {
  if (!records.executions) return { known: false, detail: "No execution history" };
  const date = dateIn(scope.now, scope.timeZone);
  if (!date) return { known: false, detail: `Can't date now in ${scope.timeZone}` };
  const perCurrency = Object.fromEntries(
    CURRENCIES.map((currency) => [currency, { count: 0, total: { minor: 0, currency } }]),
  ) as Record<Currency, CurrencyUsage>;
  for (const execution of records.executions) {
    if (execution.principal !== scope.principal) continue;
    const time = readTime(execution.executedAt);
    if (!time) return { known: false, detail: `Execution ${execution.id} has an unreadable time` };
    // A negative or fractional amount would make the day's total look smaller than it is.
    const { amount } = execution;
    if (!isMinorUnits(amount.minor) || !isCurrency(amount.currency)) {
      return { known: false, detail: `Execution ${execution.id} has a malformed amount` };
    }
    if (dateIn(time, scope.timeZone) !== date) continue;
    const usage = perCurrency[amount.currency];
    usage.count += 1;
    usage.total.minor += amount.minor;
    // Past the safe-integer range a sum loses precision, so the day's total can't be trusted.
    if (!Number.isSafeInteger(usage.total.minor)) {
      return {
        known: false,
        detail: `Today's ${amount.currency} total is too large to count at execution ${execution.id}`,
      };
    }
  }
  return { known: true, date, perCurrency };
}
