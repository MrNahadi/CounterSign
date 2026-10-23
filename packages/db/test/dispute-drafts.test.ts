import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  countDraftsOnDate,
  createTestDatabase,
  type DatabaseHandle,
  DisputeDraftConflictError,
  finishDraft,
  InvalidDisputeDraftError,
  queueDraft,
  sql,
} from "../src/index";

const NEW = {
  id: "drf_1",
  disputeId: "PP-D-1",
  model: "gemini-3.5-flash-lite",
  queuedAt: "2026-10-22T09:00:00.000Z",
};

describe("dispute drafts on a fresh in-memory PGlite", () => {
  let handle: DatabaseHandle;

  beforeAll(async () => {
    handle = await createTestDatabase();
  }, 60_000);

  beforeEach(async () => {
    await handle.db.execute(sql`TRUNCATE dispute_drafts`);
  });

  afterAll(async () => {
    await handle.close();
  });

  it("queues one live draft when two writers race, and answers the winner to the other", async () => {
    const [a, b] = await Promise.all([
      queueDraft(handle.db, NEW),
      queueDraft(handle.db, { ...NEW, id: "drf_2" }),
    ]);
    expect([a.created, b.created].sort()).toEqual([false, true]);
    expect(a.draft.id).toBe(b.draft.id);
    await expect(queueDraft(handle.db, { ...NEW, disputeId: "PP-D-2" })).rejects.toBeInstanceOf(
      DisputeDraftConflictError,
    );
    await expect(queueDraft(handle.db, { ...NEW, queuedAt: "today" })).rejects.toBeInstanceOf(
      InvalidDisputeDraftError,
    );
  });

  it("counts every draft queued on a UTC date, failed attempts included", async () => {
    await queueDraft(handle.db, NEW);
    await finishDraft(handle.db, "drf_1", {
      status: "failed",
      outcome: "gate_unavailable",
      finishedAt: "2026-10-22T09:00:01.000Z",
    });
    await queueDraft(handle.db, { ...NEW, id: "drf_2", queuedAt: "2026-10-22T23:59:59.000Z" });
    await queueDraft(handle.db, {
      ...NEW,
      id: "drf_3",
      disputeId: "PP-D-3",
      queuedAt: "2026-10-23T00:00:00.000Z",
    });
    expect(await countDraftsOnDate(handle.db, "2026-10-22")).toBe(2);
    expect(await countDraftsOnDate(handle.db, "2026-10-23")).toBe(1);
    await expect(
      finishDraft(handle.db, "drf_1", {
        status: "proposed",
        outcome: "proposed",
        finishedAt: "2026-10-22T09:00:02.000Z",
      }),
    ).rejects.toBeInstanceOf(DisputeDraftConflictError);
  });
});
