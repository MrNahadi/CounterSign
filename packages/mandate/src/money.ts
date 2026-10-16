// Money is an integer count of minor units plus a currency. Never a float.

export const CURRENCIES = ["USD", "KES"] as const;
export type Currency = (typeof CURRENCIES)[number];

export type Money = { minor: number; currency: Currency };

export type MoneyParse = { ok: true; money: Money } | { ok: false; error: string };

// Digits only, no leading zero on the whole part, at most two decimals.
const DECIMAL = /^(0|[1-9][0-9]*)(?:\.([0-9]{1,2}))?$/;

export function isCurrency(value: unknown): value is Currency {
  return (CURRENCIES as readonly unknown[]).includes(value);
}

// Reads a decimal amount string, such as "96.00", into minor units.
export function parseMoney(value: string, currency: string): MoneyParse {
  if (!isCurrency(currency)) return { ok: false, error: `Unsupported currency ${currency}` };
  if (typeof value !== "string") return { ok: false, error: "Amount must be a string" };
  const match = DECIMAL.exec(value);
  if (!match) return { ok: false, error: `Malformed amount ${value}` };
  const [, whole, fraction = ""] = match;
  const minor = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  if (!Number.isSafeInteger(minor)) return { ok: false, error: `Amount ${value} is too large` };
  if (minor === 0) return { ok: false, error: "Amount must be greater than zero" };
  return { ok: true, money: { minor, currency } };
}

function groupThousands(whole: number): string {
  return String(whole).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

// "$96.00" and "KSh 4,500". Shillings show cents only when there are some.
export function formatMoney(money: Money): string {
  if (!Number.isSafeInteger(money.minor) || money.minor < 0) {
    throw new RangeError(`Can't format ${money.minor} minor units`);
  }
  const whole = groupThousands(Math.trunc(money.minor / 100));
  const cents = String(money.minor % 100).padStart(2, "0");
  if (money.currency === "USD") return `$${whole}.${cents}`;
  return cents === "00" ? `KSh ${whole}` : `KSh ${whole}.${cents}`;
}
