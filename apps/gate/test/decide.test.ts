import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { hashIntent, hashMandate, REASON_CODES, REASONS } from "@countersign/mandate";
import { REFUND_VERIFIERS } from "@countersign/verifiers";
import { describe, expect, it } from "vitest";
import { CaseFileSchema, type DecisionCase, loadCase } from "../src/case-file";
import { AgentResponseSchema, decide } from "../src/decide";

const casesDir = fileURLToPath(new URL("../fixtures/cases/", import.meta.url));
const caseFiles = readdirSync(casesDir)
  .filter((name) => name.endsWith(".json"))
  .sort();

function load(name: string): DecisionCase {
  const loaded = loadCase(`${casesDir}${name}`);
  if (!loaded.ok) throw new Error(loaded.error);
  return loaded.decisionCase;
}

function decideAt(decisionCase: DecisionCase, index: number) {
  const { mandate, principal, records, now } = decisionCase;
  const entry = decisionCase.proposals[index];
  if (!entry) throw new Error(`No proposal ${index}`);
  return { entry, ...decide({ mandate, principal, proposal: entry.proposal, records, now }) };
}

const AGENT_DECISIONS = { allow: "allowed", step_up: "pending_approval", deny: "denied" } as const;

describe.each(caseFiles)("case %s", (name) => {
  const decisionCase = load(name);

  it.each(decisionCase.proposals.map((_entry, index) => index))(
    "proposal %i gets its expected decision and reasons",
    (index) => {
      const { entry, record, response } = decideAt(decisionCase, index);
      expect(record.decision).toBe(entry.expect.decision);
      expect(record.reasons.map((reason) => reason.code)).toEqual(entry.expect.reasons);

      const parsed = AgentResponseSchema.parse(response);
      expect(parsed.decision).toBe(AGENT_DECISIONS[record.decision]);
      expect(parsed.intent_id).toBe(record.intentId);
      if (parsed.decision === "allowed") expect(parsed.intent_hash).toBe(record.intentHash);
      if (parsed.decision === "pending_approval") {
        expect(new Date(parsed.expires_at).getTime()).toBe(
          decisionCase.now.getTime() + 15 * 60_000,
        );
      }
      if (parsed.decision !== "allowed") expect(parsed.reasons).toEqual(record.reasons);
      if (parsed.decision === "denied") {
        const [first] = record.reasons;
        expect(first && parsed.safe_reply_hint).toBe(first && REASONS[first.code].hint);
      }
      for (const reason of record.reasons) expect(reason.detail.length).toBeGreaterThan(0);
    },
  );
});

describe("the fixture suite", () => {
  const expected = caseFiles.flatMap((name) =>
    load(name).proposals.map((entry) => ({ name, ...entry.expect })),
  );

  it("reaches every reason code", () => {
    const reached = new Set(expected.flatMap((each) => each.reasons));
    expect(REASON_CODES.filter((code) => !reached.has(code))).toEqual([]);
  });

  it("covers beats 3, 4 and 5", () => {
    const beat = (name: string) => expected.filter((each) => each.name === name);
    expect(beat("beat-3-attack-email.json")).toEqual([
      ...Array.from({ length: 4 }, () => ({
        name: "beat-3-attack-email.json",
        decision: "deny",
        reasons: ["TICKET_NOT_FROM_PAYER"],
      })),
      { name: "beat-3-attack-email.json", decision: "step_up", reasons: ["SHIPMENT_DELIVERED"] },
    ]);
    expect(beat("beat-4-stalled-parcel.json")).toEqual([
      { name: "beat-4-stalled-parcel.json", decision: "allow", reasons: [] },
    ]);
    expect(beat("beat-5-damaged-with-photo.json")).toEqual([
      {
        name: "beat-5-damaged-with-photo.json",
        decision: "step_up",
        reasons: ["ABOVE_AUTO_LIMIT"],
      },
    ]);
  });
});

describe("the decision record", () => {
  it("holds the intent, mandate, trace, usage, matched rules, reasons and time", () => {
    const decisionCase = load("beat-4-stalled-parcel.json");
    const { record } = decideAt(decisionCase, 0);
    const { intent } = record;
    if (!intent) throw new Error("No intent");
    expect(intent).toMatchObject({
      principal: "support-agent",
      action: "paypal.refund",
      amount: { minor: 1800, currency: "USD" },
      target: { captureId: "CAP-2041", orderId: "ORD-2041" },
      ticketId: "TKT-2041",
      claim: "not_received",
      mandateVersion: 3,
    });
    expect({ id: record.intentId, hash: record.intentHash }).toEqual(hashIntent(intent));
    expect(record.mandate).toEqual({
      id: "kikapu-studio",
      version: 3,
      hash: hashMandate(decisionCase.mandate),
    });
    expect(record.trace.map((entry) => entry.verifier)).toEqual([...REFUND_VERIFIERS]);
    // No photo on a parcel claim: the trace is complete, whatever the matched rule needs.
    expect(record.trace.map((entry) => entry.result)).toEqual([
      "pass",
      "pass",
      "pass",
      "pass",
      "fail",
      "pass",
    ]);
    expect(record.trace[3]).toMatchObject({ value: "stalled_10d" });
    expect(record.usage).toEqual({
      known: true,
      date: "2026-10-17",
      perCurrency: {
        USD: { count: 1, total: { minor: 4000, currency: "USD" } },
        KES: { count: 0, total: { minor: 0, currency: "KES" } },
      },
    });
    expect(record.matchedRules).toEqual(["refund-lost-parcel"]);
    expect(record.decision).toBe("allow");
    expect(record.reasons).toEqual([]);
    expect(record.decidedAt).toBe("2026-10-17T06:00:00.000Z");
  });

  it("denies a proposal that never became an intent, with no trace", () => {
    const { record, response } = decideAt(load("out-of-scope.json"), 1);
    expect(record).toMatchObject({ intent: null, intentId: null, intentHash: null, trace: [] });
    expect(record.matchedRules).toEqual([]);
    expect(response).toMatchObject({ decision: "denied", intent_id: null });
  });

  it("runs the verifiers the mandate's rules require beyond the refund set", () => {
    const { record } = decideAt(load("edge-rules.json"), 1);
    expect(record.trace.map((entry) => entry.verifier)).toEqual([
      ...REFUND_VERIFIERS,
      "ledger.velocity",
    ]);
  });
});

describe("case files", () => {
  const valid = JSON.parse(readFileSync(`${casesDir}beat-4-stalled-parcel.json`, "utf8"));
  const executions = valid.records.executions;

  it("accept every fixture", () => {
    for (const name of caseFiles) {
      expect(
        CaseFileSchema.safeParse(JSON.parse(readFileSync(`${casesDir}${name}`, "utf8"))).success,
      ).toBe(true);
    }
  });

  it.each([
    [
      "a float amount",
      {
        records: {
          ...valid.records,
          executions: [{ ...executions[0], amount: { minor: 40.5, currency: "USD" } }],
        },
      },
    ],
    [
      "a time without an offset",
      {
        records: {
          ...valid.records,
          executions: [{ ...executions[0], executedAt: "2026-10-17T05:10:00" }],
        },
      },
    ],
    [
      "an unknown currency",
      {
        records: {
          ...valid.records,
          executions: [{ ...executions[0], amount: { minor: 4000, currency: "EUR" } }],
        },
      },
    ],
    ["an unknown record key", { records: { ...valid.records, payments: [] } }],
    [
      "a stated call",
      { records: { ...valid.records, ticket: { ...valid.records.ticket, call: "ticket" } } },
    ],
    [
      "an unknown shipment status",
      { records: { ...valid.records, shipments: [{ id: "TRK2041", status: "misplaced" }] } },
    ],
    [
      "an unknown reason code",
      {
        proposals: [
          { ...valid.proposals[0], expect: { decision: "deny", reasons: ["NOT_A_CODE"] } },
        ],
      },
    ],
    [
      "an unknown decision",
      { proposals: [{ ...valid.proposals[0], expect: { decision: "allowed", reasons: [] } }] },
    ],
    [
      "a proposal without an expected outcome",
      { proposals: [{ proposal: valid.proposals[0].proposal }] },
    ],
    ["no proposals", { proposals: [] }],
    ["a now without an offset", { now: "2026-10-17T09:00:00" }],
  ])("reject %s", (_label, change) => {
    expect(CaseFileSchema.safeParse({ ...valid, ...change }).success).toBe(false);
  });

  it("report an unreadable, invalid or mandate-less file instead of throwing", () => {
    const dir = mkdtempSync(join(tmpdir(), "countersign-case-"));
    const write = (name: string, text: string) => {
      writeFileSync(join(dir, name), text);
      return loadCase(join(dir, name));
    };
    expect(loadCase(join(dir, "no-such-case.json"))).toMatchObject({ ok: false });
    expect(write("broken.json", "{ not json")).toMatchObject({ ok: false });
    const noMandate = write(
      "no-mandate.json",
      JSON.stringify({ ...valid, mandate: "missing.json" }),
    );
    expect(noMandate).toMatchObject({ ok: false });
    writeFileSync(join(dir, "bad-mandate.json"), JSON.stringify({ id: "bad", fallback: "allow" }));
    const badMandate = write("bad.json", JSON.stringify({ ...valid, mandate: "bad-mandate.json" }));
    expect(badMandate).toMatchObject({ ok: false });
    const invalid = write("invalid.json", JSON.stringify({ ...valid, now: "today" }));
    expect(invalid).toMatchObject({ ok: false, error: expect.stringContaining("Case file.now") });
  });
});
