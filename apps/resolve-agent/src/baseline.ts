import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { AgentRun } from "@countersign/db";
import { createPayPalClient } from "@countersign/rail-paypal";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { z } from "zod";
import { executeRun, type ModeRunInput } from "./runs";

// Baseline mode (ADRs 0011 and 0031): the same harness wired straight to PayPal's own MCP
// server, with no gate. Each run mints a fresh sandbox token and spawns `@paypal/mcp
// --tools=all` from the `apps/baseline-paypal-mcp` workspace over stdio. Nothing here imports
// PayPal's packages: the entry point is resolved as a file path and run as a child process.
// Baseline runs write nothing to the audit log; their tool calls are in the run's trace.

export type IssuedToken = { accessToken: string; expiresAt: number };

/** Mints a fresh sandbox access token. Rejects when it can't. */
export type TokenIssuer = () => Promise<IssuedToken>;

/** How the child is started. `env` holds the token: never log, store or show it. */
export type BaselineServer = {
  command: string;
  args: string[];
  env: Record<string, string>;
  stderr: "ignore";
};

export type TransportFactory = (server: BaselineServer) => Transport;

const Manifest = z.object({ bin: z.string().min(1) });

/** The file path of `@paypal/mcp`'s entry point, as installed for `apps/baseline-paypal-mcp`. */
export function paypalMcpEntry(): string {
  const workspace = createRequire(import.meta.url).resolve(
    "@countersign/baseline-paypal-mcp/package.json",
  );
  const manifestPath = createRequire(workspace).resolve("@paypal/mcp/package.json");
  const { bin } = Manifest.parse(JSON.parse(readFileSync(manifestPath, "utf8")));
  return join(dirname(manifestPath), bin);
}

/** The child for one run: Node itself, PayPal's entry point, every tool, the token in env only. */
export function baselineServer(accessToken: string, entry = paypalMcpEntry()): BaselineServer {
  return {
    command: process.execPath,
    args: [entry, "--tools=all"],
    env: {
      ...getDefaultEnvironment(),
      PAYPAL_ACCESS_TOKEN: accessToken,
      PAYPAL_ENVIRONMENT: "SANDBOX",
    },
    stderr: "ignore",
  };
}

export const stdioTransport: TransportFactory = (server) => new StdioClientTransport(server);

/** A token issuer on the sandbox-only PayPal client, built from the PayPal variables. */
export function paypalTokenIssuer(env: Readonly<Record<string, string | undefined>>): TokenIssuer {
  return () => createPayPalClient({ env }).issueAccessToken();
}

/** Mints a token, starts PayPal's server and connects, or null when any step fails. */
export async function connectBaseline(
  issueToken: TokenIssuer,
  createTransport: TransportFactory,
): Promise<Client | null> {
  let transport: Transport | undefined;
  const client = new Client({ name: "countersign-resolve", version: "0.8.0" });
  try {
    const { accessToken } = await issueToken();
    transport = createTransport(baselineServer(accessToken));
    await client.connect(transport);
    return client;
  } catch {
    // The error isn't kept: it could carry the token or PayPal's answer.
    await client.close().catch(() => {});
    await transport?.close().catch(() => {});
    return null;
  }
}

export type BaselineRunInput = ModeRunInput & {
  issueToken: TokenIssuer;
  /** Starts the child. Defaults to the MCP SDK's stdio transport. */
  createTransport?: TransportFactory;
};

/** Starts a queued baseline-mode run against PayPal's own server, and stores how it ended. */
export function runBaseline(input: BaselineRunInput): Promise<AgentRun> {
  const createTransport = input.createTransport ?? stdioTransport;
  return executeRun(
    input,
    "baseline",
    () => connectBaseline(input.issueToken, createTransport),
    "baseline_unavailable",
  );
}
