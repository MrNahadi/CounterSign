import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runLedgerCli } from "@countersign/ledger";
import { describe, expect, it } from "vitest";
import {
  EXIT_BAD_INPUT,
  EXIT_DECIDED,
  RECORD_USAGE,
  runDecide,
  runDecideCli,
} from "../src/decide-cli";
import { trackedTempDirs } from "./temp-dirs";

const casesDir = fileURLToPath(new URL("../fixtures/cases/", import.meta.url));
const beat3 = join(casesDir, "beat-3-attack-email.json");
const entry = fileURLToPath(new URL("../src/decide-main.ts", import.meta.url));
const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));

// Each PGlite start takes a couple of seconds.
const SLOW = 60_000;
const HASH = "[0-9a-f]{64}";

const makeDir = trackedTempDirs();
function tempDir(): string {
  return makeDir("decide-record-");
}

const verify = (dir: string) => runLedgerCli(["verify", "--pglite", dir], {});

describe("decide --record", () => {
  it(
    "prints phase 3's output, records every proposal, and leaves the log intact",
    async () => {
      const dir = tempDir();
      const result = await runDecide([beat3, "--record", "--pglite", dir], {});
      const plain = runDecideCli([beat3]);

      expect(result.exitCode).toBe(EXIT_DECIDED);
      expect(result.stderr).toBe("");
      expect(result.stdout.startsWith(`${plain.stdout}\n`)).toBe(true);
      const summary = result.stdout.slice(plain.stdout.length + 1);
      expect(summary).toMatch(new RegExp(`^Recorded 6 entries\\. Head #6 (${HASH})\\.\n$`));

      const checked = await verify(dir);
      expect(checked.exitCode).toBe(0);
      const head = /Head #6 (\w+)\.\n$/.exec(summary ?? "")?.[1];
      expect(checked.stdout).toBe(`Audit log intact: 6 entries. Head #6 ${head}.\n`);
    },
    SLOW,
  );

  it(
    "records the mandate once: a second run adds the 5 decisions only",
    async () => {
      const dir = tempDir();
      await runDecide([beat3, "--record", "--pglite", dir], {});
      const again = await runDecide([beat3, "--record", "--pglite", dir], {});
      expect(again.stdout).toMatch(/\nRecorded 5 entries\. Head #11 \w{64}\.\n$/);
      expect((await verify(dir)).stdout).toMatch(/^Audit log intact: 11 entries\. Head #11 /);
    },
    SLOW,
  );

  it(
    "keeps stdout valid JSON with --json and sends the summary to stderr",
    async () => {
      const dir = tempDir();
      const result = await runDecide(["--json", beat3, "--record", "--pglite", dir], {});
      expect(result.exitCode).toBe(EXIT_DECIDED);
      expect(result.stdout).toBe(runDecideCli(["--json", beat3]).stdout);
      expect(JSON.parse(result.stdout)).toHaveLength(5);
      expect(result.stderr).toMatch(new RegExp(`^Recorded 6 entries\\. Head #6 ${HASH}\\.\n$`));
      expect((await verify(dir)).exitCode).toBe(0);
    },
    SLOW,
  );

  it(
    "exits 2 on a mandate version logged with a different hash, and records nothing from the case",
    async () => {
      const dir = tempDir();
      await runDecide([beat3, "--record", "--pglite", dir], {});
      const before = (await verify(dir)).stdout;

      // The same mandate ID and version, changed: a daily limit raised.
      const caseFile = JSON.parse(readFileSync(beat3, "utf8"));
      const mandate = JSON.parse(readFileSync(join(casesDir, caseFile.mandate), "utf8"));
      mandate.limits[0].per_day_count += 1;
      const folder = tempDir();
      writeFileSync(join(folder, "mandate.json"), JSON.stringify(mandate));
      writeFileSync(
        join(folder, "case.json"),
        JSON.stringify({ ...caseFile, mandate: "mandate.json" }),
      );

      const result = await runDecide([join(folder, "case.json"), "--record", "--pglite", dir], {});
      expect(result.exitCode).toBe(EXIT_BAD_INPUT);
      expect(result.stdout).toBe("");
      expect(result.stderr).toMatch(/^[^\n]*MANDATE_VERSION_CONFLICT[^\n]*\n$/);
      expect(result.stderr).toContain("Nothing was recorded.");
      expect((await verify(dir)).stdout).toBe(before);
    },
    SLOW,
  );

  it("refuses --pglite without a directory", async () => {
    const result = await runDecide([beat3, "--record", "--pglite"], {});
    expect(result.exitCode).toBe(EXIT_BAD_INPUT);
    expect(result.stderr).toBe(`--pglite needs a directory. ${RECORD_USAGE}\n`);
  });

  it(
    "never prints DATABASE_URL when it can't connect",
    async () => {
      const url = "postgres://user:s3cr3t-pw@127.0.0.1:1/countersign";
      const result = await runDecide([beat3, "--record"], { DATABASE_URL: url });
      expect(result.exitCode).toBe(EXIT_BAD_INPUT);
      expect(result.stdout).toBe("");
      expect(result.stderr).toMatch(/^Couldn't open the database at DATABASE_URL: /);
      expect(result.stderr).not.toContain("s3cr3t-pw");
      expect(result.stderr).not.toContain(url);
    },
    SLOW,
  );

  it(
    "runs as a child process the way npm run decide does",
    () => {
      const dir = tempDir();
      const run = spawnSync(
        process.execPath,
        ["--import", "tsx", entry, beat3, "--record", "--pglite", dir],
        { cwd: repoRoot, encoding: "utf8", env: { ...process.env, DATABASE_URL: "" } },
      );
      expect(run.status).toBe(0);
      expect(run.stdout).toMatch(new RegExp(`\nRecorded 6 entries\\. Head #6 ${HASH}\\.\n$`));
    },
    SLOW,
  );
});
