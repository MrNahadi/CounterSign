import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  type ChainRow,
  ENTRY_TYPES,
  entryHash,
  GENESIS_HASH,
  preparePayload,
  verifyChain,
} from "../src/index";

const LONE = String.fromCharCode(0xd800);
const REPLACEMENT = String.fromCharCode(0xfffd);

type Spec = { entryType: string; refId: string | null; at: string; payload: unknown };

// Builds a valid chain through the exports, so a test only ever hand-edits what it tampers with.
function chain(specs: Spec[]): ChainRow[] {
  const rows: ChainRow[] = [];
  let prevHash = GENESIS_HASH;
  for (const [index, spec] of specs.entries()) {
    const prepared = preparePayload(spec.payload);
    if (!prepared.ok) throw new Error(prepared.detail);
    const seq = index + 1;
    const hash = entryHash({ ...spec, seq, prevHash, payload: prepared.value });
    rows.push({ ...spec, seq, prevHash, payload: prepared.canonical, hash });
    prevHash = hash;
  }
  return rows;
}

function rehash(row: ChainRow): ChainRow {
  return { ...row, hash: entryHash({ ...row, payload: JSON.parse(row.payload) }) };
}

const specs: Spec[] = [
  {
    entryType: "mandate.version",
    refId: "kikapu-studio@v3",
    at: "2026-10-17T06:40:00Z",
    payload: { mandate: { id: "kikapu-studio", version: 3 }, hash: "ab".repeat(32) },
  },
  {
    entryType: "decision",
    refId: "int_001",
    at: "2026-10-17T06:41:00Z",
    payload: { principal: "agent", mandateSeq: 1, amount: { minor: 2500, currency: "KES" } },
  },
  {
    entryType: "decision",
    refId: null,
    at: "2026-10-17T06:42:00+03:00",
    payload: { principal: "agent", mandateSeq: 1, proposal: "{}", proposalTruncated: false },
  },
  {
    entryType: "decision",
    refId: "int_002",
    at: "2026-10-17T06:43:00.123Z",
    payload: { principal: "agent", mandateSeq: 1 },
  },
];

function problemsOf(rows: ChainRow[]) {
  const verdict = verifyChain(rows);
  if (verdict.intact) return [];
  return verdict.problems.map(({ seq, problem }) => ({ seq, problem }));
}

describe("entry types", () => {
  it("are mandate.version and decision, in one list", () => {
    expect(ENTRY_TYPES).toEqual(["mandate.version", "decision"]);
  });
});

describe("the entry hash", () => {
  it("is the SHA-256 of the envelope's canonical JSON", () => {
    const envelope =
      '{"at":"2026-10-17T06:40:00Z","entryType":"decision","payload":{"a":"x","b":[1,true,null]},' +
      `"prevHash":"${"0".repeat(64)}","refId":"int_001","seq":1}`;
    const expected = createHash("sha256").update(envelope, "utf8").digest("hex");
    expect(GENESIS_HASH).toBe("0".repeat(64));
    expect(
      entryHash({
        seq: 1,
        entryType: "decision",
        refId: "int_001",
        at: "2026-10-17T06:40:00Z",
        prevHash: GENESIS_HASH,
        payload: { b: [1, true, null], a: "x" },
      }),
    ).toBe(expected);
  });

  it("writes a null ref as null", () => {
    const envelope = `{"at":"2026-10-17T06:40:00Z","entryType":"decision","payload":{},"prevHash":"${"0".repeat(64)}","refId":null,"seq":2}`;
    const expected = createHash("sha256").update(envelope, "utf8").digest("hex");
    expect(
      entryHash({
        seq: 2,
        entryType: "decision",
        refId: null,
        at: "2026-10-17T06:40:00Z",
        prevHash: GENESIS_HASH,
        payload: {},
      }),
    ).toBe(expected);
  });
});

describe("payload preparation", () => {
  it("makes every string well-formed, keys included", () => {
    const prepared = preparePayload({ [`k${LONE}`]: [`a${LONE}b`, { inner: LONE }] });
    expect(prepared).toEqual({
      ok: true,
      value: { [`k${REPLACEMENT}`]: [`a${REPLACEMENT}b`, { inner: REPLACEMENT }] },
      canonical: `{"k${REPLACEMENT}":["a${REPLACEMENT}b",{"inner":"${REPLACEMENT}"}]}`,
    });
  });

  it("drops absent fields and returns the canonical text", () => {
    const record: { z: number; a: string; reason?: string; nested: { gone?: string; kept: null } } =
      { z: 1, a: "x", reason: undefined, nested: { gone: undefined, kept: null } };
    expect(preparePayload(record)).toEqual({
      ok: true,
      value: { a: "x", nested: { kept: null }, z: 1 },
      canonical: '{"a":"x","nested":{"kept":null},"z":1}',
    });
  });

  it("takes readonly arrays and null-prototype objects", () => {
    const bare = Object.assign(Object.create(null), { b: 2, a: 1 });
    const list: readonly number[] = Object.freeze([3, 1]);
    expect(preparePayload({ bare, list })).toMatchObject({
      ok: true,
      canonical: '{"bare":{"a":1,"b":2},"list":[3,1]}',
    });
  });

  it.each([
    ["a fraction", { amount: 1.5 }, "1.5"],
    ["an unsafe integer", { amount: 2 ** 53 }, String(2 ** 53)],
    ["NaN", { amount: Number.NaN }, "NaN"],
    ["Infinity", [Number.POSITIVE_INFINITY], "Infinity"],
  ])("reports %s without throwing", (_name, value, shown) => {
    const prepared = preparePayload(value);
    expect(prepared.ok).toBe(false);
    if (!prepared.ok) expect(prepared.detail).toContain(shown);
  });

  it.each([
    ["undefined", undefined],
    ["a bigint", { n: 1n }],
    ["a function", { f: () => 1 }],
    ["a symbol", { s: Symbol("s") }],
    ["a date", { at: new Date(0) }],
    ["a map", { m: new Map() }],
    ["an absent array element", [1, undefined]],
    ["a sparse array", new Array<number>(2)],
  ])("reports %s, which JSON can't hold, without throwing", (_name, value) => {
    expect(preparePayload(value)).toMatchObject({ ok: false });
  });

  it("reports a cycle without throwing", () => {
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    expect(preparePayload(cyclic)).toMatchObject({ ok: false });
  });

  it("allows the same object twice when it isn't a cycle", () => {
    const shared = { a: 1 };
    expect(preparePayload({ x: shared, y: shared })).toMatchObject({
      ok: true,
      canonical: '{"x":{"a":1},"y":{"a":1}}',
    });
  });
});

describe("verifyChain", () => {
  it("passes an empty list, with the genesis hash as its head", () => {
    expect(verifyChain([])).toEqual({
      intact: true,
      entries: 0,
      head: { seq: 0, hash: GENESIS_HASH },
    });
  });

  it("passes a valid chain, with the last seq and hash as its head", () => {
    const rows = chain(specs);
    expect(rows[0]?.prevHash).toBe(GENESIS_HASH);
    expect(verifyChain(rows)).toEqual({
      intact: true,
      entries: 4,
      head: { seq: 4, hash: rows[3]?.hash },
    });
  });

  it.each<[string, (row: ChainRow) => ChainRow]>([
    ["payload", (row) => ({ ...row, payload: row.payload.replace("2500", "250000") })],
    ["entry type", (row) => ({ ...row, entryType: "mandate.version" })],
    ["ref", (row) => ({ ...row, refId: "int_999" })],
    ["time", (row) => ({ ...row, at: "2026-10-17T06:41:30Z" })],
    ["hash", (row) => ({ ...row, hash: "f".repeat(64) })],
  ])("reports an edited %s once, at its own seq", (_name, edit) => {
    const rows = chain(specs);
    rows[1] = edit(rows[1] as ChainRow);
    expect(problemsOf(rows)).toEqual([{ seq: 2, problem: "HASH_MISMATCH" }]);
  });

  it("reports an edit with its hash recomputed as BROKEN_LINK on the next row", () => {
    const rows = chain(specs);
    const row = rows[1] as ChainRow;
    rows[1] = rehash({ ...row, payload: row.payload.replace("2500", "250000") });
    expect(problemsOf(rows)).toEqual([{ seq: 3, problem: "BROKEN_LINK" }]);
  });

  it("reports a deleted middle row as SEQ_GAP and BROKEN_LINK", () => {
    const rows = chain(specs);
    rows.splice(1, 1);
    expect(problemsOf(rows)).toEqual([
      { seq: 3, problem: "SEQ_GAP" },
      { seq: 3, problem: "BROKEN_LINK" },
    ]);
  });

  it("reports two swapped rows at both positions", () => {
    const rows = chain(specs);
    const [second, third] = [rows[1] as ChainRow, rows[2] as ChainRow];
    rows[1] = { ...third, seq: 2 };
    rows[2] = { ...second, seq: 3 };
    const problems = problemsOf(rows);
    expect(problems).toEqual(
      expect.arrayContaining([
        { seq: 2, problem: "BROKEN_LINK" },
        { seq: 2, problem: "HASH_MISMATCH" },
        { seq: 3, problem: "BROKEN_LINK" },
        { seq: 3, problem: "HASH_MISMATCH" },
      ]),
    );
    expect(problems.every(({ seq }) => seq >= 2)).toBe(true);
  });

  it("reports a non-canonical payload with the same value as NOT_CANONICAL only", () => {
    const rows = chain(specs);
    const row = rows[1] as ChainRow;
    const reordered = JSON.stringify({
      principal: "agent",
      mandateSeq: 1,
      amount: { minor: 2500, currency: "KES" },
    });
    expect(reordered).not.toBe(row.payload);
    rows[1] = { ...row, payload: reordered };
    expect(problemsOf(rows)).toEqual([{ seq: 2, problem: "NOT_CANONICAL" }]);
  });

  it("reports an unknown entry type", () => {
    const rows = chain([specs[0] as Spec, { ...(specs[1] as Spec), entryType: "approval" }]);
    expect(problemsOf(rows)).toEqual([{ seq: 2, problem: "UNKNOWN_ENTRY_TYPE" }]);
  });

  it("reports a bad timestamp", () => {
    const rows = chain([specs[0] as Spec, { ...(specs[1] as Spec), at: "2026-02-31T10:00:00Z" }]);
    expect(problemsOf(rows)).toEqual([{ seq: 2, problem: "BAD_TIMESTAMP" }]);
  });

  it("reports payload text that isn't JSON", () => {
    const rows = chain(specs);
    rows[1] = { ...(rows[1] as ChainRow), payload: "{not json" };
    expect(problemsOf(rows)).toEqual([{ seq: 2, problem: "NOT_CANONICAL" }]);
  });

  it("checks the first row against seq 1 and the genesis hash", () => {
    const rows = chain(specs).slice(1);
    expect(problemsOf(rows)).toEqual([
      { seq: 2, problem: "SEQ_GAP" },
      { seq: 2, problem: "BROKEN_LINK" },
    ]);
  });

  it("reports a first row that doesn't link to genesis", () => {
    const rows = chain(specs);
    rows[0] = rehash({ ...(rows[0] as ChainRow), prevHash: "1".repeat(64) });
    expect(problemsOf(rows)).toEqual([
      { seq: 1, problem: "BROKEN_LINK" },
      { seq: 2, problem: "BROKEN_LINK" },
    ]);
  });

  it("gives every problem a one-line detail and counts the entries", () => {
    const rows = chain(specs);
    rows.splice(1, 1);
    const verdict = verifyChain(rows);
    expect(verdict.intact).toBe(false);
    expect(verdict.entries).toBe(3);
    if (!verdict.intact) {
      for (const { detail } of verdict.problems) {
        expect(detail.length).toBeGreaterThan(0);
        expect(detail).not.toContain("\n");
      }
    }
  });

  it("never throws, whatever the rows hold", () => {
    const rows = chain(specs);
    const row = rows[1] as ChainRow;
    const odd: ChainRow[] = [
      { ...row, entryType: LONE },
      { ...row, refId: LONE, at: `2026-10-17T06:41:00Z${LONE}` },
      { ...row, payload: '"\\ud800"' },
      { ...row, payload: "1e400" },
      { ...row, payload: "1.5" },
      { ...row, payload: "" },
      { ...row, payload: "[".repeat(100_000) + "]".repeat(100_000) },
      { ...row, prevHash: `x\n${LONE}`, hash: "" },
      { ...row, seq: Number.NaN },
    ];
    for (const bad of odd) {
      const verdict = verifyChain([rows[0] as ChainRow, bad]);
      expect(verdict.intact).toBe(false);
      if (!verdict.intact) {
        for (const { detail } of verdict.problems) expect(detail).not.toContain("\n");
      }
    }
  });
});
