import { describe, expect, it } from "vitest";
import { ApprovalsViewSchema } from "../../apps/console/src/approval-schemas";
import {
  ChainVerdictSchema,
  DecisionDetailSchema,
  DecisionRowsPageSchema,
  EntryPageSchema,
  IntentDecisionSchema,
  VisitorMoneySchema,
} from "../../apps/console/src/audit-schemas";
import {
  DisputeListSchema,
  ThreadDetailSchema,
  ThreadIdSchema,
  ThreadListSchema,
} from "../../apps/console/src/resolve-schemas";
import { FIXTURE_IDS, fixtures } from "./fixtures";

const now = new Date();
const fx = fixtures(now);

describe("harness fixtures", () => {
  it("parse with the schemas the console reads them with", () => {
    expect(ApprovalsViewSchema.safeParse(fx.approvals).success).toBe(true);
    expect(DecisionRowsPageSchema.safeParse(fx.decisions).success).toBe(true);
    expect(DecisionDetailSchema.safeParse(fx.decision[FIXTURE_IDS.readableSeq]).success).toBe(true);
    expect(DecisionDetailSchema.safeParse(fx.decision[FIXTURE_IDS.unreadableSeq]).success).toBe(
      true,
    );
    expect(IntentDecisionSchema.safeParse(fx.intent).success).toBe(true);
    expect(EntryPageSchema.safeParse(fx.entries).success).toBe(true);
    expect(ChainVerdictSchema.safeParse(fx.verify).success).toBe(true);
    expect(VisitorMoneySchema.safeParse(fx.visitors).success).toBe(true);
    expect(ThreadListSchema.safeParse(fx.threads).success).toBe(true);
    expect(ThreadDetailSchema.safeParse(fx.thread[FIXTURE_IDS.threadId]).success).toBe(true);
    expect(DisputeListSchema.safeParse(fx.disputes).success).toBe(true);
  });

  it("has open cards that expire in the future and no working thread", () => {
    const view = ApprovalsViewSchema.parse(fx.approvals);
    expect(view.open).toHaveLength(3);
    for (const card of view.open)
      expect(Date.parse(card.expires_at)).toBeGreaterThan(now.getTime());
    const list = ThreadListSchema.parse(fx.threads);
    expect(list.threads.length).toBeGreaterThanOrEqual(4);
    for (const thread of list.threads) {
      expect(["queued", "running"]).not.toContain(thread.latest_run?.status);
    }
  });

  it("names the screens' IDs", () => {
    expect(FIXTURE_IDS.readableSeq).toBe("41");
    expect(FIXTURE_IDS.unreadableSeq).toBe("7");
    expect(ThreadIdSchema.safeParse(FIXTURE_IDS.threadId).success).toBe(true);
    expect(FIXTURE_IDS.productId).toBe("market-basket");
  });

  it("has a 160 by 120 PNG photo", () => {
    const bytes = Buffer.from(fx.photo);
    expect([...bytes.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(bytes.subarray(12, 16).toString("ascii")).toBe("IHDR");
    expect(bytes.readUInt32BE(16)).toBe(160);
    expect(bytes.readUInt32BE(20)).toBe(120);
  });

  it("uses only example.com emails and marks names as illustrative", () => {
    const text = JSON.stringify([fx.approvals, fx.decisions, fx.decision, fx.threads, fx.thread]);
    const emails = text.match(/[\w.+-]+@[\w.-]+/g) ?? [];
    expect(emails.length).toBeGreaterThan(0);
    for (const email of emails) expect(email.endsWith("@example.com")).toBe(true);
    expect(text).toContain("Kisumu Dye Works (illustrative)");
    expect(text).not.toMatch(/Kisumu Dye Works(?! \(illustrative\))/);
    expect(text).not.toMatch(/Amina(?! \(illustrative\)|\.odhiambo)/);
  });
});
