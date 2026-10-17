import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { openPgliteDirectory, seedOrders } from "@countersign/db";
import type { FetchLike } from "@countersign/rail-paypal";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEMO_ORDERS } from "../src/seed-catalog";
import {
  EXIT_CANT_RUN,
  EXIT_OK,
  EXIT_PARTIAL,
  formatPlan,
  runSeedCli,
  SEED_USAGE,
  type SeedCliOptions,
} from "../src/seed-cli";
import {
  BUYER_A_EMAIL,
  FAKE_VAULT_A,
  FAKE_VAULT_B,
  fakeSandbox,
  paypalError,
  sandboxEnv,
} from "./fake-sandbox";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const entry = fileURLToPath(new URL("../src/seed-main.ts", import.meta.url));

const SLOW = 90_000;
const SEEDED_AT = "2026-10-17T09:30:00.000Z";
const PASSWORD = "pa55-w0rd-xyz";
const DUMMY_URL = `postgres://countersign:${PASSWORD}@127.0.0.1:1/countersign`;
const COMPLETE_TOTALS = "16 delivered, 6 in transit, 4 stalled, 4 lost";

const seedEnv = {
  ...sandboxEnv,
  PAYPAL_SEED_VAULT_TOKEN: FAKE_VAULT_A,
  PAYPAL_SEED_VAULT_TOKEN_B: FAKE_VAULT_B,
};
const SECRETS = [sandboxEnv.PAYPAL_CLIENT_SECRET, FAKE_VAULT_A, FAKE_VAULT_B, "FAKE-ACCESS-TOKEN"];

const expectNoSecrets = (result: { stdout: string; stderr: string }) => {
  for (const output of [result.stdout, result.stderr]) {
    for (const secret of SECRETS) expect(output).not.toContain(secret);
  }
};

const options = (sandbox: ReturnType<typeof fakeSandbox>): SeedCliOptions => ({
  fetch: sandbox.fetch,
  sleep: async () => {},
  clock: () => SEEDED_AT,
});

// A fetch that fails the test if anything calls it.
const calls: string[] = [];
const noCalls: FetchLike = async (url) => {
  calls.push(url);
  throw new Error("no call expected");
};

// The environment with no DATABASE_URL or PayPal variables, so a session's own never reach it.
const childEnv = () => {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const name of Object.keys(env)) {
    if (name === "DATABASE_URL" || name.startsWith("PAYPAL_")) delete env[name];
  }
  return env;
};

let parent: string;
let dirs = 0;
const freshDir = () => join(parent, `pglite-${++dirs}`);

beforeAll(async () => {
  parent = await mkdtemp(join(tmpdir(), "countersign-seed-cli-"));
});

afterAll(async () => {
  await rm(parent, { recursive: true, force: true });
});

describe("npm run seed", { timeout: SLOW }, () => {
  it("seeds all 30 orders under a new run ID made from the date and a random suffix", async () => {
    const sandbox = fakeSandbox();
    const dir = freshDir();
    const result = await runSeedCli(["--pglite", dir], seedEnv, options(sandbox));

    expect(result.exitCode).toBe(EXIT_OK);
    expect(result.stderr).toBe("");
    const run = /^Seeded 30 of 30 orders in run (\S+): /.exec(result.stdout)?.[1] ?? "";
    expect(run).toMatch(/^20261017[a-z0-9]{6}$/);
    expect(result.stdout).toBe(`Seeded 30 of 30 orders in run ${run}: ${COMPLETE_TOTALS}.\n`);
    expect(sandbox.ordersCreated()).toBe(30);
    expectNoSecrets(result);

    const handle = await openPgliteDirectory(dir);
    try {
      const rows = await handle.db.select().from(seedOrders);
      expect(rows).toHaveLength(30);
      expect(new Set(rows.map((row) => row.runId))).toEqual(new Set([run]));
    } finally {
      await handle.close();
    }
  });

  it("uses the injected random suffix, so two runs on one day differ only there", async () => {
    const result = await runSeedCli(["--pglite", freshDir()], seedEnv, {
      ...options(fakeSandbox()),
      randomSuffix: () => "k3x9qa",
    });
    expect(result.stdout).toBe(
      `Seeded 30 of 30 orders in run 20261017k3x9qa: ${COMPLETE_TOTALS}.\n`,
    );
  });

  it("lists the failures, says how to resume, exits 1, and then resumes the same run", async () => {
    const sandbox = fakeSandbox();
    const dir = freshDir();
    sandbox.hooks.fail = (orderNumber, call) => {
      if (orderNumber === "KIK-1020" && call === "create")
        return paypalError(422, "UNPROCESSABLE_ENTITY", "dbg1020");
      if (orderNumber === "KIK-1033" && call === "track")
        return paypalError(400, "INVALID_REQUEST", "dbg1033");
      return undefined;
    };

    const partial = await runSeedCli(["--run", "retry1", "--pglite", dir], seedEnv, {
      ...options(sandbox),
    });
    expect(partial.exitCode).toBe(EXIT_PARTIAL);
    expect(partial.stderr).toBe("");
    const lines = partial.stdout.trimEnd().split("\n");
    expect(lines[0]).toBe("Seeded 28 of 30 orders in run retry1. 2 failed:");
    expect(lines[1]).toMatch(/^KIK-1020 create-order \S.*\. Debug ID dbg1020\.$/);
    expect(lines[2]).toMatch(/^KIK-1033 add-tracker \S.*\. Debug ID dbg1033\.$/);
    expect(lines[3]).toBe("Run npm run seed -- --run retry1 to retry them.");
    expect(lines).toHaveLength(4);
    expectNoSecrets(partial);

    sandbox.hooks.fail = undefined;
    const created = sandbox.ordersCreated();
    const resumed = await runSeedCli(["--run", "retry1", "--pglite", dir], seedEnv, {
      ...options(sandbox),
    });
    expect(resumed).toEqual({
      exitCode: EXIT_OK,
      stdout: `Seeded 30 of 30 orders in run retry1: ${COMPLETE_TOTALS}.\n`,
      stderr: "",
    });
    // Only KIK-1020 needed a new order; KIK-1033's create replayed PayPal's first answer.
    expect(sandbox.ordersCreated() - created).toBe(1);
  });

  it("exits 1 when buyers A and B are the same PayPal account", async () => {
    const sandbox = fakeSandbox({
      emails: { [FAKE_VAULT_A]: BUYER_A_EMAIL, [FAKE_VAULT_B]: BUYER_A_EMAIL },
    });
    const result = await runSeedCli(
      ["--run", "same1", "--pglite", freshDir()],
      seedEnv,
      options(sandbox),
    );
    expect(result.exitCode).toBe(EXIT_PARTIAL);
    const [problem, summary] = result.stdout.split("\n");
    expect(problem).toBe(
      "Buyers A and B are the same PayPal account. Vault a second sandbox buyer for PAYPAL_SEED_VAULT_TOKEN_B.",
    );
    expect(summary).toMatch(/^Seeded \d+ of 30 orders in run same1\.$/);
    expect(result.stdout).not.toContain("to retry them");
    expectNoSecrets(result);
  });
});

describe("npm run seed -- --dry-run", () => {
  it("prints one line per order and the totals, with no variables, no call and no database", async () => {
    calls.length = 0;
    const result = await runSeedCli(["--dry-run"], { DATABASE_URL: DUMMY_URL }, { fetch: noCalls });
    expect(result.exitCode).toBe(EXIT_OK);
    expect(result.stderr).toBe("");
    expect(calls).toEqual([]);
    expect(result.stdout).toBe(formatPlan());

    const [heading, ...rest] = result.stdout.trimEnd().split("\n");
    expect(heading).toBe("Dry run: the seed would create 30 orders. Nothing is sent or written.");
    expect(rest.at(-1)).toBe(`Totals: ${COMPLETE_TOTALS}.`);
    const lines = rest.slice(0, -1);
    expect(lines).toHaveLength(30);
    expect(lines[0]?.split(/\s{2,}/)).toEqual([
      "KIK-1013",
      "Market basket",
      "$48.00",
      "A",
      "delivered",
      "filler",
    ]);
    expect(lines[22]?.split(/\s{2,}/)).toEqual([
      "KIK-1035",
      "Coaster set",
      "$18.00",
      "A",
      "stalled",
      "beat_4",
    ]);
    expect(lines.map((line) => line.slice(0, 8))).toEqual(
      DEMO_ORDERS.map((demo) => demo.orderNumber).sort(),
    );
  });
});

describe("npm run seed -- list", { timeout: SLOW }, () => {
  it("says so when nothing is seeded, needing no PayPal variables", async () => {
    const result = await runSeedCli(["list", "--pglite", freshDir()], {});
    expect(result).toEqual({ exitCode: EXIT_OK, stdout: "No seeded orders yet.\n", stderr: "" });
  });

  it("prints every seeded row with the carrier's status", async () => {
    const dir = freshDir();
    const seeded = await runSeedCli(
      ["--run", "list1", "--pglite", dir],
      seedEnv,
      options(fakeSandbox()),
    );
    expect(seeded.exitCode).toBe(EXIT_OK);

    const result = await runSeedCli(["list", "--pglite", dir], {});
    expect(result.exitCode).toBe(EXIT_OK);
    expect(result.stderr).toBe("");
    const [heading, ...lines] = result.stdout.trimEnd().split("\n");
    expect(heading).toBe("30 seeded orders.");
    expect(lines).toHaveLength(30);

    const handle = await openPgliteDirectory(dir);
    const rows = await handle.db.select().from(seedOrders);
    await handle.close();
    const words = {
      delivered: "delivered",
      in_transit: "in transit",
      stalled_10d: "stalled",
      lost: "lost",
    };
    for (const demo of DEMO_ORDERS) {
      const row = rows.find((r) => r.orderNumber === demo.orderNumber);
      if (!row) throw new Error(`no row for ${demo.orderNumber}`);
      const line = lines.find((l) => l.startsWith(demo.orderNumber)) ?? "";
      expect(line.split(/\s{2,}/)).toEqual([
        row.orderNumber,
        row.paypalOrderId,
        row.paypalCaptureId,
        `$${(row.amountMinor / 100).toFixed(2)}`,
        row.payerEmail,
        row.trackingNumber,
        words[demo.status],
      ]);
    }
  });
});

describe("the seed CLI when it can't run", { timeout: SLOW }, () => {
  it("exits 2 naming every missing PayPal and vault variable, with no call made", async () => {
    calls.length = 0;
    const result = await runSeedCli(["--pglite", freshDir()], {}, { fetch: noCalls });
    expect(result.exitCode).toBe(EXIT_CANT_RUN);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe(
      "The seed can't start. Set PAYPAL_BASE_URL, PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET, PAYPAL_SEED_VAULT_TOKEN, PAYPAL_SEED_VAULT_TOKEN_B in .env.local.\n",
    );
    expect(calls).toEqual([]);
  });

  it.each([
    ["buyer B's vault token", { PAYPAL_SEED_VAULT_TOKEN_B: "" }, "PAYPAL_SEED_VAULT_TOKEN_B"],
    ["buyer A's vault token", { PAYPAL_SEED_VAULT_TOKEN: undefined }, "PAYPAL_SEED_VAULT_TOKEN"],
    ["the client secret", { PAYPAL_CLIENT_SECRET: "" }, "PAYPAL_CLIENT_SECRET"],
  ])("exits 2 without %s, naming only it", async (_name, change, missing) => {
    const result = await runSeedCli(["--pglite", freshDir()], { ...seedEnv, ...change });
    expect(result.exitCode).toBe(EXIT_CANT_RUN);
    expect(result.stderr).toBe(`The seed can't start. Set ${missing} in .env.local.\n`);
    expectNoSecrets(result);
  });

  it("exits 2 on a base URL that isn't the sandbox's", async () => {
    const result = await runSeedCli([], {
      ...seedEnv,
      PAYPAL_BASE_URL: "https://api-m.paypal.com",
    });
    expect(result.exitCode).toBe(EXIT_CANT_RUN);
    expect(result.stderr).toBe(
      "The seed can't start. PAYPAL_BASE_URL must be https://api-m.sandbox.paypal.com. Only the PayPal sandbox is allowed.\n",
    );
  });

  it.each([
    ["seed", ["--run", "unreach1"]],
    ["list", ["list"]],
  ])(
    "%s exits 2 on an unreachable DATABASE_URL and never shows it or its password",
    async (_name, args) => {
      const result = await runSeedCli(
        [...args, "--pglite", freshDir()],
        { ...seedEnv, DATABASE_URL: DUMMY_URL },
        { fetch: noCalls, sleep: async () => {}, clock: () => SEEDED_AT },
      );
      expect(result.exitCode).toBe(EXIT_CANT_RUN);
      expect(result.stdout).toBe("");
      expect(result.stderr).toMatch(/^Couldn't open the database at DATABASE_URL: [^\n]+\n$/);
      for (const output of [result.stdout, result.stderr]) {
        expect(output).not.toContain(DUMMY_URL);
        expect(output).not.toContain(PASSWORD);
        expect(output).not.toContain("postgres://");
      }
      expectNoSecrets(result);
    },
  );
});

describe("the seed CLI's arguments", () => {
  it.each([
    ["a run ID that's too short", ["--run", "abc"]],
    ["a run ID that's too long", ["--run", "a".repeat(25)]],
    ["a run ID with capitals", ["--run", "RunOne"]],
    ["a run ID with a hyphen", ["--run", "run-1"]],
    ["--run with no value", ["--run"]],
    ["--run followed by another option", ["--run", "--dry-run"]],
  ])("exits 2 with the run ID rule for %s", async (_name, args) => {
    const result = await runSeedCli(args, seedEnv, { fetch: noCalls });
    expect(result.exitCode).toBe(EXIT_CANT_RUN);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("The run ID must be 4 to 24 lowercase letters and digits.");
    expect(result.stderr).toContain(SEED_USAGE);
    expect(result.stderr.trimEnd()).not.toContain("\n");
  });

  it.each([
    ["an unknown option", ["--json"], "Unknown option --json."],
    ["an unknown command", ["show"], "Unknown command show."],
    ["two commands", ["list", "list"], "Give one command at most."],
    ["--run twice", ["--run", "abcd", "--run", "efgh"], "--run is given twice."],
    ["--dry-run twice", ["--dry-run", "--dry-run"], "--dry-run is given twice."],
    ["list with --run", ["list", "--run", "abcd"], "list takes only --pglite."],
    ["list with --dry-run", ["list", "--dry-run"], "list takes only --pglite."],
    ["--dry-run with --run", ["--dry-run", "--run", "abcd"], "--dry-run takes no other options."],
    [
      "--dry-run with --pglite",
      ["--dry-run", "--pglite", "x"],
      "--dry-run takes no other options.",
    ],
    ["--pglite with no directory", ["--pglite"], "--pglite needs a directory."],
  ])("exits 2 with a one-line usage error for %s", async (_name, args, message) => {
    const result = await runSeedCli(args, seedEnv, { fetch: noCalls });
    expect(result.exitCode).toBe(EXIT_CANT_RUN);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe(`${message} ${SEED_USAGE}\n`);
  });

  it.each([
    ["4", "abcd"],
    ["24", "a1".repeat(12)],
  ])("accepts a %s-character run ID and goes on to check the variables", async (_n, run) => {
    const result = await runSeedCli(["--run", run], {});
    expect(result.exitCode).toBe(EXIT_CANT_RUN);
    expect(result.stderr).toMatch(/^The seed can't start\. Set PAYPAL_BASE_URL/);
  });
});

describe("the seed entry point", { timeout: SLOW }, () => {
  it("is what the root seed script runs, with env loaded from .env.local if it exists", async () => {
    const pkg = JSON.parse(await readFile(join(repoRoot, "package.json"), "utf8"));
    expect(pkg.scripts.seed).toBe(
      "tsx --env-file-if-exists=.env.local apps/storefront/src/seed-main.ts",
    );
  });

  it("prints the plan as a child process with no variables set", () => {
    const child = spawnSync(process.execPath, ["--import", "tsx", entry, "--dry-run"], {
      cwd: repoRoot,
      encoding: "utf8",
      env: childEnv(),
    });
    expect(child.stderr).toBe("");
    expect(child.status).toBe(0);
    expect(child.stdout).toBe(formatPlan());
  });

  it("exits 2 naming the missing variables as a child process, with no stack trace", () => {
    const child = spawnSync(process.execPath, ["--import", "tsx", entry, "--run", "child1"], {
      cwd: repoRoot,
      encoding: "utf8",
      env: childEnv(),
    });
    expect(child.status).toBe(2);
    expect(child.stdout).toBe("");
    expect(child.stderr).toBe(
      "The seed can't start. Set PAYPAL_BASE_URL, PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET, PAYPAL_SEED_VAULT_TOKEN, PAYPAL_SEED_VAULT_TOKEN_B in .env.local.\n",
    );
  });
});
