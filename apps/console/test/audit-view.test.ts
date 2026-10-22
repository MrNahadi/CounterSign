import { describe, expect, it } from "vitest";
import { refuse } from "../src/approval-routes";
import { ChainVerdictSchema, EntryPageSchema } from "../src/audit-schemas";
import { auditParamsOf, auditView, verdictView } from "../src/audit-view";

// The Audit log page's view model, fed the gate's answers parsed with the console's own schemas.

const NOW = new Date("2026-10-20T08:04:00.000Z");
const HASH = "a".repeat(64);

const entry = (extra: Record<string, unknown>) => ({
  seq: 5,
  type: "decision",
  ref: `int_${"b".repeat(24)}`,
  at: "2026-10-20T08:01:00.000Z",
  hash: HASH,
  prev_hash: "c".repeat(64),
  summary: "Denied refund $96.00 on KIK-1039.",
  readable: true,
  problem: null,
  ...extra,
});

const page = EntryPageSchema.parse({
  entries: [
    entry({}),
    entry({ seq: 4, type: "approval", summary: "Approved step-up 12." }),
    entry({
      seq: 3,
      type: "execution.result",
      ref: null,
      readable: false,
      summary: "This entry can't be read.",
      problem: "The payload isn't valid JSON.",
    }),
  ],
  total: 9,
  next_before: 3,
});

describe("auditView", () => {
  it("lists entries with a truncated hash, its full value, and links only for decisions", () => {
    const view = auditView(page, null, NOW);
    expect(view.total).toBe("9 entries");
    expect(view.rows.map((row) => row.seq)).toEqual([5, 4, 3]);
    expect(view.rows[0]).toMatchObject({
      type: "decision",
      summary: "Denied refund $96.00 on KIK-1039.",
      href: "/decisions/5",
      hash: { short: `${"a".repeat(12)}…`, full: HASH },
    });
    expect(view.rows[1]?.href).toBeNull();
    expect(view.empty).toBeNull();
  });

  it("shows an unreadable entry's problem rather than skipping it", () => {
    const row = auditView(page, null, NOW).rows[2];
    expect(row?.summary).toBe("The payload isn't valid JSON.");
  });

  it("pages back with the cursor, keeping the check when it was asked for", () => {
    expect(auditView(page, null, NOW).olderHref).toBe("/audit?before=3");
    const checked = auditView(page, refuse(503, "x"), NOW);
    expect(checked.olderHref).toBe("/audit?before=3&check=1");
    const last = EntryPageSchema.parse({ ...page, next_before: null });
    expect(auditView(last, null, NOW).olderHref).toBeNull();
  });

  it("says there are no entries when the page is empty", () => {
    const none = EntryPageSchema.parse({ entries: [], total: 0, next_before: null });
    expect(auditView(none, null, NOW).empty).toMatch(/^No entries yet/);
  });

  it("shows no verdict until the check is asked for", () => {
    const view = auditView(page, null, NOW);
    expect(view.verdict).toBeNull();
    expect(view.checkHref).toBe("/audit?check=1");
  });
});

describe("verdictView", () => {
  it("reports an intact chain with its entry count and head", () => {
    const verdict = ChainVerdictSchema.parse({
      intact: true,
      entry_count: 9,
      head: { seq: 9, hash: HASH },
      problems: [],
    });
    expect(verdictView({ ok: true, value: verdict })).toEqual({
      tone: "positive",
      heading: `Chain intact: 9 entries. Head #9 ${HASH}.`,
      problems: [],
    });
  });

  it("says 1 entry in the singular and drops the head of an empty log", () => {
    const one = ChainVerdictSchema.parse({
      intact: true,
      entry_count: 1,
      head: { seq: 1, hash: HASH },
      problems: [],
    });
    expect(verdictView({ ok: true, value: one }).heading).toMatch(/^Chain intact: 1 entry\./);
    const empty = ChainVerdictSchema.parse({
      intact: true,
      entry_count: 0,
      head: null,
      problems: [],
    });
    expect(verdictView({ ok: true, value: empty }).heading).toBe("Chain intact: 0 entries.");
  });

  it("lists every problem when the chain is broken", () => {
    const verdict = ChainVerdictSchema.parse({
      intact: false,
      entry_count: 9,
      head: { seq: 9, hash: HASH },
      problems: [
        { seq: 4, code: "HASH_MISMATCH", detail: "Entry 4's hash doesn't match its fields." },
        { seq: 7, code: "SEQ_ORDER", detail: "Entry 7 is out of order." },
      ],
    });
    const view = verdictView({ ok: true, value: verdict });
    expect(view.tone).toBe("danger");
    expect(view.heading).toBe("Chain broken: 2 problems.");
    expect(view.problems.map((p) => p.seq)).toEqual([4, 7]);
  });

  it("never says intact when the gate gave no verdict", () => {
    const view = verdictView(refuse(502, "The gate isn't reachable. Start it, then try again."));
    expect(view.tone).toBe("neutral");
    expect(view.heading).not.toMatch(/intact/);
  });
});

describe("auditParamsOf", () => {
  it("reads before and check only when given once as text", () => {
    expect(auditParamsOf({ before: "12", check: "1" })).toEqual({ before: "12", check: true });
    expect(auditParamsOf({ before: ["1", "2"], check: "yes" })).toEqual({ check: false });
    expect(auditParamsOf({})).toEqual({ check: false });
  });
});
