import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  type DatabaseHandle,
  type Environment,
  markUnfinishedDraftsInterrupted,
  markUnfinishedRunsInterrupted,
  openDatabase,
  resolveDatabaseTarget,
} from "@countersign/db";
import { z } from "zod";
import { createApp } from "./app";
import { paypalTokenIssuer } from "./baseline";
import { parseDailyCap } from "./limits";
import { createGenerateContent, DEFAULT_MODEL, parseModelEnv } from "./model";
import { parseProtectedEnv } from "./protected";
import { createModeRunner, createRunQueue } from "./queue";

// Resolve's process: the database the CLIs use, the model, the gate's address and key, and the
// PayPal variables for baseline mode, all from the environment. With none of them set it still
// answers /health: messages answer 503 without a database, and runs end `not_configured`
// without a Gemini key. Lines name variables, never their values.

export const DEFAULT_PORT = 8788;

const PortSchema = z.coerce.number().int().min(0).max(65_535);

/** `PORT`, or 8788 when unset or blank. Throws, naming the variable, for anything else. */
export function parsePort(env: Environment): number {
  const raw = env.PORT?.trim();
  if (raw === undefined || raw === "") return DEFAULT_PORT;
  const parsed = PortSchema.safeParse(raw);
  if (!parsed.success) throw new Error("PORT must be a port number from 0 to 65535.");
  return parsed.data;
}

export type ServeOptions = {
  /** The PGlite directory when `DATABASE_URL` is unset. Defaults to `.countersign/pglite`. */
  pgliteDir?: string;
  log?: (line: string) => void;
  /** The host to bind. `0.0.0.0` unless a test says otherwise. */
  host?: string;
};

export type Serving = { server: Server; port: number; close: () => Promise<void> };

export async function serve(env: Environment, options: ServeOptions = {}): Promise<Serving> {
  const log = options.log ?? ((line: string) => console.error(line));
  const port = parsePort(env);
  const dailyCap = parseDailyCap(env);

  let handle: DatabaseHandle | undefined;
  try {
    handle = await openDatabase(resolveDatabaseTarget(env, options.pgliteDir));
  } catch {
    log("resolve-agent started without a database; messages will answer 503.");
  }

  if (handle) {
    // Runs the last process left queued or running may have moved money: failed, never rerun.
    const swept = await markUnfinishedRunsInterrupted(handle.db, new Date().toISOString());
    if (swept > 0) log(`${swept} unfinished ${swept === 1 ? "run" : "runs"} marked interrupted.`);
    // Drafts the same: one may have proposed evidence already, so it's failed, never rerun.
    const drafts = await markUnfinishedDraftsInterrupted(handle.db, new Date().toISOString());
    if (drafts > 0)
      log(`${drafts} unfinished ${drafts === 1 ? "draft" : "drafts"} marked interrupted.`);
  }

  const modelEnv = parseModelEnv(env);
  if (!modelEnv.ok) {
    for (const line of modelEnv.missing.length > 0
      ? [`Unset: ${modelEnv.missing.join(", ")}. Runs end not_configured.`]
      : modelEnv.problems)
      log(line);
  }
  const model = modelEnv.ok ? modelEnv.config.model : env.GEMINI_MODEL || DEFAULT_MODEL;
  const generateContent = modelEnv.ok ? createGenerateContent(modelEnv.config.apiKey) : null;

  const protectedEnv = parseProtectedEnv(env);
  if (protectedEnv.key === null)
    log(
      "COUNTERSIGN_SUPPORT_AGENT_KEY is unset (needs 32 or more characters). Protected runs end gate_unavailable.",
    );

  const queue = handle
    ? createRunQueue(
        createModeRunner({
          db: handle.db,
          generateContent,
          protectedEnv,
          issueToken: paypalTokenIssuer(env),
          clock: () => new Date(),
          fallbackModel: modelEnv.ok ? modelEnv.config.fallbackModel : null,
          log,
        }),
        log,
      )
    : createRunQueue(async () => {}, log);

  const app = createApp({ ...(handle ? { db: handle.db } : {}), model, queue, dailyCap, log });
  const server = app.listen(port, options.host ?? "0.0.0.0");
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  const bound = (server.address() as AddressInfo).port;
  log(`resolve-agent listening on port ${bound}`);
  return {
    server,
    port: bound,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await queue.idle();
      await handle?.close().catch(() => {});
    },
  };
}
