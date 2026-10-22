import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createMemoryShipmentStore, createMockCarrier } from "@countersign/carrier-mock";
import { asc, auditLog, openPgliteDirectory, seedOrders, sql, writeTicket } from "@countersign/db";
import { checkEvidence } from "@countersign/ledger";
import { parseMandate } from "@countersign/mandate";
import { beforeAll, describe, expect, it } from "vitest";
import { answerStepUp } from "../src/answer-step-up";
import { AUDIT_USAGE, EXIT_BROKEN, EXIT_CANT_RUN, runAudit } from "../src/audit-cli";
import { propose } from "../src/propose";
import { createFakeSandbox } from "./fake-sandbox";
import { trackedTempDirs } from "./temp-dirs";

// The audit CLI through runAudit(), over a PGlite directory holding beat 5: held, approved and
// refunded. The fake sandbox and an injected clock; illustrative IDs and people.

const SLOW = 120_000;
const NOW = new Date("2026-10-17T09:00:00+03:00");
const LATER = new Date(NOW.getTime() + 5 * 60 * 1000);
const PAYER = "wanjiru.m@example.com";
const entry = fileURLToPath(new URL("../src/audit-main.ts", import.meta.url));
const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const usd = (minor: number) => ({ minor, currency: "USD" as const });

const parsedMandate = parseMandate(
  JSON.parse(
    readFileSync(
      fileURLToPath(
        new URL("../../../packages/mandate/fixtures/kikapu-studio-v3.json", import.meta.url),
      ),
      "utf8",
    ),
  ),
);
if (!parsedMandate.ok) throw new Error(parsedMandate.error);
const mandates = [parsedMandate.mandate];

const makeDir = trackedTempDirs();

describe("audit CLI", { timeout: SLOW }, () => {
  let dir: string;
  let decisionSeq: number;
  let intentId: string;
  let entryCount: number;

  const run = (args: string[], cwd = makeDir("audit-cwd-")) =>
    runAudit([...args, "--pglite", dir], {}, { now: () => LATER, mandates, cwd });
  const count = async () => {
    const handle = await openPgliteDirectory(dir);
    try {
      return (await handle.db.select().from(auditLog).orderBy(asc(auditLog.seq))).length;
    } finally {
      await handle.close();
    }
  };

  beforeAll(async () => {
    dir = makeDir("audit-cli-");
    const handle = await openPgliteDirectory(dir);
    try {
      await writeTicket(handle.db, {
        id: "TKT-1037",
        channel: "email",
        senderEmail: PAYER,
        senderPhone: null,
        subject: "Arrived broken",
        body: "Simulated ticket. The vase arrived in pieces.",
        attachments: [{ id: "ATT-TKT-1037", contentType: "image/jpeg" }],
        receivedAt: "2026-10-17T08:00:00+03:00",
        simulated: true,
      });
      await handle.db.insert(seedOrders).values({
        orderNumber: "KIK-1037",
        runId: "run-illustrative",
        paypalOrderId: "ORD-1037",
        paypalCaptureId: "CAP-1037",
        amountMinor: 24000,
        currency: "USD",
        payerEmail: PAYER,
        buyer: "A",
        trackingNumber: "TRK1037",
        role: "illustrative",
        seededAt: "2026-10-01T08:00:00Z",
      });
      const rail = createFakeSandbox();
      const capture = {
        id: "CAP-1037",
        status: "COMPLETED",
        amount: usd(24000),
        orderId: "ORD-1037",
      };
      rail.captures.set("CAP-1037", capture);
      rail.orders.set("ORD-1037", {
        id: "ORD-1037",
        status: "COMPLETED",
        payerEmail: PAYER,
        payerId: "PAYER1037",
        purchaseUnits: [
          {
            referenceId: "KIK-1037",
            customId: null,
            invoiceId: null,
            amount: usd(24000),
            captures: [capture],
            trackers: [
              {
                id: "CAP-1037-TRK1037",
                captureId: "CAP-1037",
                trackingNumber: "TRK1037",
                status: "SHIPPED",
              },
            ],
            refunds: [],
          },
        ],
      });
      const carrier = createMockCarrier(
        createMemoryShipmentStore(
          new Map<string, unknown>([
            [
              "TRK1037",
              {
                trackingNumber: "TRK1037",
                carrierName: "Illustrative Post",
                status: "delivered",
                scanEvents: [
                  { at: "2026-10-02T08:00:00Z", description: "Accepted", place: "Nairobi" },
                ],
                updatedAt: "2026-10-05T08:00:00Z",
              },
            ],
          ]),
        ),
      );
      const result = await propose({
        mandate: mandates[0] as (typeof mandates)[number],
        principal: "support-agent",
        proposal: {
          tool: "create_refund",
          args: { capture_id: "CAP-1037", amount: { value: "240.00", currency_code: "USD" } },
          justification: { ticket_id: "TKT-1037", claim: "damaged" },
        },
        now: NOW,
        rail,
        carrier,
        db: handle.db,
        clock: () => NOW,
      });
      if (!result.ok || result.replay || result.record.intentHash === null) {
        throw new Error("not decided");
      }
      decisionSeq = result.seqs.decision;
      intentId = result.record.intentId as string;
      const answered = await answerStepUp({
        db: handle.db,
        rail,
        stepUpSeq: decisionSeq,
        answer: "approve",
        intentHash: result.record.intentHash,
        channel: "approvals_page",
        now: LATER,
        clock: () => LATER,
      });
      if (answered.kind !== "answered") throw new Error("not answered");
    } finally {
      await handle.close();
    }
    entryCount = await count();
  }, SLOW);

  it("shows the decision, the claims and records as pairs, and the trail", async () => {
    const result = await run(["show", String(decisionSeq)]);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    const out = result.stdout;
    expect(out).toContain("$240.00");
    expect(out).toContain("KIK-1037");
    expect(out).toContain("Step-up");
    expect(out).toContain("What the message claims");
    expect(out).toContain("What the records say");
    expect(out).toContain("Matches: 1 photo attached");
    expect(out).toContain("Not used");
    expect(out).toContain("Messages can't approve money. Only your signed rules can.");
    expect(out).toContain("What happened");
    expect(out).toContain("Approved step-up");
    expect(out).toContain("PayPal refunded it");
  });

  it("prints the detail as JSON with --json", async () => {
    const result = await run(["show", String(decisionSeq), "--json"]);
    expect(result.exitCode).toBe(0);
    const detail = JSON.parse(result.stdout);
    expect(detail.seq).toBe(decisionSeq);
    expect(detail.intent_id).toBe(intentId);
    expect(detail.claims.length).toBeGreaterThan(0);
  });

  it("exits 2 for an unknown or malformed entry number and for bad arguments", async () => {
    const unknown = await run(["show", "9999"]);
    expect(unknown.exitCode).toBe(EXIT_CANT_RUN);
    expect(unknown.stderr).toContain("no decision");
    // An entry that isn't a decision entry is not found either.
    expect((await run(["show", "1"])).exitCode).toBe(decisionSeq === 1 ? 0 : EXIT_CANT_RUN);
    expect((await run(["show", "abc"])).exitCode).toBe(EXIT_CANT_RUN);
    expect((await run(["show"])).stderr).toContain(AUDIT_USAGE);
    expect((await run(["export"])).stderr).toContain("exactly one");
    expect((await run(["export", "--intent", intentId, "--capture", "CAP-1037"])).exitCode).toBe(
      EXIT_CANT_RUN,
    );
    expect((await run(["export", "--intent", "nope"])).exitCode).toBe(EXIT_CANT_RUN);
    expect((await run(["frobnicate"])).exitCode).toBe(EXIT_CANT_RUN);
    expect((await run(["show", String(decisionSeq), "--bogus"])).exitCode).toBe(EXIT_CANT_RUN);
  });

  it("exits 2 when there's nothing to export", async () => {
    const result = await run(["export", "--intent", "int_000000000000000000000000"]);
    expect(result.exitCode).toBe(EXIT_CANT_RUN);
    expect(result.stderr).toContain("nothing to export");
  });

  it("writes the evidence file under the default name and never overwrites it", async () => {
    const cwd = makeDir("audit-export-");
    const first = await run(["export", "--intent", intentId], cwd);
    expect(first.exitCode).toBe(0);
    const path = join(cwd, `countersign-evidence-intent-${intentId}.json`);
    expect(first.stdout).toContain(path);
    expect(first.stdout).toMatch(/with \d+ entries/);
    const text = readFileSync(path, "utf8");
    const checked = checkEvidence(JSON.parse(text));
    expect(checked.ok && checked.problems).toEqual([]);

    writeFileSync(path, "keep me");
    const second = await run(["export", "--intent", intentId], cwd);
    expect(second.exitCode).toBe(EXIT_CANT_RUN);
    expect(second.stderr).toContain("already exists");
    expect(readFileSync(path, "utf8")).toBe("keep me");
  });

  it("writes to --out and exports by capture", async () => {
    const cwd = makeDir("audit-out-");
    const result = await run(["export", "--capture", "CAP-1037", "--out", "mine.json"], cwd);
    expect(result.exitCode).toBe(0);
    expect(existsSync(join(cwd, "mine.json"))).toBe(true);
    const json = await run(
      ["export", "--capture", "CAP-1037", "--out", "again.json", "--json"],
      cwd,
    );
    expect(JSON.parse(json.stdout).entry_count).toBeGreaterThan(0);
  });

  it("leaves the audit log as it was", async () => {
    await run(["show", String(decisionSeq)]);
    await run(["export", "--intent", intentId, "--out", "unchanged-check.json"]);
    expect(await count()).toBe(entryCount);
  });

  it("writes the file but exits 1 when the chain is broken", async () => {
    const handle = await openPgliteDirectory(dir);
    try {
      await handle.db.execute(sql`ALTER TABLE audit_log DISABLE TRIGGER audit_log_append_only`);
      await handle.db.execute(
        sql`UPDATE audit_log SET hash = ${"0".repeat(64)} WHERE seq = ${entryCount}`,
      );
      await handle.db.execute(sql`ALTER TABLE audit_log ENABLE TRIGGER audit_log_append_only`);
    } finally {
      await handle.close();
    }
    const cwd = makeDir("audit-broken-");
    const result = await run(["export", "--intent", intentId], cwd);
    expect(result.exitCode).toBe(EXIT_BROKEN);
    expect(result.stdout).toContain("The audit log is broken");
    const file = JSON.parse(
      readFileSync(join(cwd, `countersign-evidence-intent-${intentId}.json`), "utf8"),
    );
    expect(file.chain.intact).toBe(false);
  });

  it("runs as a child process and exits 2 for an unknown entry", () => {
    const child = spawnSync(
      "node",
      ["--import", "tsx", entry, "show", "1", "--pglite", join(makeDir("audit-empty-"), "none")],
      { cwd: repoRoot, env: { PATH: process.env.PATH ?? "" }, encoding: "utf8" },
    );
    expect(child.status).toBe(EXIT_CANT_RUN);
    expect(child.stderr).toContain("no decision");
  });
});
