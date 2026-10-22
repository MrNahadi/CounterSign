// The evidence file (ADR 0034): chosen rows as stored, the chain verdict and head, and
// checkEvidence and `ledger check-export` re-hashing every row.
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  asc,
  auditLog,
  createTestDatabase,
  type Database,
  type DatabaseHandle,
  sql,
} from "@countersign/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  appendEntries,
  buildEvidence,
  type ChainRow,
  checkEvidence,
  EVIDENCE_CHECK,
  EVIDENCE_FORMAT,
  type EvidenceFile,
  EvidenceFileSchema,
  EvidenceRowsMissingError,
  EXIT_BROKEN,
  EXIT_NO_DATABASE,
  EXIT_OK,
  LEDGER_USAGE,
  runLedgerCli,
  verifyLog,
} from "../src/index";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const entry = fileURLToPath(new URL("../src/ledger-main.ts", import.meta.url));

const SLOW = 60_000;
const EXPORTED_AT = "2026-10-22T12:00:00.000Z";
const SCOPE = { kind: "intent", id: "int_2" } as const;

const entryAt = (n: number, entryType = "decision") => ({
  entryType,
  refId: n % 2 === 0 ? "int_2" : `int_${n}`,
  at: `2026-10-17T09:00:${String(n).padStart(2, "0")}.000Z`,
  payload: { n, note: "illustrative", amount: { minor: 1250 * n, currency: "USD" } },
});

let handle: DatabaseHandle;
let db: Database;
let rows: ChainRow[];
let built: EvidenceFile;
let parent: string;

const clone = (file: EvidenceFile): EvidenceFile => structuredClone(file);
const problemsOf = (value: unknown) => {
  const check = checkEvidence(value);
  if (!check.ok) throw new Error(check.error);
  return check.problems.map(({ seq, problem }) => [seq, problem]);
};

beforeAll(async () => {
  handle = await createTestDatabase();
  db = handle.db;
  const result = await appendEntries(db, [
    entryAt(1, "mandate.version"),
    entryAt(2),
    entryAt(3),
    entryAt(4, "approval"),
    entryAt(5),
  ]);
  if (!result.ok) throw new Error(result.rejection.detail);
  rows = await db.select().from(auditLog).orderBy(asc(auditLog.seq));
  built = await buildEvidence(db, { scope: SCOPE, seqs: [4, 1, 2, 4], exportedAt: EXPORTED_AT });
  parent = await mkdtemp(join(tmpdir(), "countersign-evidence-"));
}, SLOW);

afterAll(async () => {
  await handle.close();
  await rm(parent, { recursive: true, force: true });
});

describe("the evidence builder", () => {
  it("holds the format, export time, scope, a fresh chain verdict and the check sentence", async () => {
    const verdict = await verifyLog(db);
    if (!verdict.intact) throw new Error("the test log should be intact");
    expect(built.format).toBe(EVIDENCE_FORMAT);
    expect(built.exported_at).toBe(EXPORTED_AT);
    expect(built.scope).toEqual(SCOPE);
    expect(built.chain).toEqual({
      intact: true,
      entry_count: 5,
      head: verdict.head,
      problem_count: 0,
    });
    expect(built.check).toBe(
      "Each entry's hash can be recomputed from its fields. Entries here aren't contiguous, so compare the head with ledger verify on the live log.",
    );
    expect(built.check).toBe(EVIDENCE_CHECK);
    expect(EvidenceFileSchema.parse(built)).toEqual(built);
  });

  it("carries the chosen rows exactly as stored, once each, ascending by seq", () => {
    const expected = [1, 2, 4].map((seq) => {
      const row = rows.find((candidate) => candidate.seq === seq);
      if (!row) throw new Error(`no row ${seq}`);
      return {
        seq: row.seq,
        entry_type: row.entryType,
        ref_id: row.refId,
        at: row.at,
        payload: row.payload,
        prev_hash: row.prevHash,
        hash: row.hash,
      };
    });
    expect(built.entries).toEqual(expected);
    expect(Object.keys(built)).toEqual([
      "format",
      "exported_at",
      "scope",
      "chain",
      "entries",
      "check",
    ]);
  });

  it("refuses a seq the log doesn't hold, and an empty selection", async () => {
    await expect(
      buildEvidence(db, { scope: SCOPE, seqs: [2, 99], exportedAt: EXPORTED_AT }),
    ).rejects.toBeInstanceOf(EvidenceRowsMissingError);
    await expect(
      buildEvidence(db, { scope: SCOPE, seqs: [], exportedAt: EXPORTED_AT }),
    ).rejects.toThrow();
  });

  it("refuses an export time that isn't an ISO time with an offset", async () => {
    await expect(
      buildEvidence(db, { scope: SCOPE, seqs: [2], exportedAt: "yesterday" }),
    ).rejects.toThrow();
  });

  it(
    "records a broken chain with its problem count and the stored head",
    async () => {
      const tampered = await createTestDatabase();
      try {
        const result = await appendEntries(tampered.db, [entryAt(1), entryAt(2), entryAt(3)]);
        if (!result.ok) throw new Error(result.rejection.detail);
        await tampered.db.execute(sql`ALTER TABLE audit_log DISABLE TRIGGER audit_log_append_only`);
        await tampered.db.execute(
          sql`UPDATE audit_log SET payload = replace(payload, '1250', '9999') WHERE seq = 1`,
        );
        const file = await buildEvidence(tampered.db, {
          scope: SCOPE,
          seqs: [2],
          exportedAt: EXPORTED_AT,
        });
        expect(file.chain).toEqual({
          intact: false,
          entry_count: 3,
          head: { seq: 3, hash: result.entries[2]?.hash },
          problem_count: 1,
        });
      } finally {
        await tampered.close();
      }
    },
    SLOW,
  );

  it("leaves the log's head unchanged", async () => {
    const before = await verifyLog(db);
    await buildEvidence(db, { scope: SCOPE, seqs: [3], exportedAt: EXPORTED_AT });
    expect(await verifyLog(db)).toEqual(before);
  });
});

describe("checkEvidence", () => {
  it("passes on a built file, and on its JSON round trip", () => {
    expect(problemsOf(built)).toEqual([]);
    expect(problemsOf(JSON.parse(JSON.stringify(built)))).toEqual([]);
  });

  it("names the seq when a payload character changes", () => {
    const file = clone(built);
    const target = file.entries[1];
    if (!target) throw new Error("no entry");
    target.payload = target.payload.replace("illustrative", "illustrativf");
    expect(problemsOf(file)).toEqual([[2, "HASH_MISMATCH"]]);
  });

  it("names the seq when a hash changes", () => {
    const file = clone(built);
    const target = file.entries[2];
    if (!target) throw new Error("no entry");
    target.hash = `${target.hash.startsWith("a") ? "b" : "a"}${target.hash.slice(1)}`;
    expect(problemsOf(file)).toEqual([[4, "HASH_MISMATCH"]]);
  });

  it("names the seq when the order changes or a seq repeats", () => {
    const swapped = clone(built);
    swapped.entries.reverse();
    expect(problemsOf(swapped)).toEqual([
      [2, "SEQ_ORDER"],
      [1, "SEQ_ORDER"],
    ]);
    const repeated = clone(built);
    const first = repeated.entries[0];
    if (!first) throw new Error("no entry");
    repeated.entries.splice(1, 0, structuredClone(first));
    expect(problemsOf(repeated)).toEqual([[1, "SEQ_ORDER"]]);
  });

  it("names the seq when a seq number is rewritten", () => {
    const file = clone(built);
    const target = file.entries[1];
    if (!target) throw new Error("no entry");
    target.seq = 3;
    expect(problemsOf(file)).toEqual([[3, "HASH_MISMATCH"]]);
  });

  it("names the seq when a payload's canonical form changes, even if its value doesn't", () => {
    const file = clone(built);
    const target = file.entries[0];
    if (!target) throw new Error("no entry");
    target.payload = JSON.stringify(JSON.parse(target.payload), null, 2);
    expect(problemsOf(file)).toEqual([[1, "NOT_CANONICAL"]]);
    target.payload = "{not json";
    expect(problemsOf(file)).toEqual([[1, "NOT_CANONICAL"]]);
  });

  it.each([
    [
      "another format",
      (file: Record<string, unknown>) => (file.format = "countersign-evidence-v2"),
    ],
    ["no entries", (file: Record<string, unknown>) => (file.entries = [])],
    ["an unknown field", (file: Record<string, unknown>) => (file.extra = true)],
    ["an edited check sentence", (file: Record<string, unknown>) => (file.check = "Trust me.")],
    ["a bad export time", (file: Record<string, unknown>) => (file.exported_at = "today")],
  ])("isn't a v1 file with %s", (_name, edit) => {
    const file = clone(built) as unknown as Record<string, unknown>;
    edit(file);
    const check = checkEvidence(file);
    expect(check.ok).toBe(false);
  });
});

describe("ledger check-export", { timeout: SLOW }, () => {
  let files = 0;
  const write = async (content: unknown): Promise<string> => {
    const path = join(parent, `evidence-${++files}.json`);
    await writeFile(path, typeof content === "string" ? content : JSON.stringify(content, null, 2));
    return path;
  };

  it("exits 0 with the intact sentence and the head at export", async () => {
    const result = await runLedgerCli(["check-export", await write(built)], {});
    expect(result).toEqual({
      exitCode: EXIT_OK,
      stdout: `Evidence intact: 3 entries, each matching its hash. The log's head at export was #5 ${built.chain.head?.hash}.\n`,
      stderr: "",
    });
  });

  it("exits 1 with one line per problem", async () => {
    const file = clone(built);
    const [first, second] = file.entries;
    if (!first || !second) throw new Error("no entries");
    first.payload = first.payload.replace("1250", "1251");
    second.hash = "0".repeat(64);
    const result = await runLedgerCli(["check-export", await write(file)], {});
    expect(result.exitCode).toBe(EXIT_BROKEN);
    expect(result.stderr).toBe("");
    const lines = result.stdout.trimEnd().split("\n");
    expect(lines.map((line) => line.split(" ").slice(0, 2))).toEqual([
      ["#1", "HASH_MISMATCH"],
      ["#2", "HASH_MISMATCH"],
    ]);
  });

  it("exits 1 when the file says the log was broken at export", async () => {
    const file = clone(built);
    file.chain = { ...file.chain, intact: false, problem_count: 2 };
    const result = await runLedgerCli(["check-export", await write(file)], {});
    expect(result.exitCode).toBe(EXIT_BROKEN);
    expect(result.stdout).toBe("The audit log was broken when this was exported: 2 problems.\n");
  });

  it.each([
    ["a missing file", async () => join(parent, "nowhere.json")],
    ["a file that isn't JSON", async () => write("{not json")],
    ["a file that isn't evidence", async () => write({ format: EVIDENCE_FORMAT })],
  ])("exits 2 with one sentence for %s", async (_name, make) => {
    const result = await runLedgerCli(["check-export", await make()], {});
    expect(result.exitCode).toBe(EXIT_NO_DATABASE);
    expect(result.stdout).toBe("");
    expect(result.stderr).toMatch(/^Couldn't read [^\n]+\.\n$/);
  });

  it.each([
    ["no file", ["check-export"]],
    ["two files", ["check-export", "a.json", "b.json"]],
  ])("exits 2 with the usage line for %s", async (_name, args) => {
    const result = await runLedgerCli(args, {});
    expect(result.exitCode).toBe(EXIT_NO_DATABASE);
    expect(result.stderr).toContain(LEDGER_USAGE);
  });

  it("is named in the usage line", () => {
    expect(LEDGER_USAGE).toContain("check-export <file>");
  });

  it("checks a file as a child process", async () => {
    const path = await write(built);
    const env: Record<string, string | undefined> = { ...process.env };
    delete env.DATABASE_URL;
    const child = spawnSync(process.execPath, ["--import", "tsx", entry, "check-export", path], {
      cwd: repoRoot,
      encoding: "utf8",
      env,
    });
    expect(child.stderr).toBe("");
    expect(child.status).toBe(0);
    expect(child.stdout).toMatch(/^Evidence intact: 3 entries, each matching its hash\. /);
  });
});
