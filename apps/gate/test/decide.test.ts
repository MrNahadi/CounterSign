import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type CaptureTarget,
  hashIntent,
  hashMandate,
  REASON_CODES,
  REASONS,
} from "@countersign/mandate";
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

describe("the agent response schema", () => {
  it("holds expires_at to the shared timestamp rule, so an impossible date is rejected", () => {
    const pending = {
      decision: "pending_approval",
      intent_id: "int_0123456789abcdef01234567",
      reasons: [{ code: "ABOVE_AUTO_LIMIT", detail: "$96.00 is over the $80.00 cap" }],
    };
    expect(
      AgentResponseSchema.safeParse({ ...pending, expires_at: "2026-10-17T06:15:00.000Z" }).success,
    ).toBe(true);
    expect(
      AgentResponseSchema.safeParse({ ...pending, expires_at: "2026-02-31T06:15:00Z" }).success,
    ).toBe(false);
    expect(
      AgentResponseSchema.safeParse({ ...pending, expires_at: "2026-10-17T06:15:00" }).success,
    ).toBe(false);
  });
});

describe("the fixture suite", () => {
  const expected = caseFiles.flatMap((name) =>
    load(name).proposals.map((entry) => ({ name, ...entry.expect })),
  );

  it("decides every proposal in every case without throwing", () => {
    for (const name of caseFiles) {
      const decisionCase = load(name);
      decisionCase.proposals.forEach((_entry, index) => {
        expect(() => decideAt(decisionCase, index), `${name} proposal ${index}`).not.toThrow();
      });
    }
  });

  it("holds an allow whose daily total can't be counted with DAILY_LIMIT_UNKNOWN", () => {
    const { record } = decideAt(load("usage-overflow.json"), 0);
    expect(record.decision).toBe("step_up");
    expect(record.reasons).toEqual([
      { code: "DAILY_LIMIT_UNKNOWN", detail: "Today's USD total would be too large to count" },
    ]);
  });

  it("reaches every reason code", () => {
    const reached = new Set(expected.flatMap((each) => each.reasons));
    expect(REASON_CODES.filter((code) => !reached.has(code))).toEqual([]);
    expect(REASON_CODES).toHaveLength(25);
    expect(reached).toContain("NO_DAILY_LIMIT");
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
      target: { kind: "capture", captureId: "CAP-2041", orderId: "ORD-2041" },
      ticketId: "TKT-2041",
      claim: "not_received",
      mandateVersion: 3,
    });
    expect({
      id: record.intentId,
      hash: record.intentHash,
      canonical: record.intentCanonical,
    }).toEqual(hashIntent(intent));
    expect(record.intentCanonical).toBe(
      '{"action":"paypal.refund","amount":1800,"currency":"USD","principal":"support-agent",' +
        '"rail":"paypal","target":{"captureId":"CAP-2041"},"ticketId":"TKT-2041"}',
    );
    expect(record.mandate).toEqual({
      id: "kikapu-studio",
      version: 3,
      hash: hashMandate(decisionCase.mandate).hash,
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
    expect(record).toMatchObject({
      intent: null,
      intentId: null,
      intentHash: null,
      intentCanonical: null,
      trace: [],
    });
    expect(record.matchedRules).toEqual([]);
    expect(response).toMatchObject({ decision: "denied", intent_id: null });
  });

  it("gives the same intent hash whether or not the capture record supplies the order", () => {
    const decisionCase = load("beat-4-stalled-parcel.json");
    const withRecord = decideAt(decisionCase, 0);
    const withoutRecord = decideAt({ ...decisionCase, records: {} }, 0);
    expect((withoutRecord.record.intent?.target as CaptureTarget | undefined)?.orderId).toBeNull();
    expect((withRecord.record.intent?.target as CaptureTarget | undefined)?.orderId).toBe(
      "ORD-2041",
    );
    expect(withoutRecord.record.intentHash).toBe(withRecord.record.intentHash);
    expect(withoutRecord.record.intentCanonical).toBe(withRecord.record.intentCanonical);
  });

  it("runs the verifiers the mandate's rules require beyond the refund set", () => {
    const { record } = decideAt(load("edge-rules.json"), 1);
    expect(record.trace.map((entry) => entry.verifier)).toEqual([
      ...REFUND_VERIFIERS,
      "ledger.velocity",
    ]);
  });

  it("holds a dispute action for approval on the dispute's record, with no verifiers", () => {
    const decisionCase = load("dispute-actions.json");
    expect(decisionCase.records.disputeRecords?.[0]?.call).toBe("GET /v1/customer/disputes/{id}");
    const accepted = decideAt(decisionCase, 0).record;
    expect(accepted.intent).toMatchObject({
      action: "paypal.dispute.accept_claim",
      amount: { minor: 4500, currency: "USD" },
      target: { kind: "dispute", disputeId: "PP-D-4012" },
      ticketId: "TKT-4012",
    });
    expect(accepted.trace).toEqual([]);
    expect(accepted.matchedRules).toEqual(["dispute-and-invoice-actions"]);
    expect(decideAt(decisionCase, 2).record.intent?.amount).toEqual({
      minor: 2000,
      currency: "USD",
    });
  });

  it("denies an unreadable dispute TARGET_UNKNOWN, naming the dispute, with no intent", () => {
    const decisionCase = load("dispute-actions.json");
    const missing = decideAt(decisionCase, 3);
    expect(missing.record.reasons).toEqual([
      { code: "TARGET_UNKNOWN", detail: "No record of dispute PP-D-9999" },
    ]);
    expect(missing.record.intent).toBeNull();
    expect(missing.response).toMatchObject({
      decision: "denied",
      intent_id: null,
      safe_reply_hint: REASONS.TARGET_UNKNOWN.hint,
    });
    expect(decideAt(decisionCase, 4).record.reasons).toEqual([
      {
        code: "TARGET_UNKNOWN",
        detail: "Dispute PP-D-4013 is in EUR, which Countersign doesn't support",
      },
    ]);
  });

  it("holds an invoice send for approval on the invoice's record", () => {
    const decisionCase = load("invoice-order-payout.json");
    expect(decisionCase.records.invoices?.[0]?.call).toBe("GET /v2/invoicing/invoices/{id}");
    const { record, response } = decideAt(decisionCase, 0);
    expect(record.intent).toMatchObject({
      action: "paypal.invoice.send",
      amount: { minor: 5600, currency: "USD" },
      target: { kind: "invoice", invoiceId: "INV2-K7QX-4M2D-9TLB-3HRW" },
    });
    expect(record.matchedRules).toEqual(["dispute-and-invoice-actions"]);
    expect(response.decision).toBe("pending_approval");
  });

  it("denies the demo mandate's order capture and payout NO_MATCHING_RULE, on their intents", () => {
    const decisionCase = load("invoice-order-payout.json");
    const capture = decideAt(decisionCase, 1).record;
    expect(capture.intent).toMatchObject({
      action: "paypal.order.capture",
      amount: { minor: 3200, currency: "USD" },
      target: { kind: "order", orderId: "ORD-5010" },
    });
    expect(capture.matchedRules).toEqual([]);
    const payout = decideAt(decisionCase, 2).record;
    expect(payout.intent).toMatchObject({
      action: "paypal.payout",
      amount: { minor: 2500, currency: "USD" },
      target: { kind: "payee", email: "wanjiru.k@example.com" },
    });
    expect(payout.intentId).not.toBeNull();
  });

  it("denies an allowed action the gate can't carry out ACTION_UNAVAILABLE, keeping the rest", () => {
    const decisionCase = load("action-unavailable.json");
    const { record, response } = decideAt(decisionCase, 0);
    expect(record.decision).toBe("deny");
    expect(record.reasons).toEqual([
      {
        code: "ACTION_UNAVAILABLE",
        detail: "The mandate allows paypal.order.capture, but Countersign can't carry it out yet",
      },
    ]);
    expect(record.intent).toMatchObject({
      action: "paypal.order.capture",
      target: { kind: "order", orderId: "ORD-5010" },
    });
    expect(record.intentId).toMatch(/^int_/);
    expect(record.trace).toEqual([]);
    expect(record.matchedRules).toEqual(["capture-orders"]);
    expect(response).toEqual({
      decision: "denied",
      intent_id: record.intentId,
      reasons: record.reasons,
      safe_reply_hint: REASONS.ACTION_UNAVAILABLE.hint,
    });
  });

  it("leaves a refund allow under the same mandate untouched", () => {
    const { record, response } = decideAt(load("action-unavailable.json"), 1);
    expect(record.decision).toBe("allow");
    expect(record.reasons).toEqual([]);
    expect(record.matchedRules).toEqual(["refund-lost-parcel"]);
    expect(response).toEqual({
      decision: "allowed",
      intent_id: record.intentId,
      intent_hash: record.intentHash,
    });
  });

  it("comes from a module that doesn't load case files", () => {
    const source = readFileSync(new URL("../src/decide.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/from "\.\/case-file"/);
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
      "a dispute record with a malformed currency",
      {
        records: {
          ...valid.records,
          disputeRecords: [
            { id: "PP-D-1", status: "OPEN", amount: { minor: 100, currency: "usd" } },
          ],
        },
      },
    ],
    [
      "a dispute record with a stated call",
      {
        records: {
          ...valid.records,
          disputeRecords: [
            { id: "PP-D-1", call: "x", status: "OPEN", amount: { minor: 100, currency: "USD" } },
          ],
        },
      },
    ],
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
    expect(invalid).toMatchObject({
      ok: false,
      error: expect.stringContaining("Case file (now): "),
    });
  });
});

describe("an ID that isn't well-formed UTF-16", () => {
  // Built with fromCharCode: the Write tool decodes \u escapes in source text.
  const lone = String.fromCharCode(0xd800);
  const decisionCase = load("beat-4-stalled-parcel.json");
  const base = decisionCase.proposals[0]?.proposal as {
    args: Record<string, unknown>;
    justification: Record<string, unknown>;
  };

  it.each([
    ["ticket_id", { ...base, justification: { ...base.justification, ticket_id: `T-${lone}` } }],
    ["capture_id", { ...base, args: { ...base.args, capture_id: `cap_${lone}` } }],
  ])("in %s is denied INVALID_PROPOSAL and never throws", (_field, proposal) => {
    const { mandate, principal, records, now } = decisionCase;
    const decided = () => decide({ mandate, principal, proposal, records, now });
    expect(decided).not.toThrow();
    const { record, response } = decided();
    expect(record.decision).toBe("deny");
    expect(record.reasons.map((reason) => reason.code)).toEqual(["INVALID_PROPOSAL"]);
    expect(response.decision).toBe("denied");
  });
});
