import { describe, expect, it } from "vitest";
import { type ExecutionSnapshot, todaysUsage } from "../src/index";
import { execution } from "./fixtures";

const today = {
  principal: "support-agent",
  timeZone: "Africa/Nairobi",
  // 13:00 on 17 Oct in Nairobi.
  now: new Date("2026-10-17T10:00:00Z"),
};

function at(id: string, executedAt: string, change: Partial<ExecutionSnapshot> = {}) {
  return { ...execution, id, executedAt, ...change };
}

describe("todaysUsage", () => {
  it("counts the principal's executions today, per currency", () => {
    const executions = [
      at("exe_1", "2026-10-17T06:40:00Z"),
      at("exe_2", "2026-10-17T09:59:00Z", { amount: { minor: 1800, currency: "USD" } }),
      at("exe_3", "2026-10-17T08:00:00Z", { amount: { minor: 450000, currency: "KES" } }),
    ];
    expect(todaysUsage({ executions }, today)).toEqual({
      known: true,
      date: "2026-10-17",
      perCurrency: {
        USD: { count: 2, total: { minor: 4300, currency: "USD" } },
        KES: { count: 1, total: { minor: 450000, currency: "KES" } },
      },
    });
  });

  it("is zero in every currency when nothing has executed", () => {
    expect(todaysUsage({ executions: [] }, today)).toEqual({
      known: true,
      date: "2026-10-17",
      perCurrency: {
        USD: { count: 0, total: { minor: 0, currency: "USD" } },
        KES: { count: 0, total: { minor: 0, currency: "KES" } },
      },
    });
  });

  it("leaves out other principals' executions", () => {
    const executions = [at("exe_1", "2026-10-17T06:40:00Z", { principal: "ops-agent" })];
    const usage = todaysUsage({ executions }, today);
    expect(usage.known && usage.perCurrency.USD.count).toBe(0);
  });

  it("counts an execution at 23:30 UTC as the next day in Africa/Nairobi", () => {
    // 02:30 on 17 Oct in Nairobi.
    const executions = [at("exe_1", "2026-10-16T23:30:00Z")];
    const usage = todaysUsage({ executions }, today);
    expect(usage.known && usage.perCurrency.USD).toEqual({
      count: 1,
      total: { minor: 2500, currency: "USD" },
    });
  });

  it("leaves out an execution from yesterday in the mandate's time zone", () => {
    // 23:30 on 16 Oct in Nairobi.
    const executions = [at("exe_1", "2026-10-16T20:30:00Z")];
    const usage = todaysUsage({ executions }, today);
    expect(usage.known && usage.perCurrency.USD.count).toBe(0);
  });

  it("uses the mandate's own time zone", () => {
    const executions = [at("exe_1", "2026-10-16T23:30:00Z")];
    const usage = todaysUsage({ executions }, { ...today, timeZone: "UTC" });
    expect(usage).toMatchObject({ known: true, date: "2026-10-17" });
    expect(usage.known && usage.perCurrency.USD.count).toBe(0);
  });

  it("dates today in the mandate's time zone", () => {
    // 00:30 on 18 Oct in Nairobi, still 17 Oct in UTC.
    const usage = todaysUsage(
      { executions: [] },
      { ...today, now: new Date("2026-10-17T21:30:00Z") },
    );
    expect(usage).toMatchObject({ known: true, date: "2026-10-18" });
  });

  it("is unknown without an execution history", () => {
    expect(todaysUsage({}, today).known).toBe(false);
  });

  it.each([
    "2026-10-17T06:40:00",
    "2026-10-17T06:40Z",
    "17 Oct 2026",
    "2026-10-17T25:00:00Z",
    "2026-02-31T10:00:00Z",
    "2026-02-29T10:00:00+03:00",
    "",
  ])("is unknown when one of the principal's executions has the time %j", (executedAt) => {
    const executions = [at("exe_1", "2026-10-17T06:40:00Z"), at("exe_2", executedAt)];
    expect(todaysUsage({ executions }, today)).toEqual({
      known: false,
      detail: `Execution exe_2 has an unreadable time`,
    });
  });

  it.each([-2500, 12.5, Number.NaN])(
    "is unknown when one of the principal's executions has the amount %d",
    (minor) => {
      const executions = [
        at("exe_1", "2026-10-17T06:40:00Z"),
        at("exe_2", "2026-10-17T07:00:00Z", { amount: { minor, currency: "USD" } }),
      ];
      expect(todaysUsage({ executions }, today)).toEqual({
        known: false,
        detail: "Execution exe_2 has a malformed amount",
      });
    },
  );

  it("is unknown when one of the principal's executions is in an unknown currency", () => {
    const amount = { minor: 2500, currency: "EUR" } as unknown as ExecutionSnapshot["amount"];
    const executions = [at("exe_2", "2026-10-17T07:00:00Z", { amount })];
    expect(todaysUsage({ executions }, today)).toEqual({
      known: false,
      detail: "Execution exe_2 has a malformed amount",
    });
  });

  it("is unknown when the principal's total for a currency would pass the safe-integer range", () => {
    const executions = [
      at("exe_1", "2026-10-17T06:40:00Z", {
        amount: { minor: Number.MAX_SAFE_INTEGER, currency: "USD" },
      }),
      at("exe_2", "2026-10-17T07:00:00Z", { amount: { minor: 1, currency: "USD" } }),
    ];
    expect(todaysUsage({ executions }, today)).toEqual({
      known: false,
      detail: "Today's USD total is too large to count at execution exe_2",
    });
  });

  it("counts a total of exactly the largest safe integer", () => {
    const executions = [
      at("exe_1", "2026-10-17T06:40:00Z", {
        amount: { minor: Number.MAX_SAFE_INTEGER - 1, currency: "USD" },
      }),
      at("exe_2", "2026-10-17T07:00:00Z", { amount: { minor: 1, currency: "USD" } }),
    ];
    const usage = todaysUsage({ executions }, today);
    expect(usage.known && usage.perCurrency.USD.total.minor).toBe(Number.MAX_SAFE_INTEGER);
  });

  it("is unknown when now isn't a valid time", () => {
    expect(todaysUsage({ executions: [] }, { ...today, now: new Date(Number.NaN) }).known).toBe(
      false,
    );
  });
});
