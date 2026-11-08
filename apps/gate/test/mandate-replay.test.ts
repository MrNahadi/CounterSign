import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import {
  and,
  asc,
  auditLog,
  createTestDatabase,
  type Database,
  type DatabaseHandle,
  eq,
} from "@countersign/db";
import { appendEntry, verifyLog } from "@countersign/ledger";
import { hashMandate, type Mandate } from "@countersign/mandate";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { APPROVAL_MESSAGES } from "../src/approvals-api";
import { APPROVER_KEY_VAR } from "../src/approver";
import { loadCase } from "../src/case-file";
import { decide } from "../src/decide";
import { MANDATE_MESSAGES } from "../src/mandate-api";
import {
  checkDraft,
  DRAFT_PROBLEMS,
  readLoggedDecisions,
  replayDecisions,
} from "../src/mandate-replay";
import { OPS_AGENT_KEY_VAR, SUPPORT_AGENT_KEY_VAR } from "../src/principals";
import { recordDecision } from "../src/record";

// The mandate replay and signature (PLAN E2). The log holds real decisions: the demo's beats 3
// (four denials, one hold), 4 (a stalled parcel allowed) and 5 (a $240 damaged claim held), each
// decided by decide() under mandate v3 and recorded, plus one proposal that never became an
// intent, one decision under another version and one unreadable entry. PGlite, illustrative keys.

const SLOW = 120_000;
const AT = "2026-10-17T09:30:00+03:00";
const APPROVER_KEY = "approver-key-illustrative-0123456789abcd";
const ENV = {
  [SUPPORT_AGENT_KEY_VAR]: "agent-key-illustrative-0123456789abcdef",
  [OPS_AGENT_KEY_VAR]: "ops-key-illustrative-0123456789abcdefghi",
  [APPROVER_KEY_VAR]: APPROVER_KEY,
};

const casePath = (name: string) =>
  fileURLToPath(new URL(`../fixtures/cases/${name}.json`, import.meta.url));

function caseOf(name: string) {
  const loaded = loadCase(casePath(name));
  if (!loaded.ok) throw new Error(loaded.error);
  return loaded.decisionCase;
}

const beat3 = caseOf("beat-3-attack-email");
const beat4 = caseOf("beat-4-stalled-parcel");
const beat5 = caseOf("beat-5-damaged-with-photo");
const v3 = beat3.mandate;

/** Version 4 with `change` applied to a copy of v3. */
function draftOf(change: (draft: Mandate) => void = () => {}): Mandate {
  const draft = structuredClone(v3);
  draft.version = v3.version + 1;
  change(draft);
  return draft;
}

function rule(mandate: Mandate, id: string) {
  const found = mandate.rules.find((r) => r.id === id);
  if (found === undefined) throw new Error(`no rule ${id}`);
  return found;
}

/** The damaged-item cap raised from $50 to $300: beat 5's $240 claim would no longer be held. */
const looserDamaged = () =>
  draftOf((draft) => {
    rule(draft, "refund-damaged").max = { amount: 30_000, currency: "USD" };
  });

async function recordCase(db: Database, decisionCase: ReturnType<typeof caseOf>) {
  const { mandate, principal, records, now, proposals } = decisionCase;
  for (const { proposal } of proposals) {
    const decided = decide({ mandate, principal, proposal, records, now });
    const result = await recordDecision(db, { proposal, principal, mandate, decided });
    if (!result.ok) throw new Error(result.detail);
  }
}

describe("checkDraft", () => {
  const mandates = [v3];

  it("takes the next version of a mandate the gate holds", () => {
    const draft = looserDamaged();
    expect(checkDraft(draft, mandates)).toEqual({ ok: true, base: v3, draft });
  });

  it.each([
    ["the same version", { ...draftOf(), version: 3 }, DRAFT_PROBLEMS.version],
    ["a version it skips to", { ...draftOf(), version: 5 }, DRAFT_PROBLEMS.version],
    ["another principal", { ...draftOf(), principal: "ops-agent" }, DRAFT_PROBLEMS.principal],
    ["another time zone", { ...draftOf(), time_zone: "UTC" }, DRAFT_PROBLEMS.timeZone],
    [
      "a payee list",
      { ...draftOf(), payees: [{ email: "ops@example.com", name: "Illustrative" }] },
      DRAFT_PROBLEMS.payees,
    ],
    ["an unknown id", { ...draftOf(), id: "other-shop" }, DRAFT_PROBLEMS.unknownMandate],
  ])("refuses %s", (_name, draft, problem) => {
    expect(checkDraft(draft, mandates)).toEqual({ ok: false, problem });
  });

  it("refuses what isn't a mandate, saying why", () => {
    const checked = checkDraft({ ...looserDamaged(), fallback: "allow" }, mandates);
    expect(checked.ok).toBe(false);
    if (!checked.ok) expect(checked.problem.startsWith(`${DRAFT_PROBLEMS.invalid}: `)).toBe(true);
  });
});

describe("the replay", { timeout: SLOW }, () => {
  let handle: DatabaseHandle;
  let db: Database;
  let otherVersionSeq: number;
  let unreadableSeq: number;
  let beat5Seq: number;
  let beat4Seq: number;
  const servers: Server[] = [];

  beforeAll(async () => {
    handle = await createTestDatabase();
    db = handle.db;
    await recordCase(db, beat3);
    await recordCase(db, beat4);
    await recordCase(db, beat5);
    const decisions = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.entryType, "decision"))
      .orderBy(asc(auditLog.seq));
    beat4Seq = decisions[5]?.seq ?? 0;
    beat5Seq = decisions[6]?.seq ?? 0;
    // A proposal that never became an intent.
    const bad = decide({ ...beat4, proposal: { action: "paypal.refund" } });
    expect(bad.record.intent).toBeNull();
    await recordDecision(db, { ...beat4, proposal: {}, decided: bad });
    // Beat 4 again under a version 2 of the same mandate.
    const v2 = { ...v3, version: 2 };
    const proposal = beat4.proposals[0]?.proposal;
    const old = decide({ ...beat4, mandate: v2, proposal });
    const recorded = await recordDecision(db, {
      proposal,
      principal: beat4.principal,
      mandate: v2,
      decided: old,
    });
    if (!recorded.ok) throw new Error(recorded.detail);
    otherVersionSeq = recorded.decision.seq;
    const unreadable = await appendEntry(db, {
      entryType: "decision",
      refId: null,
      at: AT,
      payload: { note: "not a decision" },
    });
    if (!unreadable.ok) throw new Error("couldn't append");
    unreadableSeq = unreadable.entry.seq;
  }, SLOW);

  afterEach(async () => {
    for (const server of servers.splice(0)) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  afterAll(async () => {
    await handle?.close();
  });

  it("finds nothing to flip when only the version changes", async () => {
    const { decisions, partial } = await readLoggedDecisions(db);
    const replay = replayDecisions(v3, draftOf(), decisions, partial);
    expect(replay.flips).toEqual([]);
    expect(replay.replayed).toBe(7);
    expect(replay.unchanged).toBe(7);
    expect(replay.skipped).toEqual({ other_mandate: 1, no_intent: 1, unreadable: 1 });
    expect(replay.counts).toMatchObject({
      deny_to_deny: 4,
      step_up_to_step_up: 2,
      allow_to_allow: 1,
    });
    expect(replay.partial).toBe(false);
    expect(replay.base).toEqual({ id: v3.id, version: 3, hash: hashMandate(v3).hash });
  });

  it("lists the held $240 claim a higher damaged-item cap would allow", async () => {
    const { decisions } = await readLoggedDecisions(db);
    const replay = replayDecisions(v3, looserDamaged(), decisions);
    expect(replay.flips).toHaveLength(1);
    expect(replay.flips[0]).toMatchObject({
      seq: beat5Seq,
      action: "paypal.refund",
      amount: { minor: 24_000, currency: "USD" },
      claim: "damaged",
      before: "step_up",
      after: "allow",
      reasons: [],
      direction: "looser",
    });
    expect(replay.counts.step_up_to_allow).toBe(1);
  });

  it("lists the stalled-parcel refund a lower cap would hold, after the looser flips", async () => {
    const draft = looserDamaged();
    rule(draft, "refund-lost-parcel").max = { amount: 1_000, currency: "USD" };
    const { decisions } = await readLoggedDecisions(db);
    const replay = replayDecisions(v3, draft, decisions);
    expect(replay.flips.map((flip) => [flip.seq, flip.before, flip.after, flip.direction])).toEqual(
      [
        [beat5Seq, "step_up", "allow", "looser"],
        [beat4Seq, "allow", "step_up", "tighter"],
      ],
    );
    expect(replay.flips[1]?.reasons.map((reason) => reason.code)).toEqual(["ABOVE_AUTO_LIMIT"]);
  });

  it("denies when the draft requires a check the decision never ran", async () => {
    const draft = draftOf((d) => {
      const lost = rule(d, "refund-lost-parcel");
      lost.require = [...(lost.require ?? []), "evidence.photo_present"];
    });
    const { decisions } = await readLoggedDecisions(db);
    const replay = replayDecisions(v3, draft, decisions);
    const flip = replay.flips.find((f) => f.seq === beat4Seq);
    expect(flip).toMatchObject({ before: "allow", after: "deny", direction: "tighter" });
  });

  it("marks a replay partial when the log holds more than it reads", async () => {
    const { decisions, partial } = await readLoggedDecisions(db, 2);
    expect(decisions.map((d) => d.seq)).toEqual([unreadableSeq, otherVersionSeq]);
    expect(partial).toBe(true);
  });

  async function gate(withDb = true): Promise<string> {
    const server = createApp({
      ...(withDb ? { db } : {}),
      env: ENV,
      clock: () => new Date(AT),
    }).listen(0, "127.0.0.1");
    servers.push(server);
    await new Promise<void>((resolve) => server.once("listening", resolve));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  async function post(url: string, body: unknown, key: string | null = APPROVER_KEY) {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (key !== null) headers.Authorization = `Bearer ${key}`;
    const res = await fetch(url, {
      method: "POST",
      headers,
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
    const text = await res.text();
    expect(text).not.toContain(APPROVER_KEY);
    return { status: res.status, body: JSON.parse(text) };
  }

  it("answers a replay over HTTP, and only to the approver key", async () => {
    const base = await gate();
    const url = `${base}/mandates/replay`;
    expect(await post(url, { mandate: looserDamaged() }, null)).toEqual({
      status: 401,
      body: { message: APPROVAL_MESSAGES.unauthorized },
    });
    expect(await post(url, { mandate: looserDamaged(), extra: 1 })).toEqual({
      status: 400,
      body: { message: MANDATE_MESSAGES.badBody },
    });
    expect(await post(url, "{not json")).toEqual({
      status: 400,
      body: { message: MANDATE_MESSAGES.badBody },
    });
    expect(await post(url, { mandate: { ...draftOf(), version: 9 } })).toEqual({
      status: 400,
      body: { message: DRAFT_PROBLEMS.version },
    });
    const ok = await post(url, { mandate: looserDamaged() });
    expect(ok.status).toBe(200);
    expect(ok.body.flips).toHaveLength(1);
    expect(ok.body.draft).toEqual({
      id: v3.id,
      version: 4,
      hash: hashMandate(looserDamaged()).hash,
    });
    const noDb = await post(`${await gate(false)}/mandates/replay`, { mandate: looserDamaged() });
    expect(noDb).toEqual({ status: 503, body: { message: MANDATE_MESSAGES.unavailable } });
  });

  it("signs version 4 into the audit log once, with its hash, and keeps the chain intact", async () => {
    const url = `${await gate()}/mandates/sign`;
    const draft = looserDamaged();
    const hash = hashMandate(draft).hash;
    const baseHash = hashMandate(v3).hash;

    expect((await post(url, { mandate: draft, base_hash: baseHash }, null)).status).toBe(401);
    expect(await post(url, { mandate: draft, base_hash: "0".repeat(64) })).toEqual({
      status: 409,
      body: { message: MANDATE_MESSAGES.stale },
    });
    expect(await post(url, { mandate: draft })).toEqual({
      status: 400,
      body: { message: MANDATE_MESSAGES.badBody },
    });

    const signed = await post(url, { mandate: draft, base_hash: baseHash });
    expect(signed.status).toBe(201);
    expect(signed.body).toMatchObject({
      id: v3.id,
      version: 4,
      hash,
      already_signed: false,
      in_force: { version: 3, hash: baseHash },
    });
    const [entry] = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.entryType, "mandate.version"), eq(auditLog.refId, `${v3.id}@v4`)));
    expect(entry?.seq).toBe(signed.body.seq);
    expect(entry?.hash).toBe(signed.body.entry_hash);
    expect(entry?.at).toBe(new Date(AT).toISOString());
    expect(JSON.parse(entry?.payload ?? "{}")).toEqual({
      mandate: draft,
      hash,
      signed: { base: { version: 3, hash: baseHash } },
    });

    const again = await post(url, { mandate: draft, base_hash: baseHash });
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ seq: signed.body.seq, already_signed: true });

    const other = draftOf((d) => {
      rule(d, "refund-damaged").max = { amount: 10_000, currency: "USD" };
    });
    expect(await post(url, { mandate: other, base_hash: baseHash })).toEqual({
      status: 409,
      body: { message: MANDATE_MESSAGES.conflict },
    });
    const versions = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.entryType, "mandate.version"));
    expect(versions.filter((row) => row.refId === `${v3.id}@v4`)).toHaveLength(1);
    expect((await verifyLog(db)).intact).toBe(true);
  });
});
