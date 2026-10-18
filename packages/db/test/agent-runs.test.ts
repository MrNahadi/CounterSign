import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  AgentRunConflictError,
  AgentRunNotFoundError,
  countRunsOnDate,
  createRun,
  createTestDatabase,
  type DatabaseHandle,
  finishRun,
  InvalidAgentRunError,
  markUnfinishedRunsInterrupted,
  readRun,
  readRunsByThread,
  sql,
  startRun,
} from "../src/index";

const SLOW = 60_000;

const NEW = {
  id: "run_1",
  ticketId: "tkt_1",
  threadId: "tkt_1",
  mode: "protected" as const,
  model: "gemini-3.5-flash-lite",
  queuedAt: "2026-10-17T09:00:00.000Z",
};

describe("agent runs on a fresh in-memory PGlite", () => {
  let handle: DatabaseHandle;

  beforeAll(async () => {
    handle = await createTestDatabase();
  }, SLOW);

  beforeEach(async () => {
    await handle.db.execute(sql`TRUNCATE agent_runs`);
  });

  afterAll(async () => {
    await handle.close();
  });

  it("queues, starts and finishes a run, and reads it back with everything it recorded", async () => {
    await createRun(handle.db, NEW);
    expect(await readRun(handle.db, "run_1")).toEqual({
      ...NEW,
      status: "queued",
      outcome: null,
      reply: null,
      modelVersions: [],
      trace: null,
      startedAt: null,
      finishedAt: null,
    });

    await startRun(handle.db, "run_1", "2026-10-17T09:00:01.000Z");
    expect(await readRun(handle.db, "run_1")).toMatchObject({
      status: "running",
      startedAt: "2026-10-17T09:00:01.000Z",
    });

    const trace = { modelCalls: [{ step: 1, latencyMs: 12000 }], toolCalls: [], rewrites: [] };
    await finishRun(handle.db, "run_1", {
      status: "replied",
      outcome: "replied",
      reply: "Your refund is on its way.",
      modelVersions: ["gemini-3.5-flash-lite-001"],
      trace,
      finishedAt: "2026-10-17T09:00:20.000Z",
    });
    expect(await readRun(handle.db, "run_1")).toMatchObject({
      status: "replied",
      outcome: "replied",
      reply: "Your refund is on its way.",
      modelVersions: ["gemini-3.5-flash-lite-001"],
      trace,
      finishedAt: "2026-10-17T09:00:20.000Z",
    });
  });

  it("reads null for an unknown run", async () => {
    expect(await readRun(handle.db, "run_nope")).toBeNull();
  });

  it("refuses to finish a finished run again, and keeps the first result", async () => {
    await createRun(handle.db, NEW);
    await startRun(handle.db, "run_1", "2026-10-17T09:00:01.000Z");
    const done = {
      status: "stopped" as const,
      outcome: "step_cap",
      reply: null,
      modelVersions: [],
      trace: {},
      finishedAt: "2026-10-17T09:00:20.000Z",
    };
    await finishRun(handle.db, "run_1", done);
    await expect(
      finishRun(handle.db, "run_1", { ...done, status: "replied", outcome: "replied" }),
    ).rejects.toBeInstanceOf(AgentRunConflictError);
    expect(await readRun(handle.db, "run_1")).toMatchObject({
      status: "stopped",
      outcome: "step_cap",
    });
    await expect(startRun(handle.db, "run_1", "2026-10-17T09:01:00Z")).rejects.toBeInstanceOf(
      AgentRunConflictError,
    );
  });

  it("refuses to start a run twice, and reports an unknown run", async () => {
    await createRun(handle.db, NEW);
    await startRun(handle.db, "run_1", "2026-10-17T09:00:01Z");
    await expect(startRun(handle.db, "run_1", "2026-10-17T09:00:02Z")).rejects.toBeInstanceOf(
      AgentRunConflictError,
    );
    await expect(startRun(handle.db, "run_nope", "2026-10-17T09:00:02Z")).rejects.toBeInstanceOf(
      AgentRunNotFoundError,
    );
    await expect(
      finishRun(handle.db, "run_nope", {
        status: "failed",
        outcome: "model_error",
        reply: null,
        modelVersions: [],
        trace: {},
        finishedAt: "2026-10-17T09:00:02Z",
      }),
    ).rejects.toBeInstanceOf(AgentRunNotFoundError);
  });

  it("lets a queued run finish as not_run without starting", async () => {
    await createRun(handle.db, NEW);
    await finishRun(handle.db, "run_1", {
      status: "not_run",
      outcome: "daily_cap",
      reply: null,
      modelVersions: [],
      trace: null,
      finishedAt: "2026-10-17T09:00:00.500Z",
    });
    expect(await readRun(handle.db, "run_1")).toMatchObject({
      status: "not_run",
      outcome: "daily_cap",
      startedAt: null,
    });
  });

  it("refuses a duplicate run ID with other contents and a bad status, mode or time", async () => {
    await createRun(handle.db, NEW);
    await expect(createRun(handle.db, { ...NEW, model: "gemini-other" })).rejects.toBeInstanceOf(
      AgentRunConflictError,
    );
    await expect(
      createRun(handle.db, { ...NEW, id: "run_2", mode: "wild" as never }),
    ).rejects.toBeInstanceOf(InvalidAgentRunError);
    await expect(
      createRun(handle.db, { ...NEW, id: "run_2", queuedAt: "yesterday" }),
    ).rejects.toBeInstanceOf(InvalidAgentRunError);
    await expect(
      finishRun(handle.db, "run_1", {
        status: "queued" as never,
        outcome: "x",
        reply: null,
        modelVersions: [],
        trace: null,
        finishedAt: "2026-10-17T09:00:02Z",
      }),
    ).rejects.toBeInstanceOf(InvalidAgentRunError);
  });

  it("holds status and mode to their values with a database constraint", async () => {
    await expect(
      handle.db.execute(
        sql`INSERT INTO agent_runs (id, ticket_id, thread_id, mode, model, status, queued_at)
            VALUES ('r', 't', 't', 'protected', 'm', 'done', '2026-10-17T09:00:00Z')`,
      ),
    ).rejects.toThrow();
    await expect(
      handle.db.execute(
        sql`INSERT INTO agent_runs (id, ticket_id, thread_id, mode, model, status, queued_at)
            VALUES ('r', 't', 't', 'turbo', 'm', 'queued', '2026-10-17T09:00:00Z')`,
      ),
    ).rejects.toThrow();
  });

  it("reads a thread's runs in creation order, even when queued times tie or run backwards", async () => {
    await createRun(handle.db, { ...NEW, id: "run_b", queuedAt: "2026-10-17T09:00:00Z" });
    await createRun(handle.db, {
      ...NEW,
      id: "run_a",
      queuedAt: "2026-10-17T09:00:00Z",
      mode: "baseline",
    });
    await createRun(handle.db, { ...NEW, id: "run_c", threadId: "other", ticketId: "tkt_9" });
    expect((await readRunsByThread(handle.db, "tkt_1")).map((run) => run.id)).toEqual([
      "run_b",
      "run_a",
    ]);
    expect(await readRunsByThread(handle.db, "none")).toEqual([]);
  });

  it("counts the runs created on a UTC date, every status included", async () => {
    await createRun(handle.db, { ...NEW, id: "r1", queuedAt: "2026-10-17T23:59:59Z" });
    // 01:30 at +03:00 on the 18th is 22:30 UTC on the 17th.
    await createRun(handle.db, { ...NEW, id: "r2", queuedAt: "2026-10-18T01:30:00+03:00" });
    await createRun(handle.db, { ...NEW, id: "r3", queuedAt: "2026-10-18T00:00:00Z" });
    await finishRun(handle.db, "r3", {
      status: "not_run",
      outcome: "daily_cap",
      reply: null,
      modelVersions: [],
      trace: null,
      finishedAt: "2026-10-18T00:00:01Z",
    });
    expect(await countRunsOnDate(handle.db, "2026-10-17")).toBe(2);
    expect(await countRunsOnDate(handle.db, "2026-10-18")).toBe(1);
    expect(await countRunsOnDate(handle.db, "2026-10-19")).toBe(0);
    await expect(countRunsOnDate(handle.db, "17 Oct")).rejects.toBeInstanceOf(InvalidAgentRunError);
  });

  it("marks every queued or running run failed interrupted in one call and returns the count", async () => {
    await createRun(handle.db, { ...NEW, id: "q" });
    await createRun(handle.db, { ...NEW, id: "r" });
    await startRun(handle.db, "r", "2026-10-17T09:00:01Z");
    await createRun(handle.db, { ...NEW, id: "d" });
    await finishRun(handle.db, "d", {
      status: "not_run",
      outcome: "not_configured",
      reply: null,
      modelVersions: [],
      trace: null,
      finishedAt: "2026-10-17T09:00:02Z",
    });
    expect(await markUnfinishedRunsInterrupted(handle.db, "2026-10-18T08:00:00Z")).toBe(2);
    expect(await readRun(handle.db, "q")).toMatchObject({
      status: "failed",
      outcome: "interrupted",
      finishedAt: "2026-10-18T08:00:00Z",
    });
    expect(await readRun(handle.db, "r")).toMatchObject({
      status: "failed",
      outcome: "interrupted",
    });
    expect(await readRun(handle.db, "d")).toMatchObject({ status: "not_run" });
    expect(await markUnfinishedRunsInterrupted(handle.db, "2026-10-18T08:00:01Z")).toBe(0);
  });
});
