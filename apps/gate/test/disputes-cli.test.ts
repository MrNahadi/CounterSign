import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { asc, auditLog, openPgliteDirectory } from "@countersign/db";
import { appendEntries } from "@countersign/ledger";
import { SANDBOX_BASE_URL } from "@countersign/rail-paypal";
import { describe, expect, it } from "vitest";
import { DisputeReceivedPayloadSchema, disputeReceivedEntry } from "../src/dispute-log";
import {
  DISPUTES_USAGE,
  EXIT_CANT_RUN,
  EXIT_NEGATIVE,
  EXIT_OK,
  runDisputes,
} from "../src/disputes-cli";
import type { NudgeFetch } from "../src/nudge";
import {
  createFakeSandbox,
  type DisputeDetailSeed,
  type FakeSandbox,
  httpError,
} from "./fake-sandbox";
import { trackedTempDirs } from "./temp-dirs";

// Each PGlite start takes a couple of seconds.
const SLOW = 60_000;
const NOW = new Date("2026-10-20T12:00:00.000Z");
const SECRET = "fake-client-secret-not-real";
const ENV = {
  PAYPAL_BASE_URL: SANDBOX_BASE_URL,
  PAYPAL_CLIENT_ID: "fake-client-id",
  PAYPAL_CLIENT_SECRET: SECRET,
  RESOLVE_AGENT_URL: "http://resolve.test:8788",
};
const entry = fileURLToPath(new URL("../src/disputes-main.ts", import.meta.url));
const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const usd = (minor: number) => ({ minor, currency: "USD" as const });

const makeDir = trackedTempDirs();

function seed(id: string, extra: Partial<DisputeDetailSeed> = {}): DisputeDetailSeed {
  return {
    id,
    status: "WAITING_FOR_SELLER_RESPONSE",
    amount: usd(24000),
    captureIds: [`CAP-${id}`],
    reason: "MERCHANDISE_OR_SERVICE_NOT_RECEIVED",
    sellerResponseDueDate: "2026-10-30T23:59:59.000Z",
    ...extra,
  };
}

function sandboxWith(...disputes: DisputeDetailSeed[]): FakeSandbox {
  const rail = createFakeSandbox();
  for (const dispute of disputes) {
    rail.disputeDetails.set(dispute.id, dispute);
    rail.merchantDisputes.push({ id: dispute.id, status: dispute.status });
  }
  return rail;
}

type Nudges = { fetch: NudgeFetch; sent: string[] };

function nudges(ok = true): Nudges {
  const sent: string[] = [];
  return {
    sent,
    fetch: async (url, init) => {
      sent.push(`${url} ${init.body}`);
      if (!ok) throw new Error("connect ECONNREFUSED");
      return { ok: true };
    },
  };
}

async function freshDir(...recorded: string[]): Promise<string> {
  const dir = makeDir("disputes-cli-");
  const handle = await openPgliteDirectory(dir);
  try {
    if (recorded.length > 0) {
      const written = await appendEntries(
        handle.db,
        recorded.map((id) =>
          disputeReceivedEntry({
            at: "2026-10-19T09:00:00.000Z",
            source: "poll",
            dispute: {
              reason: "MERCHANDISE_OR_SERVICE_NOT_RECEIVED",
              lifeCycleStage: "INQUIRY",
              sellerResponseDueDate: null,
              linkNames: [],
              ...seed(id),
            },
          }),
        ),
      );
      if (!written.ok) throw new Error(written.rejection.detail);
    }
  } finally {
    await handle.close();
  }
  return dir;
}

async function received(dir: string) {
  const handle = await openPgliteDirectory(dir);
  try {
    const rows = await handle.db.select().from(auditLog).orderBy(asc(auditLog.seq));
    return rows
      .filter((row) => row.entryType === "dispute.received")
      .map((row) => ({
        seq: row.seq,
        refId: row.refId,
        at: row.at,
        payload: DisputeReceivedPayloadSchema.parse(JSON.parse(row.payload)),
      }));
  } finally {
    await handle.close();
  }
}

const run = (dir: string, rail: FakeSandbox, args: string[], nudge: Nudges = nudges()) =>
  runDisputes([...args, "--pglite", dir], ENV, {
    rail,
    nudgeFetch: nudge.fetch,
    now: () => NOW,
  });

describe("disputes sync", () => {
  it(
    "records only new disputes, nudges Resolve for each, and a second run records nothing",
    async () => {
      const dir = await freshDir("PP-D-1");
      const rail = sandboxWith(seed("PP-D-1"), seed("PP-D-2"));
      const nudge = nudges();

      const first = await run(dir, rail, ["sync"], nudge);
      expect(first.exitCode).toBe(EXIT_OK);
      expect(first.stdout).toBe(
        "Already recorded PP-D-1.\nRecorded dispute PP-D-2 on capture CAP-PP-D-2 for $240.00.\n",
      );
      expect(rail.calls).toContainEqual({
        call: "listMerchantDisputes",
        arg: { pageSize: 50, disputeState: "REQUIRED_ACTION" },
      });
      // A recorded dispute isn't re-read.
      expect(rail.calls.filter((c) => c.call === "getDispute").map((c) => c.arg)).toEqual([
        "PP-D-2",
      ]);
      expect(nudge.sent).toEqual(['http://resolve.test:8788/disputes {"dispute_id":"PP-D-2"}']);
      const rows = await received(dir);
      expect(rows).toHaveLength(2);
      expect(rows[1]).toMatchObject({
        refId: "PP-D-2",
        at: NOW.toISOString(),
        payload: {
          disputeId: "PP-D-2",
          source: "poll",
          event: null,
          dispute: {
            status: "WAITING_FOR_SELLER_RESPONSE",
            amount: usd(24000),
            captureIds: ["CAP-PP-D-2"],
          },
        },
      });

      const second = await run(dir, rail, ["sync"], nudge);
      expect(second.exitCode).toBe(EXIT_OK);
      expect(second.stdout).toBe("Already recorded PP-D-1.\nAlready recorded PP-D-2.\n");
      expect(await received(dir)).toHaveLength(2);
      expect(nudge.sent).toHaveLength(1);
    },
    SLOW,
  );

  it(
    "says when PayPal had more pages, and says nothing waits on an empty page",
    async () => {
      const dir = await freshDir();
      const many = Array.from({ length: 51 }, (_, i) => seed(`PP-D-${100 + i}`));
      const rail = sandboxWith(...many);
      const result = await run(dir, rail, ["sync"]);
      expect(result.exitCode).toBe(EXIT_OK);
      expect(result.stdout.trim().split("\n")).toHaveLength(51);
      expect(result.stdout).toContain(
        "PayPal had more pages of disputes. Only the first 50 were read.",
      );
      expect(await received(dir)).toHaveLength(50);

      const empty = await run(await freshDir(), sandboxWith(), ["sync"]);
      expect(empty.exitCode).toBe(EXIT_OK);
      expect(empty.stdout).toBe("No disputes are waiting for the seller.\n");
    },
    SLOW,
  );

  it(
    "keeps the exit code when Resolve isn't reachable, and says how to draft by hand",
    async () => {
      const dir = await freshDir();
      const result = await run(dir, sandboxWith(seed("PP-D-3")), ["sync"], nudges(false));
      expect(result.exitCode).toBe(EXIT_OK);
      expect(result.stdout).toContain("Recorded dispute PP-D-3 on capture CAP-PP-D-3 for $240.00.");
      expect(result.stdout).toContain(
        "Resolve wasn't reachable; run npm run resolve -- dispute PP-D-3.",
      );
      expect(await received(dir)).toHaveLength(1);
    },
    SLOW,
  );

  it(
    "exits 1 when a dispute can't be re-read, recording the others",
    async () => {
      const dir = await freshDir();
      const rail = sandboxWith(seed("PP-D-4"));
      rail.merchantDisputes.unshift({ id: "PP-D-GONE", status: "WAITING_FOR_SELLER_RESPONSE" });
      const result = await run(dir, rail, ["sync"]);
      expect(result.exitCode).toBe(EXIT_NEGATIVE);
      expect(result.stdout).toContain(
        "Couldn't re-read PP-D-GONE: get-dispute failed with HTTP 404",
      );
      expect(result.stdout).toContain("Recorded dispute PP-D-4");
      expect((await received(dir)).map((row) => row.refId)).toEqual(["PP-D-4"]);
    },
    SLOW,
  );

  it(
    "exits 2 when PayPal's list can't be read",
    async () => {
      const dir = await freshDir();
      const rail = sandboxWith(seed("PP-D-5"));
      rail.failures.listMerchantDisputes = httpError("list-merchant-disputes", 500);
      const result = await run(dir, rail, ["sync"]);
      expect(result.exitCode).toBe(EXIT_CANT_RUN);
      expect(result.stderr).toContain("list-merchant-disputes failed with HTTP 500");
      expect(await received(dir)).toHaveLength(0);
    },
    SLOW,
  );
});

describe("disputes list and show", () => {
  it(
    "lists each dispute with its status, reason, amount, due date and whether it's recorded",
    async () => {
      const dir = await freshDir("PP-D-1");
      const rail = sandboxWith(
        seed("PP-D-1"),
        seed("PP-D-2", { sellerResponseDueDate: null, status: "UNDER_REVIEW", reason: "OTHER" }),
      );
      const result = await run(dir, rail, ["list"]);
      expect(result.exitCode).toBe(EXIT_OK);
      expect(result.stdout).toBe(
        [
          "2 disputes.",
          "  PP-D-1  WAITING_FOR_SELLER_RESPONSE  MERCHANDISE_OR_SERVICE_NOT_RECEIVED  $240.00  due 2026-10-30  recorded",
          "  PP-D-2  UNDER_REVIEW  OTHER  $240.00  no due date  not recorded",
          "",
        ].join("\n"),
      );
      expect(rail.calls).toContainEqual({ call: "listMerchantDisputes", arg: { pageSize: 50 } });
      expect(await received(dir)).toHaveLength(1);
    },
    SLOW,
  );

  it(
    "shows a dispute as re-read and its dispute.received seq, or that it isn't recorded",
    async () => {
      const dir = await freshDir("PP-D-1");
      const rail = sandboxWith(
        seed("PP-D-1", { lifeCycleStage: "CHARGEBACK", linkNames: ["provide_evidence"] }),
        seed("PP-D-2"),
      );
      const shown = await run(dir, rail, ["show", "PP-D-1"]);
      expect(shown.exitCode).toBe(EXIT_OK);
      expect(shown.stdout).toContain("Dispute PP-D-1");
      expect(shown.stdout).toContain("Status    WAITING_FOR_SELLER_RESPONSE");
      expect(shown.stdout).toContain("Reason    MERCHANDISE_OR_SERVICE_NOT_RECEIVED");
      expect(shown.stdout).toContain("Stage     CHARGEBACK");
      expect(shown.stdout).toContain("Amount    $240.00");
      expect(shown.stdout).toContain("Due       2026-10-30T23:59:59.000Z");
      expect(shown.stdout).toContain("Captures  CAP-PP-D-1");
      expect(shown.stdout).toContain("Actions   provide_evidence");
      expect(shown.stdout).toContain("Recorded  dispute.received #1");

      const unrecorded = await run(dir, rail, ["show", "PP-D-2"]);
      expect(unrecorded.exitCode).toBe(EXIT_OK);
      expect(unrecorded.stdout).toContain(
        "Recorded  not yet; run npm run disputes -- sync to record it.",
      );

      const missing = await run(dir, rail, ["show", "PP-D-404"]);
      expect(missing.exitCode).toBe(EXIT_NEGATIVE);
      expect(missing.stdout).toContain("Couldn't read PP-D-404: get-dispute failed with HTTP 404");
    },
    SLOW,
  );
});

describe("disputes sandbox helpers", () => {
  it(
    "require-evidence asks for the seller's or buyer's evidence, labelled sandbox-only",
    async () => {
      const dir = await freshDir();
      const rail = sandboxWith(seed("PP-D-1"));
      const seller = await run(dir, rail, ["require-evidence", "PP-D-1"]);
      expect(seller.exitCode).toBe(EXIT_OK);
      expect(seller.stdout).toBe(
        "Sandbox only. PayPal now asks for the seller's evidence on PP-D-1 (HTTP 200).\n",
      );
      const buyer = await run(dir, rail, ["require-evidence", "PP-D-1", "--buyer"]);
      expect(buyer.stdout).toContain("the buyer's evidence on PP-D-1");
      expect(rail.calls.filter((c) => c.call === "requireEvidence").map((c) => c.arg)).toEqual([
        { disputeId: "PP-D-1", action: "SELLER_EVIDENCE" },
        { disputeId: "PP-D-1", action: "BUYER_EVIDENCE" },
      ]);
    },
    SLOW,
  );

  it(
    "adjudicate settles in the seller's or buyer's favour, and exits 1 on a 4xx refusal",
    async () => {
      const dir = await freshDir();
      const rail = sandboxWith(seed("PP-D-1"));
      const seller = await run(dir, rail, ["adjudicate", "PP-D-1", "--favor", "seller"]);
      expect(seller.exitCode).toBe(EXIT_OK);
      expect(seller.stdout).toBe(
        "Sandbox only. PayPal settled PP-D-1 in the seller's favour (HTTP 200).\n",
      );
      const buyer = await run(dir, rail, ["adjudicate", "PP-D-1", "--favor", "buyer"]);
      expect(buyer.stdout).toContain("in the buyer's favour");
      expect(rail.calls.filter((c) => c.call === "adjudicate").map((c) => c.arg)).toEqual([
        { disputeId: "PP-D-1", outcome: "SELLER_FAVOR" },
        { disputeId: "PP-D-1", outcome: "BUYER_FAVOR" },
      ]);

      rail.failures.adjudicate = httpError("adjudicate", 422, "UNPROCESSABLE_ENTITY");
      const refused = await run(dir, rail, ["adjudicate", "PP-D-1", "--favor", "buyer"]);
      expect(refused.exitCode).toBe(EXIT_NEGATIVE);
      expect(refused.stdout).toBe(
        "Sandbox only. PayPal refused it: adjudicate failed with HTTP 422 UNPROCESSABLE_ENTITY. Debug ID fake-debug.\n",
      );
      rail.failures.requireEvidence = httpError("require-evidence", 404, "RESOURCE_NOT_FOUND");
      const missing = await run(dir, rail, ["require-evidence", "PP-D-1"]);
      expect(missing.exitCode).toBe(EXIT_NEGATIVE);

      rail.failures.requireEvidence = httpError("require-evidence", 503);
      const unknown = await run(dir, rail, ["require-evidence", "PP-D-1"]);
      expect(unknown.exitCode).toBe(EXIT_CANT_RUN);
      expect(unknown.stderr).toContain("show PP-D-1");
    },
    SLOW,
  );
});

describe("disputes arguments and environment", () => {
  it("usage says which commands are sandbox-only", () => {
    expect(DISPUTES_USAGE).toContain("require-evidence <id> [--buyer]");
    expect(DISPUTES_USAGE).toContain("adjudicate <id> --favor seller|buyer");
    expect(DISPUTES_USAGE.match(/Sandbox only/g)).toHaveLength(2);
  });

  it("has a root disputes script that loads .env.local when it's there", () => {
    const root = JSON.parse(
      readFileSync(new URL("../../../package.json", import.meta.url), "utf8"),
    );
    expect(root.scripts.disputes).toBe(
      "tsx --env-file-if-exists=.env.local apps/gate/src/disputes-main.ts",
    );
  });

  it.each([
    [[]],
    [["nope"]],
    [["show"]],
    [["sync", "extra"]],
    [["adjudicate", "PP-D-1"]],
    [["adjudicate", "PP-D-1", "--favor", "both"]],
    [["require-evidence", "PP-D-1", "--seller"]],
    [["show", "PP D 1"]],
  ])("exits 2 with usage for %j, calling nothing", async (args) => {
    const rail = sandboxWith(seed("PP-D-1"));
    const result = await runDisputes(args, ENV, { rail, nudgeFetch: nudges().fetch });
    expect(result.exitCode).toBe(EXIT_CANT_RUN);
    expect(result.stderr).toContain("Usage: npm run disputes");
    expect(rail.calls).toEqual([]);
  });

  it("names missing PayPal variables and never shows a value", async () => {
    const result = await runDisputes(
      ["sync"],
      { PAYPAL_BASE_URL: SANDBOX_BASE_URL, PAYPAL_CLIENT_SECRET: SECRET },
      { nudgeFetch: nudges().fetch },
    );
    expect(result.exitCode).toBe(EXIT_CANT_RUN);
    expect(result.stderr).toContain("PAYPAL_CLIENT_ID");
    expect(result.stderr).not.toContain(SECRET);
    expect(result.stdout).toBe("");
  });

  it(
    "runs as a child process and exits 2 without PayPal variables",
    () => {
      const child = spawnSync("node", ["--import", "tsx", entry, "sync"], {
        cwd: repoRoot,
        env: { PATH: process.env.PATH ?? "" },
        encoding: "utf8",
      });
      expect(child.status).toBe(EXIT_CANT_RUN);
      expect(child.stderr).toContain("PAYPAL_CLIENT_ID");
    },
    SLOW,
  );
});
