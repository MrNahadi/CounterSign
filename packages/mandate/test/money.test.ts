import { describe, expect, it } from "vitest";
import { formatMoney, parseMoney } from "../src/index";

describe("parseMoney", () => {
  it.each([
    ["12.00", "USD", 1200],
    ["12.5", "USD", 1250],
    ["12", "USD", 1200],
    ["0.01", "USD", 1],
    ["4500", "KES", 450000],
    ["40500.75", "KES", 4050075],
  ])("reads %s %s as %i minor units", (value, currency, minor) => {
    expect(parseMoney(value, currency)).toEqual({ ok: true, money: { minor, currency } });
  });

  it.each([
    ["-12.00", "a sign"],
    ["+12.00", "a sign"],
    ["1e3", "an exponent"],
    ["1E3", "an exponent"],
    ["12.345", "more than two decimals"],
    ["1,200.00", "a thousands separator"],
    ["1 200", "a space"],
    ["0", "zero"],
    ["0.00", "zero"],
    ["", "an empty string"],
    [".5", "no whole part"],
    ["12.", "a trailing point"],
    [" 12", "outer spaces"],
    ["012", "a leading zero"],
    ["Infinity", "a non-number"],
    ["99999999999999999", "an unsafe amount"],
  ])("rejects %j (%s)", (value) => {
    expect(parseMoney(value, "USD").ok).toBe(false);
  });

  it.each(["EUR", "usd", "", "KSH"])("rejects currency %j", (currency) => {
    expect(parseMoney("12.00", currency).ok).toBe(false);
  });

  it("rejects a value that isn't a string", () => {
    expect(parseMoney(12 as unknown as string, "USD").ok).toBe(false);
  });
});

describe("formatMoney", () => {
  it.each([
    [{ minor: 9600, currency: "USD" }, "$96.00"],
    [{ minor: 1800, currency: "USD" }, "$18.00"],
    [{ minor: 5, currency: "USD" }, "$0.05"],
    [{ minor: 124050, currency: "USD" }, "$1,240.50"],
    [{ minor: 450000, currency: "KES" }, "KSh 4,500"],
    [{ minor: 1500000, currency: "KES" }, "KSh 15,000"],
    [{ minor: 4050075, currency: "KES" }, "KSh 40,500.75"],
    [{ minor: 50000, currency: "KES" }, "KSh 500"],
  ] as const)("formats %j as %s", (money, text) => {
    expect(formatMoney(money)).toBe(text);
  });

  it.each([
    { minor: -150, currency: "USD" },
    { minor: 1.5, currency: "USD" },
    { minor: Number.NaN, currency: "KES" },
  ] as const)("refuses to format %j", (money) => {
    expect(() => formatMoney(money)).toThrow();
  });
});
