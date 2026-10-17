// The audit log's hash chain, with no database (ADR 0022). Appending and verifying the table
// build on these; the tamper cases are tested here on plain rows.

import {
  canonicalJson,
  type JsonValue,
  sha256Canonical,
  TimestampSchema,
} from "@countersign/mandate";

// Every entry type the ledger knows. Later phases add theirs here; anything else is never
// appended, and verification reports it.
export const ENTRY_TYPES = ["mandate.version", "decision"] as const;
export type EntryType = (typeof ENTRY_TYPES)[number];

export function isEntryType(value: string): value is EntryType {
  return (ENTRY_TYPES as readonly string[]).includes(value);
}

// The previous hash of entry 1.
export const GENESIS_HASH = "0".repeat(64);

// What an entry's hash covers. `payload` is the payload value, not its text.
export type Envelope = {
  seq: number;
  entryType: string;
  refId: string | null;
  at: string;
  prevHash: string;
  payload: JsonValue;
};

// SHA-256, as lowercase hex, of the envelope's canonical JSON. Throws on what canonical JSON
// can't hold, so callers prepare the payload and check the other fields first.
export function entryHash(envelope: Envelope): string {
  const { seq, entryType, refId, at, prevHash, payload } = envelope;
  return sha256Canonical({ seq, entryType, refId, at, prevHash, payload }).hash;
}

// --- Payload preparation -------------------------------------------------------------------

export type PreparedPayload =
  | { ok: true; value: JsonValue; canonical: string }
  | { ok: false; detail: string };

class Unpreparable extends Error {}

function isPlainObject(value: object): boolean {
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function prepare(value: unknown, path: string, ancestors: Set<object>): JsonValue {
  if (value === null) return null;
  switch (typeof value) {
    case "boolean":
      return value;
    case "string":
      return value.toWellFormed();
    case "number":
      if (!Number.isSafeInteger(value)) {
        throw new Unpreparable(`${path} is ${value}, which isn't a safe integer`);
      }
      return value;
    case "object": {
      if (ancestors.has(value)) throw new Unpreparable(`${path} refers back to itself`);
      ancestors.add(value);
      try {
        if (Array.isArray(value)) {
          return Array.from(value, (item, index) => {
            if (item === undefined) throw new Unpreparable(`${path}[${index}] is absent`);
            return prepare(item, `${path}[${index}]`, ancestors);
          });
        }
        if (!isPlainObject(value)) throw new Unpreparable(`${path} isn't a plain object`);
        const out: { [key: string]: JsonValue } = {};
        for (const [rawKey, item] of Object.entries(value)) {
          // An absent field is left out, never written as null.
          if (item === undefined) continue;
          const key = rawKey.toWellFormed();
          if (Object.hasOwn(out, key)) {
            throw new Unpreparable(`${path} has two keys that read ${JSON.stringify(key)}`);
          }
          out[key] = prepare(item, `${path}.${JSON.stringify(key)}`, ancestors);
        }
        return out;
      } finally {
        ancestors.delete(value);
      }
    }
    default:
      throw new Unpreparable(`${path} is a ${typeof value}, which JSON can't hold`);
  }
}

// Makes a payload safe to hash and store: every string well-formed (a lone surrogate becomes
// U+FFFD), absent fields left out. Never throws; only a number that isn't a safe integer or a
// value JSON can't hold is reported.
export function preparePayload(value: unknown): PreparedPayload {
  try {
    const prepared = prepare(value, "payload", new Set());
    return { ok: true, value: prepared, canonical: canonicalJson(prepared) };
  } catch (error) {
    if (error instanceof Unpreparable) return { ok: false, detail: error.message };
    return { ok: false, detail: "payload can't be prepared: it nests too deeply" };
  }
}

// --- Verification --------------------------------------------------------------------------

export const CHAIN_PROBLEMS = [
  "SEQ_GAP",
  "BROKEN_LINK",
  "UNKNOWN_ENTRY_TYPE",
  "BAD_TIMESTAMP",
  "NOT_CANONICAL",
  "HASH_MISMATCH",
] as const;
export type ChainProblemCode = (typeof CHAIN_PROBLEMS)[number];

// One audit-log row as stored: `payload` is the canonical text that was hashed.
export type ChainRow = {
  seq: number;
  entryType: string;
  refId: string | null;
  at: string;
  payload: string;
  prevHash: string;
  hash: string;
};

export type ChainProblem = { seq: number; problem: ChainProblemCode; detail: string };
export type ChainHead = { seq: number; hash: string };

export type ChainVerdict =
  | { intact: true; entries: number; head: ChainHead }
  | { intact: false; entries: number; problems: ChainProblem[] };

// A value shown in a one-line detail: quoted and escaped, so it can't break the line, and cut
// short so a long value can't flood it.
function shown(value: unknown): string {
  const text = JSON.stringify(typeof value === "string" ? value.slice(0, 64) : String(value));
  return typeof value === "string" && value.length > 64 ? `${text}...` : text;
}

function short(hash: string): string {
  return shown(hash.slice(0, 12));
}

type Previous = { seq: number; hashes: string[] };

// Checks rows one at a time, in seq order, so a long log can be walked in pages.
export type ChainVerifier = { add(row: ChainRow): void; verdict(): ChainVerdict };

export function createChainVerifier(): ChainVerifier {
  const problems: ChainProblem[] = [];
  let entries = 0;
  let previous: Previous | undefined;
  let head: ChainHead = { seq: 0, hash: GENESIS_HASH };

  function check(row: ChainRow): string | undefined {
    const report = (problem: ChainProblemCode, detail: string) =>
      problems.push({ seq: row.seq, problem, detail });

    const expectedSeq = previous ? previous.seq + 1 : 1;
    if (row.seq !== expectedSeq) {
      report("SEQ_GAP", `expected seq ${expectedSeq}, found ${shown(row.seq)}`);
    }

    // A link is good when it matches the previous row's stored hash. If that stored hash was
    // itself edited, the link may match the hash recomputed from the previous row instead, so
    // an edited row is reported once, at its own seq, and its neighbours stay clean.
    const linkTargets = previous ? previous.hashes : [GENESIS_HASH];
    if (!linkTargets.includes(row.prevHash)) {
      const target = previous ? "the previous entry's hash" : "the genesis hash";
      report(
        "BROKEN_LINK",
        `prev_hash ${short(row.prevHash)} doesn't match ${target} ${short(linkTargets[0] ?? "")}`,
      );
    }

    if (!isEntryType(row.entryType)) {
      report("UNKNOWN_ENTRY_TYPE", `entry type ${shown(row.entryType)} isn't one the ledger knows`);
    }

    if (!TimestampSchema.safeParse(row.at).success) {
      report(
        "BAD_TIMESTAMP",
        `at ${shown(row.at)} isn't an ISO 8601 time with seconds and an offset`,
      );
    }

    // The stored text is parsed only to check that it's canonical. The recomputed hash covers
    // its own value.
    let payload: JsonValue;
    try {
      payload = JSON.parse(row.payload);
    } catch {
      report("NOT_CANONICAL", "payload isn't valid JSON");
      return undefined;
    }
    let canonical: string;
    try {
      canonical = canonicalJson(payload);
    } catch {
      report("NOT_CANONICAL", "payload holds a value canonical JSON can't hold");
      return undefined;
    }
    if (canonical !== row.payload) {
      report("NOT_CANONICAL", "payload isn't byte-for-byte its own canonical JSON");
    }

    let recomputed: string;
    try {
      recomputed = entryHash({ ...row, payload });
    } catch {
      report("HASH_MISMATCH", "the entry's columns can't be hashed");
      return undefined;
    }
    if (recomputed !== row.hash) {
      report(
        "HASH_MISMATCH",
        `stored hash ${short(row.hash)} isn't the recomputed ${short(recomputed)}`,
      );
    }
    return recomputed;
  }

  return {
    add(row) {
      const before = problems.length;
      let recomputed: string | undefined;
      try {
        recomputed = check(row);
      } catch {
        // Nothing above should throw; if something does, the row still counts as bad.
        if (problems.length === before) {
          problems.push({
            seq: row.seq,
            problem: "HASH_MISMATCH",
            detail: "the entry can't be checked",
          });
        }
      }
      entries += 1;
      const hashes = [row.hash];
      if (recomputed !== undefined && recomputed !== row.hash) hashes.push(recomputed);
      previous = { seq: row.seq, hashes };
      head = { seq: row.seq, hash: row.hash };
    },
    verdict() {
      if (problems.length === 0) return { intact: true, entries, head };
      return { intact: false, entries, problems: [...problems] };
    },
  };
}

// Checks a whole list of rows in seq order. Never throws on what the rows hold.
export function verifyChain(rows: readonly ChainRow[]): ChainVerdict {
  const verifier = createChainVerifier();
  for (const row of rows) verifier.add(row);
  return verifier.verdict();
}
