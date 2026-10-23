import { describe, expect, it } from "vitest";
import { DISPUTES_COPY, disputesView, draftAgain } from "../src/disputes-view";
import { type DisputeDraft, DisputeListSchema } from "../src/resolve-schemas";

// The Disputes page's view model, from Resolve's `GET /disputes` answer as the console parses it.

const NOW = new Date("2026-10-23T12:00:00.000Z");
const INTENT = `int_${"c".repeat(24)}`;

const draft = (overrides: Partial<DisputeDraft>): DisputeDraft => ({
  draft_id: `drf_${"a".repeat(32)}`,
  dispute_id: "PP-D-1",
  status: "queued",
  outcome: null,
  drafted_by: null,
  model: "gemini-3.5-flash-lite",
  model_versions: [],
  agent_response_status: null,
  intent_id: null,
  dispute: null,
  queued_at: "2026-10-23T11:55:00.000Z",
  started_at: null,
  finished_at: null,
  ...overrides,
});

const view = (drafts: DisputeDraft[]) => disputesView(DisputeListSchema.parse({ drafts }), NOW);

const DISPUTE = {
  reason_words: "Item not received",
  amount: { minor: 24000, currency: "USD", display: "$240.00" },
};

describe("disputesView", () => {
  it("says there are no disputes yet when Resolve has no drafts", () => {
    expect(view([])).toEqual({ empty: DISPUTES_COPY.empty, rows: [] });
    expect(DISPUTES_COPY.empty).toBe(
      "No disputes yet. They appear here when PayPal opens one, or after npm run disputes -- sync.",
    );
  });

  it("shows a proposed draft as waiting for you, drafted by Gemini, with its decision", () => {
    const [row] = view([
      draft({
        status: "proposed",
        outcome: "pending_approval",
        drafted_by: "gemini-3.5-flash-lite",
        model_versions: ["gemini-3.5-flash-lite-001"],
        agent_response_status: "pending_approval",
        intent_id: INTENT,
        dispute: DISPUTE,
      }),
    ]).rows;
    expect(row).toEqual({
      id: `drf_${"a".repeat(32)}`,
      disputeId: "PP-D-1",
      reason: "Item not received",
      when: "5m ago",
      at: "2026-10-23T11:55:00.000Z",
      amount: "$240.00",
      draft: { words: "Waiting for you", href: "/approvals" },
      canDraftAgain: false,
      draftedBy: "Gemini gemini-3.5-flash-lite",
      decision: { href: `/decisions/intent/${INTENT}`, label: DISPUTES_COPY.openDecision },
    });
  });

  it("names the template as no AI", () => {
    const [row] = view([
      draft({
        status: "proposed",
        drafted_by: "template",
        agent_response_status: "pending_approval",
        intent_id: INTENT,
      }),
    ]).rows;
    expect(row?.draftedBy).toBe("Template, no AI");
  });

  it("words each draft status", () => {
    const words = (overrides: Partial<DisputeDraft>) => view([draft(overrides)]).rows[0]?.draft;
    expect(words({ status: "queued" })).toEqual({ words: "Drafting", href: null });
    expect(words({ status: "running" })).toEqual({ words: "Drafting", href: null });
    expect(words({ status: "not_run", outcome: "daily_cap" })).toEqual({
      words: "Not run: daily limit",
      href: null,
    });
    expect(words({ status: "failed", outcome: "gate_unavailable" })).toEqual({
      words: "Couldn't draft: the gate wasn't reachable.",
      href: null,
    });
    expect(words({ status: "failed", outcome: "proposal_rejected" })?.words).toBe(
      "Couldn't draft: the gate refused the proposal.",
    );
    expect(words({ status: "failed", outcome: "interrupted" })?.words).toBe(
      "Couldn't draft: Resolve stopped before it finished.",
    );
    expect(
      words({ status: "failed", outcome: "prepare_failed:The dispute can't be read." })?.words,
    ).toBe("Couldn't draft: The dispute can't be read.");
    expect(words({ status: "failed", outcome: "prepare_failed:no PDF" })?.words).toBe(
      "Couldn't draft: the evidence couldn't be prepared.",
    );
    expect(words({ status: "failed", outcome: "model_odd" })?.words).toBe(
      "Couldn't draft: model_odd",
    );
    expect(words({ status: "failed", outcome: null })?.words).toBe("Couldn't draft");
  });

  it("only says waiting for you when the gate is holding the proposal for approval", () => {
    const [row] = view([
      draft({ status: "proposed", agent_response_status: "allowed", intent_id: INTENT }),
    ]).rows;
    expect(row?.draft).toEqual({ words: "Proposed", href: null });
  });

  it("offers draft again on a failed draft only, and leaves unknown facts empty", () => {
    const rows = view([
      draft({ dispute_id: "PP-D-2", status: "failed", outcome: "gate_unavailable" }),
      draft({ dispute_id: "PP-D-1", status: "running" }),
    ]).rows;
    expect(rows.map((row) => [row.disputeId, row.canDraftAgain])).toEqual([
      ["PP-D-2", true],
      ["PP-D-1", false],
    ]);
    expect(rows[0]).toMatchObject({ reason: null, amount: null, draftedBy: null, decision: null });
  });
});

describe("draftAgain", () => {
  type Seen = { url: string; init: RequestInit };
  const fake = (status: number, body: unknown) => {
    const seen: Seen[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      seen.push({ url, init });
      return Response.json(body, { status });
    }) as unknown as typeof fetch;
    return { seen, fetchImpl };
  };

  it("posts the dispute ID to the console's route", async () => {
    const { seen, fetchImpl } = fake(202, draft({}));
    expect(await draftAgain("PP-D-1", fetchImpl)).toEqual({ ok: true, value: null });
    expect(seen[0]?.url).toBe("/api/disputes");
    expect(seen[0]?.init.method).toBe("POST");
    expect(JSON.parse(String(seen[0]?.init.body))).toEqual({ dispute_id: "PP-D-1" });
  });

  it("answers the route's sentence when it refuses", async () => {
    const { fetchImpl } = fake(401, { message: "Sign in again." });
    expect(await draftAgain("PP-D-1", fetchImpl)).toEqual({
      ok: false,
      status: 401,
      message: "Sign in again.",
    });
  });

  it("says Resolve isn't reachable when the route can't be called", async () => {
    const down = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    expect(await draftAgain("PP-D-1", down)).toEqual({
      ok: false,
      status: 502,
      message: "Resolve isn't reachable. Start it, then try again.",
    });
  });
});
