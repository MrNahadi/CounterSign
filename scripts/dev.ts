import { type ChildProcess, spawn } from "node:child_process";
import { createServer as createHttpServer } from "node:http";
import { createRequire } from "node:module";
import { createServer, type Server } from "node:net";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { openDatabase, resolveDatabaseTarget } from "@countersign/db";
import { createPayPalClient } from "@countersign/rail-paypal";
import { createApp } from "../apps/gate/src/app";
import { serve } from "../apps/resolve-agent/src/serve";

const root = join(import.meta.dirname, "..");
const host = "127.0.0.1";
const ports = { gate: 8787, resolve: 8788, console: 3000, storefront: 3001 };
const env = {
  ...process.env,
  GATE_URL: `http://${host}:${ports.gate}`,
  GATE_MCP_URL: `http://${host}:${ports.gate}/mcp`,
  RESOLVE_AGENT_URL: `http://${host}:${ports.resolve}`,
  CONSOLE_PUBLIC_URL: `http://${host}:${ports.console}`,
  STOREFRONT_URL: `http://${host}:${ports.storefront}`,
};
const cleanups: (() => Promise<void>)[] = [];
let stopping: Promise<void> | undefined;

function stop(code: number): Promise<void> {
  stopping ??= (async () => {
    process.exitCode = code;
    while (cleanups.length)
      await cleanups
        .pop()?.()
        .catch(() => {});
  })();
  return stopping;
}

async function available(port: number): Promise<void> {
  const probe = createServer();
  await new Promise<void>((resolve, reject) => {
    probe.once("error", () =>
      reject(new Error(`Port ${port} is already in use. Stop its app first.`)),
    );
    probe.listen(port, host, () => probe.close(() => resolve()));
  });
}

async function listen(server: Server, port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });
}

async function kill(child: ChildProcess): Promise<void> {
  if (!child.pid || child.exitCode !== null) return;
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  if (process.platform === "win32") {
    const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
    await new Promise<void>((resolve) => {
      killer.once("error", () => {
        child.kill();
        resolve();
      });
      killer.once("exit", () => resolve());
    });
  } else {
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      child.kill();
    }
  }
  await exited;
}

function frontend(name: "console" | "storefront"): void {
  const cwd = join(root, "apps", name);
  const require = createRequire(pathToFileURL(join(cwd, "package.json")));
  const next = require.resolve("next/dist/bin/next");
  const child = spawn(
    process.execPath,
    [
      next,
      "dev",
      ...(process.platform === "win32" ? ["--webpack"] : []),
      "--hostname",
      host,
      "--port",
      String(ports[name]),
    ],
    {
      cwd,
      env: { ...env, PORT: String(ports[name]), NEXT_TELEMETRY_DISABLED: "1" },
      stdio: "inherit",
      windowsHide: true,
      detached: process.platform !== "win32",
    },
  );
  cleanups.push(() => kill(child));
  child.once("error", () => {
    console.error(`${name} could not start.`);
    void stop(1);
  });
  child.once("exit", (code) => {
    if (!stopping) {
      console.error(`${name} stopped; shutting down the other apps.`);
      void stop(code ?? 1);
    }
  });
}

async function main(): Promise<void> {
  for (const port of Object.values(ports)) await available(port);
  const handle = await openDatabase(resolveDatabaseTarget(env, undefined));
  cleanups.push(() => handle.close());
  if (handle.kind === "postgres") await handle.migrate();
  console.log(`Local database ready (${handle.kind}).`);

  const resolve = await serve({ ...env, PORT: String(ports.resolve) }, { database: handle, host });
  cleanups.push(resolve.close);
  const gate = createApp({
    db: handle.db,
    env,
    rail: () => createPayPalClient({ env }),
    log: (line) => console.error(line),
  });
  const server = createHttpServer(gate);
  await listen(server, ports.gate);
  cleanups.push(
    () =>
      new Promise<void>((done) => {
        server.closeAllConnections();
        server.close(() => done());
      }),
  );
  frontend("console");
  frontend("storefront");
  console.log(`Console: ${env.CONSOLE_PUBLIC_URL}`);
  console.log(`Storefront: ${env.STOREFRONT_URL}`);
  console.log("Gate and Resolve share one database. Ctrl+C stops every app.");
}

process.once("SIGINT", () => void stop(0));
process.once("SIGTERM", () => void stop(0));
await main().catch(async (error: unknown) => {
  // Dependency errors may contain credentials. Only our fixed port message is safe to display.
  const message = error instanceof Error ? error.message : "";
  console.error(
    /^Port \d+ is already in use\./.test(message)
      ? message
      : "Local startup failed. Check the database configuration and installed dependencies.",
  );
  await stop(1);
});
