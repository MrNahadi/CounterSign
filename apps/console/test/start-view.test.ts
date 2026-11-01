import { LAUNCHER_SCENARIOS } from "@countersign/resolve-agent/src/scenarios";
import { describe, expect, it } from "vitest";
import type { ResetReport } from "../src/demo-schemas";
import { resetSentence, SCENARIO_CARDS, START_COPY, storefrontLink } from "../src/start-view";

const NUMBERS = (count: number) =>
  Array.from({ length: count }, (_, index) => `KIK-${1013 + index}`);

type Over = Partial<Omit<ResetReport, "orders">> & { orders?: Partial<ResetReport["orders"]> };

const report = (over: Over): ResetReport => {
  const { orders, ...rest } = over;
  return {
    complete: true,
    reset_at: "2026-11-01T10:00:00.000Z",
    took_ms: 14_600,
    orders: { kept: 27, replaced: NUMBERS(3), run_id: "run-1", failed: [], ...orders },
    cleared: {
      previous_head: { seq: 41, hash: "3f9a" },
      entries: 41,
      tickets: 2,
      attachments: 1,
      runs: 2,
      drafts: 0,
      documents: 0,
    },
    disputes: { recorded: 1, already_recorded: 0, problems: 0 },
    ...rest,
  };
};

describe("The start page's copy", () => {
  it("pins the heading, line, steps and the real and simulated lists", () => {
    expect(START_COPY.title).toBe("Start here · Countersign console");
    expect(START_COPY.heading).toBe("Start here");
    expect(START_COPY.line).toBe(
      "Countersign checks every money action an AI agent proposes against PayPal's records and your rules. The agent's words never approve a payment.",
    );
    expect(START_COPY.stepsHeading).toBe("In about a minute");
    expect(START_COPY.steps).toEqual([
      "Sign in with the approver key from the testing instructions.",
      "Run the attack email in baseline mode, then protected, and compare what moved.",
      "Run the stalled parcel and the damaged basket. Each opens in the inbox, linked to its decisions.",
      "Scan the code below to open Approvals on your phone, already signed in, and approve the waiting refund. The Approvals page here works too.",
      "Reset the demo when you're done, so the next person starts fresh.",
    ]);
    expect(START_COPY.real).toEqual({
      label: "What's real",
      text: "PayPal sandbox orders, captures, refunds, disputes and webhooks, and Countersign's decisions, approvals and audit log.",
    });
    expect(START_COPY.simulated).toEqual({
      label: "What's simulated",
      text: "The customers and their messages, the carrier's delivery status, and the shop and its people, who are illustrative.",
    });
  });

  it("pins the storefront line, the signed-out sign-in and the section labels", () => {
    expect(START_COPY.storefront).toEqual({
      before: "Want a real sandbox checkout? Buy something on the ",
      link: "Kikapu storefront",
      after: ".",
    });
    expect(START_COPY.signIn).toEqual({
      title: "Sign in",
      line: "Sign in with the approver key to run the scenarios and reset the demo.",
    });
    expect(START_COPY.scenariosHeading).toBe("Scenarios");
    expect(START_COPY.phoneHeading).toBe("Open on your phone");
  });

  it("pins the reset section and its dialog", () => {
    expect(START_COPY.reset).toEqual({
      heading: "Reset the demo",
      line: "Clears the inbox, decisions and audit log, and replaces any order a scenario refunded. It takes up to a minute.",
      button: "Reset demo",
      dialogTitle: "Reset the demo?",
      dialogDescription:
        "Everyone using this demo starts again from the seed orders. The audit log restarts with one entry that records where the old log ended.",
      cancel: "Cancel",
      confirm: "Reset demo",
      pending: "Resetting",
    });
  });
});

describe("The scenario cards", () => {
  it("are the attack email, the stalled parcel and the damaged basket, in that order", () => {
    expect(SCENARIO_CARDS).toEqual([
      {
        id: "beat-3-attack-email",
        title: "The attack email",
        line: "A customer says KIK-1042 never arrived, and hidden text asks for refunds on four orders other people paid for.",
        lookFor:
          "Baseline: the agent calls PayPal's refund tool directly. Protected: Countersign denies what the records don't support and holds the rest.",
        buttons: [
          { mode: "baseline", label: "Run in baseline mode", variant: "secondary" },
          { mode: "protected", label: "Run protected", variant: "primary" },
        ],
      },
      {
        id: "beat-4-stalled-parcel",
        title: "The stalled parcel",
        line: "The payer of KIK-1035 says her $18.00 coaster set never arrived. The carrier shows it stalled for over ten days.",
        lookFor: "The refund runs on its own, with a real sandbox refund ID.",
        buttons: [{ mode: "protected", label: "Run protected", variant: "primary" }],
      },
      {
        id: "beat-5-damaged",
        title: "The damaged basket",
        line: "The payer of KIK-1037 sends a photo of a split basket and asks for her $240.00 back.",
        lookFor: "It waits for you. Approve it on the Approvals page or your phone.",
        buttons: [{ mode: "protected", label: "Run protected", variant: "primary" }],
      },
    ]);
  });

  it("match Resolve's launcher scenarios by ID and mode", () => {
    expect(SCENARIO_CARDS.map((card) => card.id)).toEqual(LAUNCHER_SCENARIOS.map((s) => s.id));
    for (const scenario of LAUNCHER_SCENARIOS) {
      const card = SCENARIO_CARDS.find((candidate) => candidate.id === scenario.id);
      expect(card?.buttons.map((button) => button.mode).sort()).toEqual([...scenario.modes].sort());
    }
  });

  it("carry no emojis", () => {
    for (const card of SCENARIO_CARDS) {
      for (const text of [card.title, card.line, card.lookFor]) {
        expect(text).not.toMatch(/\p{Extended_Pictographic}/u);
      }
    }
  });
});

describe("The storefront link", () => {
  it("is the URL when STOREFRONT_URL is an http(s) URL", () => {
    expect(storefrontLink({ STOREFRONT_URL: "https://kikapu.example.com" })).toBe(
      "https://kikapu.example.com/",
    );
    expect(storefrontLink({ STOREFRONT_URL: "http://localhost:3000" })).toBe(
      "http://localhost:3000/",
    );
  });

  it("is null when it is unset, blank, not a URL or not http(s)", () => {
    expect(storefrontLink({})).toBeNull();
    expect(storefrontLink({ STOREFRONT_URL: "" })).toBeNull();
    expect(storefrontLink({ STOREFRONT_URL: "   " })).toBeNull();
    expect(storefrontLink({ STOREFRONT_URL: "kikapu" })).toBeNull();
    expect(storefrontLink({ STOREFRONT_URL: "javascript:alert(1)" })).toBeNull();
    expect(storefrontLink({ STOREFRONT_URL: "ftp://example.com" })).toBeNull();
  });
});

describe("The reset sentences", () => {
  it("say a complete reset in one line, with plurals", () => {
    expect(resetSentence(report({}))).toEqual({
      tone: "positive",
      sentence: "Reset in 15s. Replaced 3 orders and kept 27. Recorded 1 dispute again.",
    });
    expect(
      resetSentence(
        report({
          took_ms: 68_000,
          orders: { kept: 29, replaced: NUMBERS(1) },
          disputes: { recorded: 2, already_recorded: 0, problems: 0 },
        }),
      ).sentence,
    ).toBe("Reset in 1m 08s. Replaced 1 order and kept 29. Recorded 2 disputes again.");
  });

  it("says all orders were kept, and leaves out the dispute sentence when none were recorded", () => {
    expect(
      resetSentence(
        report({
          took_ms: 3_000,
          orders: { kept: 30, replaced: [], run_id: null },
          disputes: { recorded: 0, already_recorded: 4, problems: 0 },
        }),
      ),
    ).toEqual({ tone: "positive", sentence: "Reset in 3s. Kept all 30 orders." });
  });

  it("warns when the log was cleared but the disputes weren't all recorded", () => {
    expect(
      resetSentence(
        report({
          complete: false,
          disputes: { recorded: 1, already_recorded: 0, problems: 2 },
        }),
      ),
    ).toEqual({
      tone: "warning",
      sentence:
        "Reset in 15s. Replaced 3 orders and kept 27. 2 disputes couldn't be recorded again.",
    });
    expect(
      resetSentence(
        report({
          complete: false,
          orders: { kept: 30, replaced: [], run_id: null },
          disputes: { recorded: 0, already_recorded: 0, problems: 1 },
        }),
      ).sentence,
    ).toBe("Reset in 15s. Kept all 30 orders. 1 dispute couldn't be recorded again.");
    expect(
      resetSentence(
        report({ complete: false, disputes: { error: "the gate couldn't read its records" } }),
      ),
    ).toEqual({
      tone: "warning",
      sentence:
        "Reset in 15s. Replaced 3 orders and kept 27. The disputes couldn't be read again: the gate couldn't read its records.",
    });
  });

  it("warns that nothing was cleared when a replacement failed", () => {
    const failed = (numbers: string[]) =>
      numbers.map((order_number) => ({ order_number, call: "create", reason: "declined" }));
    expect(
      resetSentence(
        report({
          complete: false,
          cleared: null,
          disputes: null,
          orders: { kept: 25, replaced: NUMBERS(5), failed: failed(["KIK-1035", "KIK-1037"]) },
        }),
      ),
    ).toEqual({
      tone: "warning",
      sentence:
        "The demo wasn't reset. 2 orders couldn't be replaced (KIK-1035, KIK-1037), so nothing was cleared. Reset again to retry.",
    });
    expect(
      resetSentence(
        report({
          complete: false,
          cleared: null,
          disputes: null,
          orders: { failed: failed(["KIK-1035"]) },
        }),
      ).sentence,
    ).toBe(
      "The demo wasn't reset. 1 order couldn't be replaced (KIK-1035), so nothing was cleared. Reset again to retry.",
    );
  });

  it("shows a refusal as the gate's own sentence, as a warning", () => {
    expect(
      resetSentence({
        message: "The demo was reset less than a minute ago. Try again in a minute.",
      }),
    ).toEqual({
      tone: "warning",
      sentence: "The demo was reset less than a minute ago. Try again in a minute.",
    });
  });

  it("never calls a report with no cleared log complete", () => {
    expect(resetSentence(report({ complete: true, cleared: null, disputes: null })).tone).toBe(
      "warning",
    );
  });
});
