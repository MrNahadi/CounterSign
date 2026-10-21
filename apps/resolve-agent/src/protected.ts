import { type AgentRun, type Database, finishRun, readRun, startRun } from "@countersign/db";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { z } from "zod";
import { type HarnessResult, type HarnessTrace, runHarness } from "./harness";
import type { GenerateContent } from "./model";

// Protected mode (ADRs 0028 and 0031): the harness's MCP client is the gate, reached over
// Streamable HTTP with the support agent's principal key. Resolve holds no PayPal credential
// here; money moves only through the gate's decision. A missing key, a refused key or no gate
// ends the run `failed` `gate_unavailable` before any model call.

export const DEFAULT_GATE_MCP_URL = "http://127.0.0.1:8787/mcp";
export const MIN_KEY_LENGTH = 32;

const Environment = z.object({
  COUNTERSIGN_SUPPORT_AGENT_KEY: z.string().optional(),
  GATE_MCP_URL: z.string().optional(),
});

export type ProtectedEnv = {
  /** Null when `GATE_MCP_URL` isn't an http(s) URL. */
  gateUrl: URL | null;
  /** Null when unset or shorter than 32 characters. Never logged, stored or shown. */
  key: string | null;
};

export function parseProtectedEnv(env: Readonly<Record<string, string | undefined>>): ProtectedEnv {
  const parsed = Environment.parse(env);
  const key = parsed.COUNTERSIGN_SUPPORT_AGENT_KEY ?? "";
  const raw = parsed.GATE_MCP_URL?.trim() || DEFAULT_GATE_MCP_URL;
  let gateUrl: URL | null = null;
  if (URL.canParse(raw)) {
    const url = new URL(raw);
    if (url.protocol === "http:" || url.protocol === "https:") gateUrl = url;
  }
  return { gateUrl, key: key.length >= MIN_KEY_LENGTH ? key : null };
}

/** Connects to the gate, or null when there's no key, the key is refused, or no gate answers. */
export async function connectGate(env: ProtectedEnv): Promise<Client | null> {
  if (env.key === null || env.gateUrl === null) return null;
  const client = new Client({ name: "countersign-resolve", version: "0.8.0" });
  const transport = new StreamableHTTPClientTransport(env.gateUrl, {
    requestInit: { headers: { Authorization: `Bearer ${env.key}` } },
  });
  try {
    await client.connect(transport);
    return client;
  } catch {
    // The error isn't kept: a proxy could fill it with anything, the key included.
    await client.close().catch(() => {});
    return null;
  }
}

/** A run's trace as stored: the harness's, marked with its mode. */
export type RunTrace = HarnessTrace & { mode: "protected" | "baseline" };

export type ProtectedRunInput = {
  db: Database;
  runId: string;
  env: ProtectedEnv;
  generateContent: GenerateContent;
  /** Wall-clock time for the run's started and finished times. */
  clock: () => Date;
  /** A monotonic clock in milliseconds, for latency only. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** One line per finished run. Never given a key, token or reply. */
  log?: (line: string) => void;
};

/** Every outcome a run can end with here: the harness's, or the gate's absence. */
export type RunOutcome = HarnessResult["outcome"] | "gate_unavailable";

export class RunNotQueuedError extends Error {
  override readonly name = "RunNotQueuedError";
}

const emptyTrace = (): RunTrace => ({ mode: "protected", tools: [], rewrites: [], steps: [] });

/** Starts a queued protected-mode run, runs it against the gate, and stores how it ended. */
export async function runProtected(input: ProtectedRunInput): Promise<AgentRun> {
  const { db, runId } = input;
  const run = await readRun(db, runId);
  if (run?.status !== "queued" || run.mode !== "protected") {
    throw new RunNotQueuedError(`Run ${runId} isn't a queued protected-mode run.`);
  }
  await startRun(db, runId, input.clock().toISOString());

  const finish = async (
    result: Pick<HarnessResult, "status" | "reply" | "modelVersions"> & {
      outcome: RunOutcome;
    },
    trace: RunTrace,
  ) => {
    await finishRun(db, runId, {
      status: result.status,
      outcome: result.outcome,
      reply: result.reply,
      modelVersions: result.modelVersions,
      trace,
      finishedAt: input.clock().toISOString(),
    });
    input.log?.(`Run ${runId} (protected): ${result.status}, ${result.outcome}.`);
    return (await readRun(db, runId)) as AgentRun;
  };

  const client = await connectGate(input.env);
  if (client === null) {
    return finish(
      { status: "failed", outcome: "gate_unavailable", reply: null, modelVersions: [] },
      emptyTrace(),
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
    return await finish(result, { mode: "protected", ...result.trace });
  } finally {
    await client.close().catch(() => {});
  }
}
