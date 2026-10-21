import type { AgentRun } from "@countersign/db";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { z } from "zod";
import { executeRun, type ModeRunInput } from "./runs";

export { RunNotQueuedError, type RunOutcome, type RunTrace } from "./runs";

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

export type ProtectedRunInput = ModeRunInput & { env: ProtectedEnv };

/** Starts a queued protected-mode run, runs it against the gate, and stores how it ended. */
export function runProtected(input: ProtectedRunInput): Promise<AgentRun> {
  return executeRun(input, "protected", () => connectGate(input.env), "gate_unavailable");
}
