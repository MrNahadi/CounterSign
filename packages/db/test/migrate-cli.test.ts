import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  DEFAULT_PGLITE_DIR,
  hasAuditLogTable,
  openPgliteDirectory,
  redactSecrets,
  resolveDatabaseTarget,
  takePgliteOption,
} from "../src/index";
import {
  EXIT_MIGRATE_FAILED,
  EXIT_MIGRATED,
  MIGRATE_USAGE,
  runMigrateCli,
} from "../src/migrate-cli";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const entry = fileURLToPath(new URL("../src/migrate-main.ts", import.meta.url));
const journal = fileURLToPath(new URL("../drizzle/meta/_journal.json", import.meta.url));

const SLOW = 60_000;
const PASSWORD = "pa55-w0rd-xyz";
const DUMMY_URL = `postgres://countersign:${PASSWORD}@127.0.0.1:1/countersign`;

let parent: string;
let dirs = 0;
const freshDir = () => join(parent, `pglite-${++dirs}`);

beforeAll(async () => {
  parent = await mkdtemp(join(tmpdir(), "countersign-migrate-"));
});

afterAll(async () => {
  await rm(parent, { recursive: true, force: true });
});

describe("which database the CLIs open", () => {
  it("is .countersign/pglite from the repo root when nothing else is named", () => {
    expect(DEFAULT_PGLITE_DIR).toBe(join(repoRoot, ".countersign", "pglite"));
    expect(resolveDatabaseTarget({}, undefined)).toEqual({
      kind: "pglite",
      dir: DEFAULT_PGLITE_DIR,
    });
  });

  it("is the --pglite directory, resolved from the working directory", () => {
    expect(resolveDatabaseTarget({}, "data/local")).toEqual({
      kind: "pglite",
      dir: resolve("data/local"),
    });
  });

  it("is DATABASE_URL whenever it's set, ahead of --pglite", () => {
    expect(resolveDatabaseTarget({ DATABASE_URL: DUMMY_URL }, "data/local")).toEqual({
      kind: "postgres",
      url: DUMMY_URL,
    });
  });

  it("treats an empty DATABASE_URL as unset", () => {
    expect(resolveDatabaseTarget({ DATABASE_URL: " " }, undefined).kind).toBe("pglite");
  });

  it("takes --pglite <dir> out of the arguments, and refuses it without a directory", () => {
    expect(takePgliteOption(["verify", "--pglite", "d", "x"])).toEqual({
      ok: true,
      pgliteDir: "d",
      rest: ["verify", "x"],
    });
    expect(takePgliteOption(["--pglite"]).ok).toBe(false);
    expect(takePgliteOption(["--pglite", "--json"]).ok).toBe(false);
    expect(takePgliteOption(["--pglite", "a", "--pglite", "b"]).ok).toBe(false);
  });

  it("never shows the connection string or its password, as written or decoded", () => {
    const url = "postgres://user:p%40ss%2Fw0rd@db.example:5432/countersign";
    const target = { kind: "postgres", url } as const;
    const text = redactSecrets(`failed for ${url}; password p%40ss%2Fw0rd or p@ss/w0rd`, target);
    expect(text).not.toContain(url);
    expect(text).not.toContain("p%40ss%2Fw0rd");
    expect(text).not.toContain("p@ss/w0rd");
    expect(redactSecrets("see postgres://other:secret@host/db", target)).not.toContain("secret");
  });
});

describe("db:migrate", { timeout: SLOW }, () => {
  it("applies every migration to a fresh PGlite directory, then none the second time", async () => {
    const { entries } = JSON.parse(await readFile(journal, "utf8")) as { entries: unknown[] };
    const dir = freshDir();
    const noun = entries.length === 1 ? "migration" : "migrations";
    expect(await runMigrateCli(["--pglite", dir], {})).toEqual({
      exitCode: EXIT_MIGRATED,
      stdout: `Applied ${entries.length} ${noun}.\n`,
      stderr: "",
    });
    expect(await runMigrateCli(["--pglite", dir], {})).toEqual({
      exitCode: EXIT_MIGRATED,
      stdout: "Applied 0 migrations.\n",
      stderr: "",
    });
    const handle = await openPgliteDirectory(dir);
    expect(await hasAuditLogTable(handle.db)).toBe(true);
    await handle.close();
  });

  it("exits 2 on an unreachable DATABASE_URL and never shows it or its password", async () => {
    const result = await runMigrateCli([], { DATABASE_URL: DUMMY_URL });
    expect(result.exitCode).toBe(EXIT_MIGRATE_FAILED);
    expect(result.stdout).toBe("");
    expect(result.stderr).toMatch(/^Couldn't open the database at DATABASE_URL: [^\n]+\n$/);
    expect(result.stderr).toContain("ECONNREFUSED");
    expect(result.stderr).not.toContain(DUMMY_URL);
    expect(result.stderr).not.toContain(PASSWORD);
  });

  it.each([
    ["an unknown option", ["--json"]],
    ["an extra argument", ["now"]],
    ["--pglite with no directory", ["--pglite"]],
  ])("exits 2 with a one-line usage error for %s", async (_name, args) => {
    const result = await runMigrateCli(args, {});
    expect(result.exitCode).toBe(EXIT_MIGRATE_FAILED);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(MIGRATE_USAGE);
    expect(result.stderr.trimEnd()).not.toContain("\n");
  });
});

describe("the db:migrate entry point", { timeout: SLOW }, () => {
  const env = () => {
    const copy: Record<string, string | undefined> = { ...process.env };
    delete copy.DATABASE_URL;
    return copy;
  };

  it("is what the root db:migrate script runs, with env loaded from .env.local if it exists", async () => {
    const pkg = JSON.parse(await readFile(join(repoRoot, "package.json"), "utf8"));
    expect(pkg.scripts["db:migrate"]).toBe(
      "tsx --env-file-if-exists=.env.local packages/db/src/migrate-main.ts",
    );
  });

  it("migrates a PGlite directory as a child process", () => {
    const child = spawnSync(process.execPath, ["--import", "tsx", entry, "--pglite", freshDir()], {
      cwd: repoRoot,
      encoding: "utf8",
      env: env(),
    });
    expect(child.stderr).toBe("");
    expect(child.status).toBe(0);
    expect(child.stdout).toMatch(/^Applied [1-9]\d* migrations?\.\n$/);
  });
});
