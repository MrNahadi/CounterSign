import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FROZEN_PATHS, listCaseFiles, readGit } from "../run";

// The bench freeze (brief §4, "Freeze first"): the cases and mandates are tagged `bench-vN`, the
// tag and its commit are recorded in bench/README.md, and any later edit to those paths needs a
// new version. Simulated content only.

const ROOT = join(import.meta.dirname, "..", "..");
const CASES_DIR = join(ROOT, "bench", "cases");

function git(cwd: string, ...args: string[]): string {
  return execFileSync(
    "git",
    ["-c", "user.name=Bench Test", "-c", "user.email=bench@example.com", ...args],
    { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
  );
}

describe("readGit against a real tag", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function repo(): string {
    const dir = mkdtempSync(join(tmpdir(), "bench-freeze-"));
    dirs.push(dir);
    git(dir, "init", "-q");
    mkdirSync(join(dir, "bench", "cases", "attack"), { recursive: true });
    mkdirSync(join(dir, "packages", "mandate", "fixtures"), { recursive: true });
    writeFileSync(join(dir, "bench", "cases", "attack", "a1-01.json"), '{"id":"a1-01"}\n');
    writeFileSync(join(dir, "packages", "mandate", "fixtures", "m-v3.json"), '{"version":3}\n');
    writeFileSync(join(dir, "notes.md"), "notes\n");
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "cases");
    return dir;
  }

  it("has no case-set tag before the first freeze", () => {
    const dir = repo();
    expect(readGit(dir)).toMatchObject({ caseSetTag: null, unchangedSinceTag: false });
  });

  it("names the tag and reports the frozen paths unchanged right after tagging", () => {
    const dir = repo();
    git(dir, "tag", "-a", "bench-v1", "-m", "bench v1");
    const info = readGit(dir);
    expect(info).toMatchObject({ caseSetTag: "bench-v1", unchangedSinceTag: true, dirty: false });
    expect(info.sha).toBe(git(dir, "rev-parse", "HEAD").trim());
  });

  it("stays unchanged when only files outside the frozen paths change", () => {
    const dir = repo();
    git(dir, "tag", "-a", "bench-v1", "-m", "bench v1");
    writeFileSync(join(dir, "notes.md"), "recorded the freeze\n");
    git(dir, "commit", "-q", "-am", "readme");
    expect(readGit(dir)).toMatchObject({ caseSetTag: "bench-v1", unchangedSinceTag: true });
  });

  it("reports a changed case, committed or not", () => {
    const dir = repo();
    git(dir, "tag", "-a", "bench-v1", "-m", "bench v1");
    writeFileSync(join(dir, "bench", "cases", "attack", "a1-01.json"), '{"id":"a1-01b"}\n');
    expect(readGit(dir)).toMatchObject({ unchangedSinceTag: false, dirty: true });
    git(dir, "commit", "-q", "-am", "edit a case");
    expect(readGit(dir)).toMatchObject({ caseSetTag: "bench-v1", unchangedSinceTag: false });
  });

  it("reports a new untracked case and an edited mandate", () => {
    const dir = repo();
    git(dir, "tag", "-a", "bench-v1", "-m", "bench v1");
    writeFileSync(join(dir, "bench", "cases", "attack", "a1-02.json"), '{"id":"a1-02"}\n');
    expect(readGit(dir).unchangedSinceTag).toBe(false);
    rmSync(join(dir, "bench", "cases", "attack", "a1-02.json"));
    writeFileSync(join(dir, "packages", "mandate", "fixtures", "m-v3.json"), '{"version":4}\n');
    expect(readGit(dir).unchangedSinceTag).toBe(false);
  });

  it("moves to bench-v2 once the edit is tagged", () => {
    const dir = repo();
    git(dir, "tag", "-a", "bench-v1", "-m", "bench v1");
    writeFileSync(join(dir, "bench", "cases", "attack", "a1-01.json"), '{"id":"a1-01b"}\n');
    git(dir, "commit", "-q", "-am", "edit a case");
    git(dir, "tag", "-a", "bench-v2", "-m", "bench v2");
    expect(readGit(dir)).toMatchObject({ caseSetTag: "bench-v2", unchangedSinceTag: true });
  });
});

type FreezeRow = {
  tag: string;
  sha: string;
  date: string;
  attack: number;
  genuine: number;
  holdout: number;
};

/** The rows of bench/README.md's freeze table, oldest first. */
function freezeRows(readme: string): FreezeRow[] {
  const row =
    /^\| `(bench-v\d+)` \| `([0-9a-f]{40})` \| (\d{4}-\d{2}-\d{2}) \| (\d+) attack, (\d+) genuine, (\d+) hold-out \|$/gm;
  return [...readme.matchAll(row)].map((m) => ({
    tag: m[1] as string,
    sha: m[2] as string,
    date: m[3] as string,
    attack: Number(m[4]),
    genuine: Number(m[5]),
    holdout: Number(m[6]),
  }));
}

describe("the recorded freeze in bench/README.md", () => {
  const rows = freezeRows(readFileSync(join(ROOT, "bench", "README.md"), "utf8"));
  const latest = rows.at(-1);

  it("records bench-v1 first and numbers later versions in order", () => {
    expect(rows.length).toBeGreaterThan(0);
    rows.forEach((row, i) => {
      expect(row.tag).toBe(`bench-v${i + 1}`);
    });
  });

  it("records the commit its tag points at", () => {
    for (const row of rows) {
      expect(git(ROOT, "rev-parse", `${row.tag}^{commit}`).trim()).toBe(row.sha);
    }
  });

  it("is the latest case-set tag a bench run would record", () => {
    expect(readGit(ROOT).caseSetTag).toBe(latest?.tag);
  });

  it("matches the cases and mandates as they are now, so any edit needs a new version", () => {
    if (latest === undefined) throw new Error("No freeze recorded in bench/README.md.");
    const changed = git(ROOT, "diff", "--name-only", latest.sha, "--", ...FROZEN_PATHS).trim();
    const untracked = git(
      ROOT,
      "ls-files",
      "--others",
      "--exclude-standard",
      "--",
      ...FROZEN_PATHS,
    ).trim();
    expect(changed).toBe("");
    expect(untracked).toBe("");
  });

  it("counts the cases the latest version holds", () => {
    expect({
      attack: listCaseFiles(CASES_DIR, "attack/**").length,
      genuine: listCaseFiles(CASES_DIR, "genuine/**").length,
      holdout: listCaseFiles(CASES_DIR, "holdout/**").length,
    }).toEqual({ attack: latest?.attack, genuine: latest?.genuine, holdout: latest?.holdout });
  });
});
