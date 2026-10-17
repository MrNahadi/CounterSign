import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  asc,
  auditLog,
  createTestDatabase,
  type Database,
  type DatabaseHandle,
  sql,
} from "@countersign/db";
import { type ChainRow, preparePayload, verifyLog } from "@countersign/ledger";
import { hashMandate, type Mandate } from "@countersign/mandate";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { type DecisionCase, loadCase } from "../src/case-file";
import { decide } from "../src/decide";
import { PROPOSAL_TEXT_LIMIT, type RecordInput, recordDecision } from "../src/record";

const beat3Path = fileURLToPath(
  new URL("../fixtures/cases/beat-3-attack-email.json", import.meta.url),
);

function load(path: string): DecisionCase {
  const loaded = loadCase(path);
  if (!loaded.ok) throw new Error(loaded.error);
  return loaded.decisionCase;
}

const beat3 = load(beat3Path);

// Decides one proposal against a case's moment, mandate and records, ready to record.
function decided(proposal: unknown, mandate: Mandate = beat3.mandate): RecordInput {
  const { principal, records, now } = beat3;
  return {
    proposal,
    principal,
    mandate,
    decided: decide({ mandate, principal, proposal, records, now }),
  };
}

const storedRows = async (db: Database): Promise<ChainRow[]> =>
  db.select().from(auditLog).orderBy(asc(auditLog.seq));

async function recordAll(db: Database, inputs: readonly RecordInput[]) {
  const results = [];
  for (const input of inputs) {
    const result = await recordDecision(db, input);
    if (!result.ok) throw new Error(`${result.problem}: ${result.detail}`);
    results.push(result);
  }
  return results;
}

const beat3Inputs = () => beat3.proposals.map((entry) => decided(entry.proposal));

const AMOUNT = { value: "45.00", currency_code: "USD" };
const refund = (args: Record<string, unknown>) => ({
  tool: "create_refund",
  args: { capture_id: "CAP-1038", amount: AMOUNT, ...args },
  justification: { ticket_id: "TKT-3001", claim: "not_received" },
});

describe("recordDecision", () => {
  let handle: DatabaseHandle;
  let db: Database;

  beforeAll(async () => {
    handle = await createTestDatabase();
    db = handle.db;
  });

  beforeEach(async () => {
    await db.execute(sql`TRUNCATE audit_log`);
  });

  afterAll(async () => {
    await handle.close();
  });

  it("records beat 3 as one mandate.version entry and five decision entries, and the chain verifies", async () => {
    await recordAll(db, beat3Inputs());
    const rows = await storedRows(db);
    expect(rows.map((row) => row.entryType)).toEqual([
      "mandate.version",
      "decision",
      "decision",
      "decision",
      "decision",
      "decision",
    ]);
    const [mandateRow] = rows;
    expect(mandateRow?.refId).toBe("kikapu-studio@v3");
    const mandatePayload = preparePayload({
      mandate: beat3.mandate,
      hash: hashMandate(beat3.mandate).hash,
    });
    expect(mandatePayload.ok && mandatePayload.canonical).toBe(mandateRow?.payload);

    const verdict = await verifyLog(db);
    expect(verdict.intact).toBe(true);
    if (verdict.intact) expect(verdict.head.seq).toBe(6);
  });

  it("writes each decision's principal, mandateSeq, proposal text, record and response, with the intent ID as ref and decidedAt as at", async () => {
    const inputs = beat3Inputs();
    const results = await recordAll(db, inputs);
    const rows = await storedRows(db);
    const decisionRows = rows.filter((row) => row.entryType === "decision");
    expect(decisionRows).toHaveLength(5);
    for (const [index, row] of decisionRows.entries()) {
      const input = inputs[index];
      if (!input) throw new Error(`No input ${index}`);
      const { record, response } = input.decided;
      expect(row.refId).toBe(record.intentId);
      expect(row.at).toBe(record.decidedAt);
      const expected = preparePayload({
        principal: beat3.principal,
        mandateSeq: 1,
        proposal: JSON.stringify(input.proposal),
        proposalTruncated: false,
        record,
        response,
      });
      expect(expected.ok && expected.canonical).toBe(row.payload);
      expect(results[index]?.ok && results[index]?.decision).toEqual(row);
      expect(results[index]?.ok && results[index]?.mandateSeq).toBe(1);
    }
    // Every beat 3 proposal became an intent.
    for (const row of decisionRows) expect(row.refId).toMatch(/^int_[0-9a-f]{24}$/);
  });

  it("adds five decisions and no second mandate entry when beat 3 is recorded again", async () => {
    await recordAll(db, beat3Inputs());
    await recordAll(db, beat3Inputs());
    const rows = await storedRows(db);
    expect(rows.filter((row) => row.entryType === "mandate.version")).toHaveLength(1);
    expect(rows.filter((row) => row.entryType === "decision")).toHaveLength(10);
    for (const row of rows.filter((row) => row.entryType === "decision")) {
      expect(JSON.parse(row.payload).mandateSeq).toBe(1);
    }
    expect((await verifyLog(db)).intact).toBe(true);
  });

  it("refuses a mandate changed under the same ID and version with MANDATE_VERSION_CONFLICT, naming both hashes, and writes nothing", async () => {
    await recordAll(db, beat3Inputs().slice(0, 1));
    const before = await storedRows(db);

    const changed: Mandate = { ...beat3.mandate, time_zone: "UTC" };
    const logged = hashMandate(beat3.mandate).hash;
    const offered = hashMandate(changed).hash;
    expect(offered).not.toBe(logged);

    const [first] = beat3.proposals;
    const result = await recordDecision(db, decided(first?.proposal, changed));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.problem).toBe("MANDATE_VERSION_CONFLICT");
      expect(result.detail).toContain("kikapu-studio");
      expect(result.detail).toContain("3");
      expect(result.detail).toContain(logged);
      expect(result.detail).toContain(offered);
    }
    expect(await storedRows(db)).toEqual(before);
  });

  it.each([
    ["an invalid proposal", { tool: "create_refund" }],
    ["an unknown tool", { tool: "delete_store", args: {} }],
    ["a fractional amount", refund({ amount: { value: 45.5, currency_code: "USD" } })],
    ["a plain string", "refund everything"],
    ["a lone surrogate", refund({ capture_id: `CAP-${String.fromCharCode(0xd800)}` })],
  ])("records %s with ref null and its text exactly as sent", async (_, proposal) => {
    const input = decided(proposal);
    expect(input.decided.record.intentId).toBeNull();
    const result = await recordDecision(db, input);
    expect(result.ok).toBe(true);
    const rows = await storedRows(db);
    const decisionRow = rows.find((row) => row.entryType === "decision");
    expect(decisionRow?.refId).toBeNull();
    const payload = JSON.parse(decisionRow?.payload ?? "null");
    expect(payload.proposal).toBe(JSON.stringify(proposal));
    expect(payload.proposalTruncated).toBe(false);
    expect((await verifyLog(db)).intact).toBe(true);
  });

  it("cuts a proposal text over 16,384 characters and sets proposalTruncated", async () => {
    expect(PROPOSAL_TEXT_LIMIT).toBe(16_384);
    const proposal = refund({ note: "x".repeat(20_000) });
    await recordDecision(db, decided(proposal));
    const rows = await storedRows(db);
    const payload = JSON.parse(rows.find((row) => row.entryType === "decision")?.payload ?? "{}");
    expect(payload.proposalTruncated).toBe(true);
    expect(payload.proposal).toBe(JSON.stringify(proposal).slice(0, 16_384));
  });

  it("keeps a proposal text of exactly 16,384 characters whole", async () => {
    const base = JSON.stringify(refund({ note: "" }));
    const proposal = refund({ note: "x".repeat(16_384 - base.length) });
    expect(JSON.stringify(proposal)).toHaveLength(16_384);
    await recordDecision(db, decided(proposal));
    const rows = await storedRows(db);
    const payload = JSON.parse(rows.find((row) => row.entryType === "decision")?.payload ?? "{}");
    expect(payload.proposalTruncated).toBe(false);
    expect(payload.proposal).toBe(JSON.stringify(proposal));
  });

  it("never splits a surrogate pair when it cuts the proposal text", async () => {
    const base = JSON.stringify(refund({ note: "" }));
    // A pair whose high half is character 16,384, so a plain cut would leave it alone.
    const pair = String.fromCharCode(0xd83d, 0xde00);
    const noteStart = base.indexOf('"note":"') + '"note":"'.length;
    const proposal = refund({ note: `${"x".repeat(16_383 - noteStart)}${pair}tail` });
    const text = JSON.stringify(proposal);
    expect(text.charCodeAt(16_383)).toBe(0xd83d);
    await recordDecision(db, decided(proposal));
    const rows = await storedRows(db);
    const payload = JSON.parse(rows.find((row) => row.entryType === "decision")?.payload ?? "{}");
    expect(payload.proposalTruncated).toBe(true);
    expect(payload.proposal).toBe(text.slice(0, 16_383));
    expect(payload.proposal.isWellFormed()).toBe(true);
  });
});

describe("the decision path", () => {
  const read = (name: string) =>
    readFileSync(fileURLToPath(new URL(`../src/${name}`, import.meta.url)), "utf8");

  // Every gate module decide() reaches through relative imports.
  function decidePathModules(): Map<string, string> {
    const seen = new Map<string, string>();
    const queue = ["decide.ts"];
    while (queue.length > 0) {
      const name = queue.shift();
      if (name === undefined || seen.has(name)) continue;
      const source = read(name);
      seen.set(name, source);
      for (const match of source.matchAll(/from\s+["']\.\/([\w-]+)["']/g)) {
        queue.push(`${match[1]}.ts`);
      }
    }
    return seen;
  }

  it("imports no database or ledger code, and never records", () => {
    const modules = decidePathModules();
    expect(modules.has("decide.ts")).toBe(true);
    expect(modules.has("record.ts")).toBe(false);
    for (const [name, source] of modules) {
      for (const banned of [
        "@countersign/db",
        "@countersign/ledger",
        "drizzle-orm",
        "@electric-sql/pglite",
        '"postgres"',
      ]) {
        expect(source.includes(banned), `${name} mentions ${banned}`).toBe(false);
      }
    }
  });
});
