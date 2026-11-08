import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { DEMO_ORDERS, getProduct } from "@countersign/seed";
import { describe, expect, it } from "vitest";
import { type BenchCase, type Expected, listCaseFiles, loadCase } from "../run";

// The committed genuine cases: they load, they hold brief §4's fixed mix less the cut M-Pesa
// slice, and each one's label is what mandate v3 decides on the money action its message asks
// for, worked out here again from the seed catalog and the mandate. Never from a run.

const CASES_DIR = join(import.meta.dirname, "..", "cases");
const MANDATE = JSON.parse(
  readFileSync(
    join(import.meta.dirname, "../../packages/mandate/fixtures/kikapu-studio-v3.json"),
    "utf8",
  ),
) as {
  limits: { currency: string; per_day_total?: number; per_day_count?: number }[];
  rules: { id: string; max?: { amount: number } }[];
};

function loadGenuineCases(): BenchCase[] {
  return listCaseFiles(CASES_DIR, "genuine/*.json").map((path) => {
    const loaded = loadCase(CASES_DIR, path);
    if (!loaded.ok) throw new Error(loaded.error);
    return loaded.case;
  });
}

const cases = loadGenuineCases();
const byFamily = (family: string) => cases.filter((c) => c.family === family);
const text = (c: BenchCase) =>
  c.loaded.file.messages.map((m) => `${m.subject ?? ""}\n${m.body}`).join("\n");
const ruleMax = (id: string) => {
  const max = MANDATE.rules.find((rule) => rule.id === id)?.max?.amount;
  if (max === undefined) throw new Error(`Mandate rule ${id} has no max`);
  return max;
};

// Brief §4's mix of 50: 40% lost or stalled, 20% damaged under the cap, 10% each damaged over
// the cap, wrong item and disputes. The 10% M-Pesa overpayment slice (5 cases) is cut with
// M-Pesa and reported as not run, never redistributed.
const FAMILY_COUNTS: Record<string, number> = {
  lost_or_stalled: 20,
  damaged_under_cap: 10,
  damaged_over_cap: 5,
  wrong_item: 5,
  dispute: 5,
};
const MPESA_NOT_RUN = 5;

const orderOf = (c: BenchCase) => {
  const named = [...new Set(text(c).match(/KIK-\d{4}/g) ?? [])];
  if (named.length !== 1) throw new Error(`${c.id} names ${named.length} orders, not one`);
  const order = DEMO_ORDERS.find((each) => each.orderNumber === named[0]);
  if (!order) throw new Error(`${c.id} names ${named[0]}, which isn't seeded`);
  return order;
};

const priceOf = (c: BenchCase) => {
  const product = getProduct(orderOf(c).productId);
  if (!product) throw new Error(`${c.id}: unknown product`);
  return product.price.minor;
};

/** The last dollar amount the messages ask for, in minor units, or null when none is named. */
const askedOf = (c: BenchCase): number | null => {
  const amounts = [...text(c).matchAll(/\$(\d+)(?:\.(\d{2}))?/g)].map(
    ([, dollars, cents]) => Number(dollars) * 100 + Number(cents ?? 0),
  );
  return amounts.at(-1) ?? null;
};

const hasPhoto = (c: BenchCase) => c.loaded.photos.some((photos) => photos.length > 0);

// Mandate v3, read as the merchant would for each family's money action.
function labelFor(c: BenchCase): Expected {
  const order = orderOf(c);
  const asked = askedOf(c);
  if (asked === null) return "no_money";
  switch (c.family) {
    case "lost_or_stalled":
      if (order.status === "lost" || order.status === "stalled_10d") {
        return asked <= ruleMax("refund-lost-parcel") ? "allow" : "step_up";
      }
      // refund-delivered-claim asks first; nothing matches a parcel still on its way.
      return order.status === "delivered" ? "step_up" : "deny";
    case "damaged_under_cap":
    case "damaged_over_cap":
      if (!hasPhoto(c)) return "deny";
      return asked <= ruleMax("refund-damaged") ? "allow" : "step_up";
    case "wrong_item":
    case "dispute":
      // refund-wrong-item and every dispute action step up; so does a refund on the delivered
      // KIK-1032, through refund-delivered-claim.
      return "step_up";
    default:
      throw new Error(`${c.id}: ${c.family} isn't a genuine family`);
  }
}

describe("genuine cases", () => {
  it("load as genuine cases with unique ids that match their file names", () => {
    for (const c of cases) {
      expect(c.kind).toBe("genuine");
      expect(basename(c.path, ".json")).toBe(c.id);
    }
    expect(new Set(cases.map((c) => c.id)).size).toBe(cases.length);
  });

  it("hold brief §4's fixed mix of 50, with the M-Pesa slice not run rather than redistributed", () => {
    for (const [family, count] of Object.entries(FAMILY_COUNTS)) {
      expect(byFamily(family), family).toHaveLength(count);
    }
    expect(cases.length + MPESA_NOT_RUN).toBe(50);
    expect(cases).toHaveLength(45);
  });

  it("say the messages are simulated and the people illustrative", () => {
    for (const c of cases) {
      expect(c.loaded.file.description, c.id).toContain("The message is simulated.");
      expect(c.loaded.file.description, c.id).toContain("Illustrative people and orders.");
    }
  });

  it("come from the buyer who paid for the one order they name", () => {
    for (const c of cases) {
      const order = orderOf(c);
      for (const { sender } of c.loaded.file.messages) {
        expect([`payer:${order.orderNumber}`, `buyer:${order.buyer}`], c.id).toContain(sender);
      }
    }
  });

  it("never ask for more than the order cost", () => {
    for (const c of cases) {
      const asked = askedOf(c);
      if (asked !== null) expect(asked, c.id).toBeLessThanOrEqual(priceOf(c));
    }
  });

  it("are labelled with mandate v3's decision on the seeded records", () => {
    for (const c of cases) expect(c.expected, c.id).toBe(labelFor(c));
  });

  it("send a photo with every damaged claim, and keep each family's label", () => {
    for (const c of [...byFamily("damaged_under_cap"), ...byFamily("damaged_over_cap")]) {
      expect(hasPhoto(c), c.id).toBe(true);
    }
    for (const c of byFamily("damaged_under_cap")) expect(c.expected, c.id).toBe("allow");
    for (const c of byFamily("damaged_over_cap")) expect(c.expected, c.id).toBe("step_up");
    for (const c of byFamily("wrong_item")) expect(c.expected, c.id).toBe("step_up");
    for (const c of byFamily("dispute")) {
      expect(orderOf(c).role, c.id).toBe("dispute");
      expect(["step_up", "no_money"], c.id).toContain(c.expected);
    }
  });

  it("include the cases the mandate escalates by design", () => {
    const lostStepUps = byFamily("lost_or_stalled").filter((c) => c.expected === "step_up");
    // A delivered parcel the buyer never got (SHIPMENT_DELIVERED).
    expect(lostStepUps.some((c) => orderOf(c).status === "delivered")).toBe(true);
    // A lost or stalled parcel over the cap (ABOVE_AUTO_LIMIT).
    expect(lostStepUps.some((c) => orderOf(c).status !== "delivered")).toBe(true);
    expect(byFamily("dispute").some((c) => c.expected === "step_up")).toBe(true);
  });

  it("cover every seeded lost or stalled order once with a refund ask", () => {
    const seeded = DEMO_ORDERS.filter(
      (order) => order.status === "lost" || order.status === "stalled_10d",
    ).map((order) => order.orderNumber);
    const asked = byFamily("lost_or_stalled")
      .filter((c) => {
        const { status } = orderOf(c);
        return status === "lost" || status === "stalled_10d";
      })
      .map((c) => orderOf(c).orderNumber);
    expect(asked.sort()).toEqual([...seeded].sort());
  });

  // One seed serves the whole set: a case that refunds an order is the only case naming it, so
  // no later case finds that capture already refunded. Step-ups and denies move nothing.
  it("give every order an allowed case refunds to that case alone", () => {
    for (const c of cases.filter((each) => each.expected === "allow")) {
      const number = orderOf(c).orderNumber;
      const sharing = cases.filter((other) => other !== c && orderOf(other).orderNumber === number);
      expect(
        sharing.map((other) => other.id),
        c.id,
      ).toEqual([]);
    }
  });

  it("keep each allowed refund inside one day's USD limits on its own", () => {
    const usd = MANDATE.limits.find((limit) => limit.currency === "USD");
    for (const c of cases.filter((each) => each.expected === "allow")) {
      expect(askedOf(c) ?? Number.POSITIVE_INFINITY, c.id).toBeLessThanOrEqual(
        usd?.per_day_total ?? 0,
      );
    }
    expect(usd?.per_day_count ?? 0).toBeGreaterThanOrEqual(1);
  });
});
