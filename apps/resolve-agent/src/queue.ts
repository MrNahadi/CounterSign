import {
  createRun,
  type Database,
  finishDraft,
  finishRun,
  readDraft,
  readRun,
} from "@countersign/db";
import { runBaseline, type TokenIssuer, type TransportFactory } from "./baseline";
import { newId } from "./intake";
import type { GenerateContent } from "./model";
import { type ProtectedEnv, runProtected } from "./protected";

// The run queue (ADR 0030): one run at a time per process, in the order queued, so a burst of
// messages doesn't hit the free tier's per-minute limit. The queue knows only IDs; the mode
// runner reads the run and starts the right mode, or hands a dispute draft (`drf_…`, ADR 0035)
// to the drafter.

/**
 * Runs one queued run to its end. Its own errors are logged by the queue, never thrown on. It may
 * return the ID of a new queued run to follow it (the fallback rerun); the queue runs that next.
 */
export type ModeRunner = (runId: string) => Promise<string | undefined | void>;

export type RunQueue = {
  /** Adds a run to the back of the queue. It starts once every run before it has ended. */
  enqueue: (runId: string) => void;
  /** Resolves once every run queued so far has ended. */
  idle: () => Promise<void>;
};

export function createRunQueue(runner: ModeRunner, log?: (line: string) => void): RunQueue {
  let tail: Promise<void> = Promise.resolve();
  const queue: RunQueue = {
    enqueue(runId) {
      tail = tail.then(async () => {
        try {
          const followUp = await runner(runId);
          if (typeof followUp === "string") queue.enqueue(followUp);
        } catch (error: unknown) {
          // Only the error's name: its message could carry anything a dependency put in it.
          const name = error instanceof Error ? error.name : "an unknown error";
          log?.(`Run ${runId} ended with ${name}; it stays as stored.`);
        }
      });
    },
    // A run can queue its follow-up while it ends, so wait until the tail stops moving.
    idle: async () => {
      let seen: Promise<void>;
      do {
        seen = tail;
        await seen;
      } while (seen !== tail);
    },
  };
  return queue;
}

export type ModeRunnerDeps = {
  db: Database;
  /** The model call, or null when `GEMINI_API_KEY` is unset. */
  generateContent: GenerateContent | null;
  protectedEnv: ProtectedEnv;
  issueToken: TokenIssuer;
  createTransport?: TransportFactory;
  clock: () => Date;
  /** `GEMINI_FALLBACK_MODEL`: the model for the one rerun after `model_unavailable`. Null for none. */
  fallbackModel?: string | null;
  /** Runs one queued dispute draft to its end. Without it, drafts end `failed`, `not_configured`. */
  runDraft?: DraftRunner;
  log?: (line: string) => void;
};

/** Runs one queued dispute draft to its end, finishing it in the draft store. */
export type DraftRunner = (draftId: string) => Promise<void>;

/** True for a dispute draft's ID; every other queued ID is a run's. */
export const isDraftId = (id: string): boolean => id.startsWith("drf_");

// True when the run's trace holds a tool call. A run that ran any tool is never rerun.
const ranATool = (trace: unknown): boolean => {
  const steps = (trace as { steps?: unknown } | null)?.steps;
  return (
    !Array.isArray(steps) || steps.some((step) => (step as { kind?: unknown })?.kind === "tool")
  );
};

/** Starts each run in the mode it was queued with; with no model, ends it `not_configured`. */
export function createModeRunner(deps: ModeRunnerDeps): ModeRunner {
  return async (runId) => {
    if (isDraftId(runId)) {
      const draft = await readDraft(deps.db, runId);
      if (draft?.status !== "queued") return;
      if (deps.runDraft) {
        await deps.runDraft(runId);
        return;
      }
      await finishDraft(deps.db, runId, {
        status: "failed",
        outcome: "not_configured",
        finishedAt: deps.clock().toISOString(),
      });
      deps.log?.(`Draft ${runId}: failed, not_configured.`);
      return;
    }
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
    const finished =
      run.mode === "protected"
        ? await runProtected({ ...common, env: deps.protectedEnv })
        : await runBaseline({
            ...common,
            issueToken: deps.issueToken,
            ...(deps.createTransport ? { createTransport: deps.createTransport } : {}),
          });

    // One rerun on the fallback model, only when the model was unavailable before any tool ran.
    const fallback = deps.fallbackModel;
    if (
      finished.outcome !== "model_unavailable" ||
      !fallback ||
      fallback === run.model ||
      ranATool(finished.trace)
    ) {
      return;
    }
    const rerunId = newId("run");
    await createRun(deps.db, {
      id: rerunId,
      ticketId: run.ticketId,
      threadId: run.threadId,
      mode: run.mode,
      model: fallback,
      queuedAt: deps.clock().toISOString(),
    });
    deps.log?.(
      `Run ${runId}: model_unavailable; rerunning once as ${rerunId} on the fallback model.`,
    );
    return rerunId;
  };
}
