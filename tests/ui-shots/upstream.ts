import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Fixtures } from "./fixtures";

// The fake gate (:4511) and fake Resolve (:4512) the console talks to while the harness shoots.
// Each GET path the console calls answers its fixture, and the gate's two pairing POSTs answer
// a fresh code and a refused trade; anything else answers 404 and is logged,
// so a screen that asks for something the fixtures don't hold shows up in the run's output.

export const GATE_PORT = 4511;
export const RESOLVE_PORT = 4512;
const HOST = "127.0.0.1";

/** The approver key the harness signs in with: printable, 49 characters. */
export const HARNESS_KEY = `ui-shots-${"k".repeat(40)}`;

const NOT_IN_FIXTURES = { message: "Not in the ui-shots fixtures." };

type Reply = { status: number; type: string; body: string | Uint8Array };

const json = (status: number, value: unknown): Reply => ({
  status,
  type: "application/json",
  body: JSON.stringify(value),
});

const segments = (path: string): string[] => path.split("/").filter((part) => part !== "");

/** The gate's answer for a GET path, or null when the fixtures don't hold one. */
function gateReply(fx: Fixtures, path: string): Reply | null {
  const parts = segments(path);
  if (path === "/approvals") return json(200, fx.approvals);
  if (path === "/audit/decisions") return json(200, fx.decisions);
  if (path === "/audit/entries") return json(200, fx.entries);
  if (path === "/audit/verify") return json(200, fx.verify);
  if (path === "/audit/visitors") return json(200, fx.visitors);
  if (parts.length === 3 && parts[0] === "audit" && parts[1] === "decisions") {
    const detail = fx.decision[parts[2] ?? ""];
    return detail === undefined ? null : json(200, detail);
  }
  if (parts.length === 3 && parts[0] === "audit" && parts[1] === "intents") {
    return json(200, fx.intent);
  }
  return null;
}

/** A pairing code the start page's QR link carries: 22 URL-safe characters, as the gate mints. */
export const HARNESS_PAIRING_CODE = "uishots-pairing-code-1";

/** The gate's sentence for a used or expired pairing code (apps/gate/src/pairing.ts). */
export const PAIRING_REFUSED = "That code has expired or was used. Sign in with the approver key.";

/** The gate's pairing answers: a fresh code for the key, and every trade refused as used. */
function gatePost(path: string): Reply | null {
  if (path === "/approvals/pairing-codes") return json(201, { code: HARNESS_PAIRING_CODE });
  if (path === "/approvals/pair") return json(401, { message: PAIRING_REFUSED });
  return null;
}

/** The one gate path that takes no key: the phone trades its code before it has one. */
const OPEN_GATE_PATHS = new Set(["/approvals/pair"]);

/** Resolve's answer for a GET path, or null when the fixtures don't hold one. */
function resolveReply(fx: Fixtures, path: string): Reply | null {
  const parts = segments(path);
  if (path === "/threads") return json(200, fx.threads);
  if (path === "/disputes") return json(200, fx.disputes);
  if (parts.length === 2 && parts[0] === "threads") {
    const detail = fx.thread[parts[1] ?? ""];
    return detail === undefined ? null : json(200, detail);
  }
  if (parts.length === 2 && parts[0] === "attachments") {
    return { status: 200, type: "image/png", body: fx.photo };
  }
  return null;
}

function send(response: ServerResponse, reply: Reply): void {
  response.writeHead(reply.status, {
    "content-type": reply.type,
    "cache-control": "no-store",
  });
  response.end(reply.body);
}

function handler(
  answer: (path: string) => Reply | null,
  authorized: (request: IncomingMessage, path: string) => boolean,
  post: (path: string) => Reply | null = () => null,
) {
  return (request: IncomingMessage, response: ServerResponse) => {
    const method = request.method ?? "GET";
    // Query strings are ignored: `before` answers the same page, and filters show the fixtures.
    const path = new URL(request.url ?? "/", `http://${HOST}`).pathname;
    request.resume();
    if (!authorized(request, path)) {
      send(response, json(401, { message: "Sign in again." }));
      return;
    }
    const reply = method === "GET" ? answer(path) : method === "POST" ? post(path) : null;
    if (reply === null) {
      process.stderr.write(`upstream: no fixture for ${method} ${path}\n`);
      send(response, json(404, NOT_IN_FIXTURES));
      return;
    }
    send(response, reply);
  };
}

function listen(server: Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, HOST, () => {
      server.off("error", reject);
      resolve();
    });
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve) => {
    if (!server.listening) {
      resolve();
      return;
    }
    server.closeAllConnections();
    server.close(() => resolve());
  });
}

/** Starts both fakes; `close()` stops them. */
export async function startUpstream(
  fx: Fixtures,
): Promise<{ gateUrl: string; resolveUrl: string; close(): Promise<void> }> {
  const gate = createServer(
    handler(
      (path) => gateReply(fx, path),
      (request, path) =>
        OPEN_GATE_PATHS.has(path) || request.headers.authorization === `Bearer ${HARNESS_KEY}`,
      gatePost,
    ),
  );
  const resolve = createServer(
    handler(
      (path) => resolveReply(fx, path),
      () => true,
    ),
  );
  const stop = async () => {
    await Promise.all([close(gate), close(resolve)]);
  };
  try {
    await listen(gate, GATE_PORT);
    await listen(resolve, RESOLVE_PORT);
  } catch (error) {
    await stop();
    throw error;
  }
  return {
    gateUrl: `http://${HOST}:${GATE_PORT}`,
    resolveUrl: `http://${HOST}:${RESOLVE_PORT}`,
    close: stop,
  };
}
