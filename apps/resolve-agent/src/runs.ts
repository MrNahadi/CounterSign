import { type AgentRun, type Database, finishRun, readRun, startRun } from "@countersign/db";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { type HarnessResult, type HarnessTrace, runHarness } from "./harness";
import type { GenerateContent } from "./model";

// What both modes share around the harness: starting a queued run, running the one loop on
// whichever MCP client the mode connected, and storing how the run ended. Only the
// connection differs between protected and baseline mode (ADR 0031).

export type RunMode = "protected" | "baseline";

/** A run's trace as stored: the harness's, marked with its mode. */
export type RunTrace = HarnessTrace & { mode: RunMode };

/** Every outcome a run can end with here: the harness's, or its mode's connection failing. */
export type RunOutcome = HarnessResult["outcome"] | "gate_unavailable" | "baseline_unavailable";

export class RunNotQueuedError extends Error {
  override readonly name = "RunNotQueuedError";
}

export type ModeRunInput = {
  db: Database;
  runId: string;
  generateContent: GenerateContent;
  /** Wall-clock time for the run's started and finished times. */
  clock: () => Date;
  /** A monotonic clock in milliseconds, for latency only. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** One line per finished run. Never given a key, token or reply. */
  log?: (line: string) => void;
};

type Ending = Pick<HarnessResult, "status" | "reply" | "modelVersions"> & { outcome: RunOutcome };

/**
 * Starts a queued run of `mode`, connects through `connect` (null ends the run `failed` with
 * `unavailable` before any model call), runs the harness, and stores the result. The client is
 * closed however the run ends.
 */
export async function executeRun(
  input: ModeRunInput,
  mode: RunMode,
  connect: () => Promise<Client | null>,
  unavailable: "gate_unavailable" | "baseline_unavailable",
): Promise<AgentRun> {
  const { db, runId } = input;
  const run = await readRun(db, runId);
  if (run?.status !== "queued" || run.mode !== mode) {
    throw new RunNotQueuedError(`Run ${runId} isn't a queued ${mode}-mode run.`);
  }
  await startRun(db, runId, input.clock().toISOString());

  const finish = async (ending: Ending, trace: RunTrace) => {
    await finishRun(db, runId, {
      status: ending.status,
      outcome: ending.outcome,
      reply: ending.reply,
      modelVersions: ending.modelVersions,
      trace,
      finishedAt: input.clock().toISOString(),
    });
    input.log?.(`Run ${runId} (${mode}): ${ending.status}, ${ending.outcome}.`);
    return (await readRun(db, runId)) as AgentRun;
  };

  const client = await connect();
  if (client === null) {
    return finish(
      { status: "failed", outcome: unavailable, reply: null, modelVersions: [] },
      { mode, tools: [], rewrites: [], steps: [] },
    );
  }
  try {
    const result = await runHarness({
      db,
      client,
      generateContent: input.generateContent,
      model: run.model,
      ticketId: run.ticketId,
      threadId: run.threadId,
      ...(input.now ? { now: input.now } : {}),
      ...(input.sleep ? { sleep: input.sleep } : {}),
    });
    return await finish(result, { mode, ...result.trace });
  } finally {
    await client.close().catch(() => {});
  }
}
