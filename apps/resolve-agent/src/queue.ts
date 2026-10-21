import { type Database, finishRun, readRun } from "@countersign/db";
import { runBaseline, type TokenIssuer, type TransportFactory } from "./baseline";
import type { GenerateContent } from "./model";
import { type ProtectedEnv, runProtected } from "./protected";

// The run queue (ADR 0030): one run at a time per process, in the order queued, so a burst of
// messages doesn't hit the free tier's per-minute limit. The queue knows only run IDs; the mode
// runner reads the run and starts the right mode.

/** Runs one queued run to its end. Its own errors are logged by the queue, never thrown on. */
export type ModeRunner = (runId: string) => Promise<void>;

export type RunQueue = {
  /** Adds a run to the back of the queue. It starts once every run before it has ended. */
  enqueue: (runId: string) => void;
  /** Resolves once every run queued so far has ended. */
  idle: () => Promise<void>;
};

export function createRunQueue(runner: ModeRunner, log?: (line: string) => void): RunQueue {
  let tail: Promise<void> = Promise.resolve();
  return {
    enqueue(runId) {
      tail = tail.then(() =>
        runner(runId).catch((error: unknown) => {
          // Only the error's name: its message could carry anything a dependency put in it.
          const name = error instanceof Error ? error.name : "an unknown error";
          log?.(`Run ${runId} ended with ${name}; it stays as stored.`);
        }),
      );
    },
    idle: () => tail,
  };
}

export type ModeRunnerDeps = {
  db: Database;
  /** The model call, or null when `GEMINI_API_KEY` is unset. */
  generateContent: GenerateContent | null;
  protectedEnv: ProtectedEnv;
  issueToken: TokenIssuer;
  createTransport?: TransportFactory;
  clock: () => Date;
  log?: (line: string) => void;
};

/** Starts each run in the mode it was queued with; with no model, ends it `not_configured`. */
export function createModeRunner(deps: ModeRunnerDeps): ModeRunner {
  return async (runId) => {
    const run = await readRun(deps.db, runId);
    if (run?.status !== "queued") return;
    const { generateContent } = deps;
    if (generateContent === null) {
      await finishRun(deps.db, runId, {
        status: "not_run",
        outcome: "not_configured",
        reply: null,
        modelVersions: [],
        trace: null,
        finishedAt: deps.clock().toISOString(),
      });
      deps.log?.(`Run ${runId} (${run.mode}): not_run, not_configured.`);
      return;
    }
    const common = {
      db: deps.db,
      runId,
      generateContent,
      clock: deps.clock,
      ...(deps.log ? { log: deps.log } : {}),
    };
    if (run.mode === "protected") {
      await runProtected({ ...common, env: deps.protectedEnv });
    } else {
      await runBaseline({
        ...common,
        issueToken: deps.issueToken,
        ...(deps.createTransport ? { createTransport: deps.createTransport } : {}),
      });
    }
  };
}
