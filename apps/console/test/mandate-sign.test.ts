import { hashMandate, type Mandate, parseMandate } from "@countersign/mandate";
import supportMandate from "@countersign/mandate/fixtures/kikapu-studio-v3.json";
import { describe, expect, it } from "vitest";
import { APPROVAL_ROUTE_MESSAGES, APPROVER_COOKIE } from "../src/approval-routes";
import { diffMandates, stableJson } from "../src/mandate-diff";
import {
  type Flip,
  flipView,
  MANDATE_COPY,
  postJson,
  type Replay,
  ReplaySchema,
  replayDraft,
  replaySummary,
  SIGN_PATH,
  signDraft,
} from "../src/mandate-editor";
import { readBackRule } from "../src/mandate-readback";
import { MANDATE_ROUTE_MESSAGES, replayRoute, signRoute } from "../src/mandate-routes";

// The mandate page's diff, replay wording and its replay and sign routes (PLAN E2). The gate is a
// fake that records what it was sent; the gate's own replay and signature are tested in
// apps/gate/test/mandate-replay.test.ts. Illustrative keys.

const parsed = parseMandate(supportMandate);
if (!parsed.ok) throw new Error(parsed.error);
const V3: Mandate = parsed.mandate;
const V3_HASH = hashMandate(V3).hash;

const KEY = "approver-key-0123456789abcdefghijklmnop";
const SIGNED_IN = `${APPROVER_COOKIE}=${encodeURIComponent(KEY)}`;
const env = { GATE_URL: "http://gate.test" };

function draftOf(change: (draft: Mandate) => void = () => {}): Mandate {
  const draft = structuredClone(V3);
  draft.version = 4;
  change(draft);
  return draft;
}

function rule(mandate: Mandate, id: string) {
  const found = mandate.rules.find((r) => r.id === id);
  if (found === undefined) throw new Error(`no rule ${id}`);
  return found;
}

// --- The diff ----------------------------------------------------------------------------------

describe("diffMandates", () => {
  it("finds nothing when only the version changes, whatever the key order", () => {
    const reordered = JSON.parse(stableJson(draftOf())) as Mandate;
    expect(diffMandates(V3, reordered)).toEqual({ items: [], unchangedRules: 5 });
  });

  it("doesn't count a rule moving, or one action written as a list, as a change", () => {
    const draft = draftOf((d) => {
      d.rules.reverse();
      for (const r of d.rules) {
        r.action = typeof r.action === "string" ? [r.action] : [...r.action].reverse();
      }
    });
    expect(diffMandates(V3, draft)).toEqual({ items: [], unchangedRules: 5 });
  });

  it("words a changed, an added and a removed rule as the read-back does", () => {
    const draft = draftOf((d) => {
      rule(d, "refund-damaged").max = { amount: 30_000, currency: "USD" };
      d.rules = d.rules.filter((r) => r.id !== "refund-wrong-item");
      d.rules.push({
        id: "refund-in-transit",
        action: "paypal.refund",
        when: { claim: "not_received", "shipment.status": ["in_transit"] },
        decide: "deny",
        reason: "RULE_DENIES",
      });
    });
    const lines = (r: Mandate["rules"][number]) => {
      const read = readBackRule(r);
      return [read.sentence, read.checks, read.reason].filter((l) => l !== null);
    };
    const { items, unchangedRules } = diffMandates(V3, draft);
    expect(unchangedRules).toBe(3);
    expect(items).toEqual([
      {
        area: "rule",
        id: "refund-damaged",
        kind: "changed",
        before: lines(rule(V3, "refund-damaged")),
        after: lines(rule(draft, "refund-damaged")),
      },
      {
        area: "rule",
        id: "refund-wrong-item",
        kind: "removed",
        before: lines(rule(V3, "refund-wrong-item")),
        after: null,
      },
      {
        area: "rule",
        id: "refund-in-transit",
        kind: "added",
        before: null,
        after: lines(rule(draft, "refund-in-transit")),
      },
    ]);
    expect(items[0]?.before?.[0]).toContain("$50.00");
    expect(items[0]?.after?.[0]).toContain("$300.00");
  });

  it("words a changed and a dropped daily limit", () => {
    const draft = draftOf((d) => {
      d.limits = [{ currency: "USD", per_day_total: 50_000, per_day_count: 5 }];
    });
    const { items } = diffMandates(V3, draft);
    expect(items.map((item) => [item.area, item.id, item.kind])).toEqual([
      ["limit", "USD", "changed"],
      ["limit", "KES", "changed"],
    ]);
    expect(items[0]?.after?.[0]).toContain("$500.00 in total");
    expect(items[1]?.after?.[0]).toContain("no daily limit");
  });
});

// --- The replay in words -----------------------------------------------------------------------

const ref = (version: number) => ({ id: V3.id, version, hash: "a".repeat(64) });

function flip(over: Partial<Flip>): Flip {
  return {
    seq: 12,
    intent_id: "int_0123456789abcdef01234567",
    ticket_id: "tkt_illustrative",
    action: "paypal.refund",
    amount: { minor: 24_000, currency: "USD" },
    claim: "damaged",
    before: "step_up",
    after: "allow",
    reasons: [],
    direction: "looser",
    ...over,
  };
}

function replayOf(flips: Flip[], over: Partial<Replay> = {}): Replay {
  return {
    base: ref(3),
    draft: ref(4),
    replayed: 7,
    unchanged: 7 - flips.length,
    flips,
    counts: {},
    skipped: { other_mandate: 0, no_intent: 0, unreadable: 0 },
    partial: false,
    ...over,
  };
}

describe("replaySummary", () => {
  it("says the change flips nothing", () => {
    expect(replaySummary(replayOf([]))).toEqual([
      "This change flips none of the 7 decisions recorded under version 3.",
    ]);
  });

  it("says when there's nothing to replay", () => {
    expect(replaySummary(replayOf([], { replayed: 0, unchanged: 0 }))).toEqual([
      "The audit log holds no decisions under version 3 to replay.",
    ]);
  });

  it("puts what it would auto-approve first, as the brief's example does", () => {
    const flips = [
      flip({ seq: 3, before: "deny", after: "allow" }),
      flip({ seq: 4 }),
      flip({ seq: 5, before: "deny", after: "step_up" }),
      flip({ seq: 6, before: "allow", after: "step_up", direction: "tighter" }),
    ];
    const replay = replayOf(flips, {
      skipped: { other_mandate: 1, no_intent: 2, unreadable: 1 },
      partial: true,
    });
    expect(replaySummary(replay)).toEqual([
      "This change would have auto-approved 2 actions that version 3 held or denied.",
      "It would have held 1 action that version 3 denied.",
      "It would have held or denied 1 action that version 3 let through further.",
      "3 other decisions of 7 stay the same.",
      "Not replayed: 1 decision under another version, 2 proposals refused before any rule, 1 unreadable entry.",
      "Only the newest decisions were replayed; older ones weren't.",
    ]);
  });

  it("shows a flip with its money, badges and a link to the decision", () => {
    expect(flipView(flip({}))).toEqual({
      key: "12",
      title: "paypal.refund",
      amount: "$240.00",
      ticket: "tkt_illustrative",
      before: { label: "Step-up", tone: "warning" },
      after: { label: "Allowed", tone: "positive" },
      reasons: [],
      href: "/decisions/12",
    });
  });
});

// --- The routes --------------------------------------------------------------------------------

type GateCall = { url: string; method: string; auth: string | null; body: unknown };

function fakeGate(answer: (path: string, body: unknown) => Response) {
  const calls: GateCall[] = [];
  const fetchFake = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
    const headers = new Headers(init?.headers);
    calls.push({
      url: url.toString(),
      method: init?.method ?? "GET",
      auth: headers.get("authorization"),
      body,
    });
    if (url.pathname === "/approvals") return Response.json({ open: [], recent: [] });
    return answer(url.pathname, body);
  }) as typeof fetch;
  return { calls, fetch: fetchFake };
}

const post = (path: string, body: unknown, cookie: string | null = SIGNED_IN) =>
  new Request(`http://console.test${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(cookie === null ? {} : { cookie }) },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

async function bodyOf(response: Response) {
  return { status: response.status, body: await response.json() };
}

const DRAFT = draftOf((d) => {
  rule(d, "refund-damaged").max = { amount: 30_000, currency: "USD" };
});
const REPLAY = replayOf([flip({})], { draft: { id: V3.id, version: 4, hash: "b".repeat(64) } });
const SIGNED = {
  id: V3.id,
  version: 4,
  hash: hashMandate(DRAFT).hash,
  seq: 9,
  entry_hash: "c".repeat(64),
  already_signed: false,
  in_force: { version: 3, hash: V3_HASH },
};

describe("POST /api/mandate/replay", () => {
  it("sends the draft to the gate with the cookie's key and passes the replay on", async () => {
    const gate = fakeGate(() => Response.json(REPLAY));
    const response = await replayRoute(post("/api/mandate/replay", { mandate: DRAFT }), {
      env,
      fetch: gate.fetch,
    });
    expect(await bodyOf(response)).toEqual({ status: 200, body: ReplaySchema.parse(REPLAY) });
    expect(gate.calls.map((c) => [c.method, c.url, c.auth])).toEqual([
      ["GET", "http://gate.test/approvals", `Bearer ${KEY}`],
      ["POST", "http://gate.test/mandates/replay", `Bearer ${KEY}`],
    ]);
    expect(gate.calls[1]?.body).toEqual({ mandate: DRAFT });
  });

  it("refuses signed out, before the gate is called", async () => {
    const gate = fakeGate(() => Response.json(REPLAY));
    const response = await replayRoute(post("/api/mandate/replay", { mandate: DRAFT }, null), {
      env,
      fetch: gate.fetch,
    });
    expect(await bodyOf(response)).toEqual({
      status: 401,
      body: { message: APPROVAL_ROUTE_MESSAGES.signedOut },
    });
    expect(gate.calls).toEqual([]);
  });

  it("refuses a body that isn't a draft without sending it", async () => {
    const gate = fakeGate(() => Response.json(REPLAY));
    for (const body of [{ mandate: "v4" }, { mandate: DRAFT, extra: true }, "not json"]) {
      const response = await replayRoute(post("/api/mandate/replay", body), {
        env,
        fetch: gate.fetch,
      });
      expect(await bodyOf(response)).toEqual({
        status: 400,
        body: { message: MANDATE_ROUTE_MESSAGES.badReplay },
      });
    }
    expect(gate.calls.some((c) => c.url.endsWith("/mandates/replay"))).toBe(false);
  });

  it("passes the gate's sentence on, and treats an answer for another version as junk", async () => {
    const refused = fakeGate(() =>
      Response.json({ message: "The draft must be the next version." }, { status: 400 }),
    );
    expect(
      await bodyOf(
        await replayRoute(post("/api/mandate/replay", { mandate: DRAFT }), {
          env,
          fetch: refused.fetch,
        }),
      ),
    ).toEqual({ status: 400, body: { message: "The draft must be the next version." } });

    const other = fakeGate(() => Response.json({ ...REPLAY, draft: ref(5) }));
    const response = await replayRoute(post("/api/mandate/replay", { mandate: DRAFT }), {
      env,
      fetch: other.fetch,
    });
    expect(await bodyOf(response)).toEqual({
      status: 502,
      body: { message: APPROVAL_ROUTE_MESSAGES.unreachable },
    });
  });
});

describe("POST /api/mandate/sign", () => {
  it("signs through the gate and answers with the version, its hash and the entry", async () => {
    const gate = fakeGate(() => Response.json(SIGNED, { status: 201 }));
    const response = await signRoute(post(SIGN_PATH, { mandate: DRAFT, base_hash: V3_HASH }), {
      env,
      fetch: gate.fetch,
    });
    expect(await bodyOf(response)).toEqual({ status: 200, body: SIGNED });
    expect(gate.calls[1]).toMatchObject({
      url: "http://gate.test/mandates/sign",
      method: "POST",
      body: { mandate: DRAFT, base_hash: V3_HASH },
    });
  });

  it("passes a conflict's sentence on", async () => {
    const gate = fakeGate(() =>
      Response.json({ message: "That version is already signed." }, { status: 409 }),
    );
    const response = await signRoute(post(SIGN_PATH, { mandate: DRAFT, base_hash: V3_HASH }), {
      env,
      fetch: gate.fetch,
    });
    expect(await bodyOf(response)).toEqual({
      status: 409,
      body: { message: "That version is already signed." },
    });
  });

  it("refuses a sign with no base hash, before the gate is asked", async () => {
    const gate = fakeGate(() => Response.json(SIGNED, { status: 201 }));
    const response = await signRoute(post(SIGN_PATH, { mandate: DRAFT }), {
      env,
      fetch: gate.fetch,
    });
    expect(await bodyOf(response)).toEqual({
      status: 400,
      body: { message: MANDATE_ROUTE_MESSAGES.badSign },
    });
    expect(gate.calls.some((c) => c.url.endsWith("/mandates/sign"))).toBe(false);
  });
});

describe("the page's calls", () => {
  it("reads the console's answers and refusals", async () => {
    const ok = (async () => Response.json(REPLAY)) as unknown as typeof fetch;
    expect(await replayDraft(DRAFT, { fetch: ok })).toEqual({
      ok: true,
      value: ReplaySchema.parse(REPLAY),
    });
    const refused = (async () =>
      Response.json({ message: "No." }, { status: 409 })) as unknown as typeof fetch;
    expect(await signDraft(DRAFT, V3_HASH, { fetch: refused })).toEqual({
      ok: false,
      message: "No.",
    });
    const out = (async () =>
      Response.json({ message: "x" }, { status: 401 })) as unknown as typeof fetch;
    expect(await signDraft(DRAFT, V3_HASH, { fetch: out })).toEqual({
      ok: false,
      signedOut: true,
      message: APPROVAL_ROUTE_MESSAGES.signedOut,
    });
    const down = (async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;
    expect(await postJson("/x", {}, ReplaySchema, { fetch: down })).toEqual({
      ok: false,
      message: MANDATE_COPY.unreachable,
    });
  });
});
