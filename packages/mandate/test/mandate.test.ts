import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { hashMandate, parseMandate, requiredVerifiers, ruleActions } from "../src/index";

const fixture = JSON.parse(
  readFileSync(new URL("../fixtures/kikapu-studio-v3.json", import.meta.url), "utf8"),
);

function reverseKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reverseKeys);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .reverse()
      .map(([key, inner]) => [key, reverseKeys(inner)]),
  );
}

function mustParse(input: unknown) {
  const result = parseMandate(input);
  if (!result.ok) throw new Error(result.error);
  return result.mandate;
}

describe("the fixture mandate", () => {
  it("parses as kikapu-studio v3 for support-agent", () => {
    const mandate = mustParse(fixture);
    expect(mandate.id).toBe("kikapu-studio");
    expect(mandate.version).toBe(3);
    expect(mandate.principal).toBe("support-agent");
    expect(mandate.fallback).toBe("deny");
    expect(mandate.time_zone).toBe("Africa/Nairobi");
    expect(mandate.limits).toEqual([
      { currency: "USD", per_day_total: 30000, per_day_count: 5 },
      { currency: "KES", per_day_total: 1500000 },
    ]);
    expect(mandate.rules.map((rule) => rule.id)).toEqual([
      "refund-lost-parcel",
      "refund-delivered-claim",
      "refund-damaged",
      "refund-wrong-item",
      "dispute-and-invoice-actions",
    ]);
  });

  it("holds the caps in minor units", () => {
    const caps = mustParse(fixture).rules.map((rule) => rule.max ?? null);
    expect(caps).toEqual([
      { amount: 8000, currency: "USD" },
      null,
      { amount: 5000, currency: "USD" },
      null,
      null,
    ]);
  });

  it("has a hash that ignores key order", () => {
    const { hash, canonical } = hashMandate(mustParse(fixture));
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hashMandate(mustParse(reverseKeys(fixture)))).toEqual({ hash, canonical });
  });

  it("returns the canonical JSON it hashed", () => {
    const mandate = mustParse(fixture);
    const { hash, canonical } = hashMandate(mandate);
    expect(createHash("sha256").update(canonical, "utf8").digest("hex")).toBe(hash);
    expect(JSON.parse(canonical)).toEqual(mandate);
  });

  it("defaults the time zone to Africa/Nairobi", () => {
    const { time_zone: _, ...withoutZone } = fixture;
    expect(mustParse(withoutZone).time_zone).toBe("Africa/Nairobi");
  });

  it("has a hash that changes with the rules", () => {
    const loosened = structuredClone(fixture);
    loosened.rules[0].max.amount = 8001;
    expect(hashMandate(mustParse(loosened)).hash).not.toBe(hashMandate(mustParse(fixture)).hash);
  });
});

describe("a mandate's rules", () => {
  it("list one action or several the same way", () => {
    const [lostParcel, , , , disputes] = mustParse(fixture).rules;
    if (!lostParcel || !disputes) throw new Error("The fixture lost a rule");
    expect(ruleActions(lostParcel)).toEqual(["paypal.refund"]);
    expect(ruleActions(disputes)).toEqual([
      "paypal.dispute.accept_claim",
      "paypal.dispute.provide_evidence",
      "paypal.dispute.make_offer",
      "paypal.invoice.send",
    ]);
  });

  it("name the verifiers they require for an action, once each, in rule order", () => {
    const mandate = mustParse(fixture);
    expect(requiredVerifiers(mandate, "paypal.refund")).toEqual([
      "ticket.from_payer",
      "capture.refundable",
      "dispute.none_open",
      "ledger.not_duplicate",
      "evidence.photo_present",
    ]);
    expect(requiredVerifiers(mandate, "paypal.invoice.send")).toEqual([]);
    expect(requiredVerifiers(mandate, "mpesa.b2c")).toEqual([]);
  });

  it("require verifiers from a rule that lists several actions", () => {
    const mandate = structuredClone(fixture);
    mandate.rules[4].require = ["payee.allowlisted"];
    expect(requiredVerifiers(mustParse(mandate), "paypal.invoice.send")).toEqual([
      "payee.allowlisted",
    ]);
  });
});

type Fixture = typeof fixture;

describe("parseMandate rejects", () => {
  it.each<[string, (mandate: Fixture) => void, (string | number)[]]>([
    [
      "a fallback other than deny",
      (m) => {
        m.fallback = "allow";
      },
      ["fallback"],
    ],
    [
      "an unknown action",
      (m) => {
        m.rules[0].action = "paypal.refund_everything";
      },
      ["rules", 0, "action"],
    ],
    [
      "an unknown action in a list",
      (m) => {
        m.rules[4].action[1] = "paypal.wire";
      },
      ["rules", 4, "action"],
    ],
    [
      "an unknown verifier name",
      (m) => {
        m.rules[0].require[2] = "message.sounds_sincere";
      },
      ["rules", 0, "require", 2],
    ],
    [
      "an unknown when key",
      (m) => {
        m.rules[2].when.purpose = "goodwill";
      },
      ["rules", 2, "when", "purpose"],
    ],
    [
      "an unknown rule key",
      (m) => {
        m.rules[0].above_max = "allow";
      },
      ["rules", 0, "above_max"],
    ],
    [
      "an unknown shipment status",
      (m) => {
        m.rules[0].when["shipment.status"][0] = "probably_lost";
      },
      ["rules", 0, "when", "shipment.status", 0],
    ],
    [
      "a non-integer cap",
      (m) => {
        m.rules[0].max.amount = 80.5;
      },
      ["rules", 0, "max", "amount"],
    ],
    [
      "a negative cap",
      (m) => {
        m.rules[2].max.amount = -1;
      },
      ["rules", 2, "max", "amount"],
    ],
    [
      "a non-integer daily total",
      (m) => {
        m.limits[0].per_day_total = 300.25;
      },
      ["limits", 0, "per_day_total"],
    ],
    [
      "a negative daily count",
      (m) => {
        m.limits[0].per_day_count = -5;
      },
      ["limits", 0, "per_day_count"],
    ],
    [
      "a cap in another currency",
      (m) => {
        m.rules[0].max.currency = "EUR";
      },
      ["rules", 0, "max", "currency"],
    ],
    [
      "a limit in another currency",
      (m) => {
        m.limits[1].currency = "TZS";
      },
      ["limits", 1, "currency"],
    ],
    [
      "a step-up rule without a reason",
      (m) => {
        delete m.rules[1].reason;
      },
      ["rules", 1, "reason"],
    ],
    [
      "a deny rule without a reason",
      (m) => {
        m.rules[0].decide = "deny";
      },
      ["rules", 0, "reason"],
    ],
    [
      "a rule reason that isn't a rule reason code",
      (m) => {
        m.rules[3].reason = "ABOVE_AUTO_LIMIT";
      },
      ["rules", 3, "reason"],
    ],
    [
      "a deny rule whose reason has no reply hint for the customer",
      (m) => {
        m.rules[3].decide = "deny";
      },
      ["rules", 3, "reason"],
    ],
    [
      "an unknown time zone",
      (m) => {
        m.time_zone = "Africa/Atlantis";
      },
      ["time_zone"],
    ],
    [
      "a second limit for one currency",
      (m) => {
        m.limits.push({ currency: "USD", per_day_count: 50 });
      },
      ["limits", 2, "currency"],
    ],
    [
      "a second rule with one id",
      (m) => {
        m.rules[3].id = "refund-damaged";
      },
      ["rules", 3, "id"],
    ],
  ])("%s, with its path", (_name, change, path) => {
    const mandate = structuredClone(fixture);
    change(mandate);
    const result = parseMandate(mandate);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.map((issue) => issue.path)).toContainEqual(path);
  });

  it("nothing when a deny rule names a reason with a reply hint", () => {
    const mandate = structuredClone(fixture);
    mandate.rules[3].decide = "deny";
    mandate.rules[3].reason = "RULE_DENIES";
    expect(parseMandate(mandate).ok).toBe(true);
  });

  it("with a one-line error naming the field", () => {
    const mandate = structuredClone(fixture);
    mandate.rules[0].max.amount = 80.5;
    const result = parseMandate(mandate);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/^Mandate \.rules\[0\]\.max\.amount: /);
    expect(result.error).not.toContain("\n");
  });
});
