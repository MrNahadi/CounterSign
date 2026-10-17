import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type Database, openPgliteDirectory, sql } from "@countersign/db";
import { canonicalJson } from "@countersign/mandate";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  DEFAULT_TAIL_COUNT,
  EXIT_BROKEN,
  EXIT_NO_DATABASE,
  EXIT_OK,
  LEDGER_USAGE,
  runLedgerCli,
} from "../src/cli";
import {
  appendEntries,
  type ChainRow,
  type EntryInput,
  GENESIS_HASH,
  verifyLog,
} from "../src/index";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const entry = fileURLToPath(new URL("../src/ledger-main.ts", import.meta.url));
const tsxCli = join(repoRoot, "node_modules/tsx/dist/cli.mjs");

const SLOW = 60_000;
const PASSWORD = "pa55-w0rd-xyz";
const DUMMY_URL = `postgres://countersign:${PASSWORD}@127.0.0.1:1/countersign`;

// The environment with no DATABASE_URL, so a session that has one set never reaches it.
const childEnv = (extra: Record<string, string> = {}) => {
  const env: Record<string, string | undefined> = { ...process.env, ...extra };
  if (!("DATABASE_URL" in extra)) delete env.DATABASE_URL;
  return env;
};

const decision = (n: number): EntryInput => ({
  entryType: "decision",
  refId: `int_${n}`,
  at: `2026-10-17T09:00:${String(n).padStart(2, "0")}.000Z`,
  payload: { n, note: "illustrative", amount: { minor: 1250 * n, currency: "USD" } },
});

async function withDirectory<T>(dir: string, work: (db: Database) => Promise<T>): Promise<T> {
  const handle = await openPgliteDirectory(dir);
  try {
    return await work(handle.db);
  } finally {
    await handle.close();
  }
}

async function appendDecisions(dir: string, count: number): Promise<ChainRow[]> {
  return withDirectory(dir, async (db) => {
    const result = await appendEntries(
      db,
      Array.from({ length: count }, (_, index) => decision(index + 1)),
    );
    if (!result.ok) throw new Error(result.rejection.detail);
    return result.entries;
  });
}

let parent: string;
let dirs = 0;
const freshDir = () => join(parent, `pglite-${++dirs}`);

beforeAll(async () => {
  parent = await mkdtemp(join(tmpdir(), "countersign-ledger-cli-"));
});

afterAll(async () => {
  await rm(parent, { recursive: true, force: true });
});

describe("ledger verify", { timeout: SLOW }, () => {
  it("exits 0 on an empty log, with the genesis hash as its head", async () => {
    const result = await runLedgerCli(["verify", "--pglite", freshDir()], {});
    expect(result).toEqual({
      exitCode: EXIT_OK,
      stdout: `Audit log intact: 0 entries. Head #0 ${GENESIS_HASH}.\n`,
      stderr: "",
    });
  });

  it("exits 0 on an intact log and prints the entry count and head", async () => {
    const dir = freshDir();
    const entries = await appendDecisions(dir, 3);
    const result = await runLedgerCli(["--pglite", dir, "verify"], {});
    expect(result).toEqual({
      exitCode: EXIT_OK,
      stdout: `Audit log intact: 3 entries. Head #3 ${entries[2]?.hash}.\n`,
      stderr: "",
    });
  });

  it("exits 1 after a tamper and lists every problem by seq", async () => {
    const dir = freshDir();
    await appendDecisions(dir, 5);
    const verdict = await withDirectory(dir, async (db) => {
      const edited = canonicalJson({ ...(decision(2).payload as object), n: 200 });
      await db.execute(sql`ALTER TABLE audit_log DISABLE TRIGGER audit_log_append_only`);
      await db.execute(sql`UPDATE audit_log SET payload = ${edited} WHERE seq = 2`);
      await db.execute(sql`DELETE FROM audit_log WHERE seq = 4`);
      await db.execute(sql`ALTER TABLE audit_log ENABLE TRIGGER audit_log_append_only`);
      return verifyLog(db);
    });
    if (verdict.intact) throw new Error("the tamper went unnoticed");

    const result = await runLedgerCli(["verify", "--pglite", dir], {});
    expect(result.exitCode).toBe(EXIT_BROKEN);
    expect(result.stderr).toBe("");
    const [heading, ...lines] = result.stdout.trimEnd().split("\n");
    expect(heading).toBe("Audit log broken: 3 problems in 4 entries.");
    expect(lines.map((line) => line.split(" ").slice(0, 2))).toEqual([
      ["#2", "HASH_MISMATCH"],
      ["#5", "SEQ_GAP"],
      ["#5", "BROKEN_LINK"],
    ]);
    expect(lines).toEqual(
      verdict.problems.map(({ seq, problem, detail }) => `#${seq} ${problem} ${detail}`),
    );
  });

  it("says 1 problem, not 1 problems", async () => {
    const dir = freshDir();
    await appendDecisions(dir, 2);
    await withDirectory(dir, async (db) => {
      await db.execute(sql`ALTER TABLE audit_log DISABLE TRIGGER audit_log_append_only`);
      // Same value, different text: only the canonical-form check fails.
      await db.execute(sql`UPDATE audit_log SET payload = ' ' || payload WHERE seq = 1`);
      await db.execute(sql`ALTER TABLE audit_log ENABLE TRIGGER audit_log_append_only`);
    });
    const result = await runLedgerCli(["verify", "--pglite", dir], {});
    expect(result.exitCode).toBe(EXIT_BROKEN);
    const [heading, line, ...rest] = result.stdout.trimEnd().split("\n");
    expect(heading).toBe("Audit log broken: 1 problem in 2 entries.");
    expect(line).toMatch(/^#1 NOT_CANONICAL \S/);
    expect(rest).toEqual([]);
  });
});

describe("ledger tail", { timeout: SLOW }, () => {
  let dir: string;
  let entries: ChainRow[];

  beforeAll(async () => {
    dir = freshDir();
    entries = await appendDecisions(dir, 12);
  });

  const expectLine = (line: string, row: ChainRow) => {
    expect(line.split(/\s+/)).toEqual([
      `#${row.seq}`,
      row.at,
      row.entryType,
      row.refId,
      row.hash.slice(0, 12),
    ]);
  };

  it(`prints the last ${DEFAULT_TAIL_COUNT} entries by default, oldest first`, async () => {
    const result = await runLedgerCli(["tail", "--pglite", dir], {});
    expect(result.exitCode).toBe(EXIT_OK);
    expect(result.stderr).toBe("");
    const [heading, ...lines] = result.stdout.trimEnd().split("\n");
    expect(heading).toBe("Last 10 entries of 12.");
    expect(lines).toHaveLength(DEFAULT_TAIL_COUNT);
    lines.forEach((line, index) => {
      const row = entries[index + 2];
      if (row === undefined) throw new Error("missing row");
      expectLine(line, row);
    });
  });

  it("prints as many as the count asks for", async () => {
    const result = await runLedgerCli(["tail", "2", "--pglite", dir], {});
    expect(result.exitCode).toBe(EXIT_OK);
    const [heading, ...lines] = result.stdout.trimEnd().split("\n");
    expect(heading).toBe("Last 2 entries of 12.");
    expect(lines).toHaveLength(2);
    expectLine(lines[0] ?? "", entries[10] as ChainRow);
    expectLine(lines[1] ?? "", entries[11] as ChainRow);
  });

  it("shows a null ref as a dash", async () => {
    const other = freshDir();
    await withDirectory(other, async (db) => {
      const result = await appendEntries(db, [{ ...decision(1), refId: null }]);
      if (!result.ok) throw new Error(result.rejection.detail);
    });
    const result = await runLedgerCli(["tail", "--pglite", other], {});
    const [, line = ""] = result.stdout.trimEnd().split("\n");
    expect(line.split(/\s+/)[3]).toBe("-");
  });

  it("says so when the log has no entries", async () => {
    const result = await runLedgerCli(["tail", "--pglite", freshDir()], {});
    expect(result).toEqual({
      exitCode: EXIT_OK,
      stdout: "The audit log has no entries.\n",
      stderr: "",
    });
  });
});

describe("the ledger CLI on a database it can't use", { timeout: SLOW }, () => {
  it.each([["verify"], ["tail"]])(
    "%s exits 2 when the database has no audit_log table",
    async (command) => {
      const dir = freshDir();
      await withDirectory(dir, async (db) => {
        await db.execute(sql`DROP TABLE audit_log`);
      });
      const result = await runLedgerCli([command, "--pglite", dir], {});
      expect(result.exitCode).toBe(EXIT_NO_DATABASE);
      expect(result.stdout).toBe("");
      expect(result.stderr).toBe(
        `The database at ${dir} has no audit_log table. Run npm run db:migrate first.\n`,
      );
    },
  );

  it.each([
    ["verify", DUMMY_URL, PASSWORD],
    ["tail", DUMMY_URL, PASSWORD],
    ["verify", "postgres://countersign:p%40ss%2Fw0rd@127.0.0.1:1/countersign", "p@ss/w0rd"],
  ])(
    "%s exits 2 on an unreachable DATABASE_URL and never shows it or its password",
    async (command, url, password) => {
      const result = await runLedgerCli([command, "--pglite", freshDir()], { DATABASE_URL: url });
      expect(result.exitCode).toBe(EXIT_NO_DATABASE);
      expect(result.stdout).toBe("");
      expect(result.stderr).toMatch(/^Couldn't open the database at DATABASE_URL: .+\n$/);
      for (const output of [result.stdout, result.stderr]) {
        expect(output).not.toContain(url);
        expect(output).not.toContain(password);
        expect(output).not.toContain(encodeURIComponent(password));
        expect(output).not.toContain("postgres://");
      }
    },
  );
});

describe("the ledger CLI's arguments", () => {
  it.each([
    ["no command", []],
    ["an unknown command", ["show"]],
    ["verify with an extra argument", ["verify", "now"]],
    ["a count of zero", ["tail", "0"]],
    ["a count that isn't a number", ["tail", "ten"]],
    ["a fractional count", ["tail", "2.5"]],
    ["two counts", ["tail", "2", "3"]],
    ["--pglite with no directory", ["verify", "--pglite"]],
    ["an unknown option", ["verify", "--json"]],
  ])("exits 2 with a one-line usage error for %s", async (_name, args) => {
    const result = await runLedgerCli(args, {});
    expect(result.exitCode).toBe(EXIT_NO_DATABASE);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(LEDGER_USAGE);
    expect(result.stderr.trimEnd()).not.toContain("\n");
  });
});

describe("the ledger entry point", { timeout: SLOW }, () => {
  it("is what the root ledger script runs, with env loaded from .env.local if it exists", async () => {
    const pkg = JSON.parse(await readFile(join(repoRoot, "package.json"), "utf8"));
    expect(pkg.scripts.ledger).toBe(
      "tsx --env-file-if-exists=.env.local packages/ledger/src/ledger-main.ts",
    );
  });

  it("verifies a PGlite directory as a child process", async () => {
    const dir = freshDir();
    const entries = await appendDecisions(dir, 2);
    const child = spawnSync(
      process.execPath,
      ["--import", "tsx", entry, "verify", "--pglite", dir],
      {
        cwd: repoRoot,
        encoding: "utf8",
        env: childEnv(),
      },
    );
    expect(child.stderr).toBe("");
    expect(child.status).toBe(0);
    expect(child.stdout).toBe(`Audit log intact: 2 entries. Head #2 ${entries[1]?.hash}.\n`);
  });

  it("runs under tsx with the script's env-file flag when there's no .env.local", async () => {
    const cwd = await mkdtemp(join(parent, "no-env-"));
    const child = spawnSync(
      process.execPath,
      [tsxCli, "--env-file-if-exists=.env.local", entry, "tail", "--pglite", freshDir()],
      { cwd, encoding: "utf8", env: childEnv() },
    );
    // Node's own notice for the missing file is all that reaches stderr.
    for (const line of child.stderr.split("\n").filter(Boolean)) {
      expect(line).toBe(".env.local not found. Continuing without it.");
    }
    expect(child.status).toBe(0);
    expect(child.stdout).toBe("The audit log has no entries.\n");
  });

  it("exits 2 on an unreachable DATABASE_URL as a child process, with no secret or stack trace", () => {
    const child = spawnSync(process.execPath, ["--import", "tsx", entry, "verify"], {
      cwd: repoRoot,
      encoding: "utf8",
      env: childEnv({ DATABASE_URL: DUMMY_URL }),
    });
    expect(child.status).toBe(2);
    expect(child.stdout).toBe("");
    expect(child.stderr).toMatch(/^Couldn't open the database at DATABASE_URL: [^\n]+\n$/);
    for (const output of [child.stdout, child.stderr]) {
      expect(output).not.toContain(DUMMY_URL);
      expect(output).not.toContain(PASSWORD);
    }
  });
});

describe("the local database folder", () => {
  it("is ignored by git", async () => {
    const ignored = (await readFile(join(repoRoot, ".gitignore"), "utf8")).split("\n");
    expect(ignored).toContain(".countersign/");
  });
});
