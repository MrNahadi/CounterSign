import type { Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createTestDatabase, type DatabaseHandle, listThreads } from "@countersign/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import type { RunQueue } from "../src/queue";
import { serve } from "../src/serve";
import {
  MIN_SHARED_SECRET_LENGTH,
  parseSharedSecret,
  SHARED_SECRET_HEADER,
  SHARED_SECRET_REFUSAL,
  secretMatches,
} from "../src/shared-secret";
import { TEST_SECRET } from "./secret";

// PLAN.md F2: Resolve is public on Render's free plan, so every route but `/health` needs the
// shared secret. Without it, or with a wrong one, Resolve answers 401 and stores nothing. The
// people are illustrative and every message is simulated.

const EMAIL = {
  channel: "email",
  sender_email: "amina.k@example.com",
  subject: "Coaster set KIK-1035",
  body: "My coaster set hasn't arrived.",
};

let handle: DatabaseHandle;
let servers: HttpServer[];
let queued: string[];

const queue: RunQueue = {
  enqueue: (runId) => {
    queued.push(runId);
  },
  idle: async () => {},
};

async function listen(sharedSecret: string | null): Promise<string> {
  const server = createApp({
    db: handle.db,
    sharedSecret,
    model: "gemini-3.5-flash-lite",
    queue,
  }).listen(0, "127.0.0.1");
  servers.push(server);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

const postMessage = (base: string, headers: Record<string, string>, body = JSON.stringify(EMAIL)) =>
  fetch(`${base}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body,
  });

// Every route Resolve has, plus one it doesn't: each needs the secret.
const ROUTES: [string, string][] = [
  ["POST", "/messages"],
  ["POST", "/scenarios/lost-parcel"],
  ["POST", "/disputes"],
  ["GET", "/disputes"],
  ["GET", "/disputes/PP-D-1"],
  ["GET", "/threads"],
  ["GET", "/threads/tkt_nope"],
  ["GET", `/attachments/att_${"0".repeat(32)}`],
  ["GET", "/nowhere"],
];

const WRONG: [string, Record<string, string>][] = [
  ["no header", {}],
  ["an empty header", { [SHARED_SECRET_HEADER]: "" }],
  ["a wrong secret of the same length", { [SHARED_SECRET_HEADER]: "x".repeat(TEST_SECRET.length) }],
  ["the secret with a character missing", { [SHARED_SECRET_HEADER]: TEST_SECRET.slice(0, -1) }],
  ["the secret with a character added", { [SHARED_SECRET_HEADER]: `${TEST_SECRET}0` }],
  ["the secret in a different header", { authorization: `Bearer ${TEST_SECRET}` }],
];

beforeEach(async () => {
  handle = await createTestDatabase();
  servers = [];
  queued = [];
});

afterEach(async () => {
  for (const server of servers) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  await handle.close();
});

describe("parseSharedSecret", () => {
  it("takes a trimmed secret of 32 or more characters", () => {
    expect(MIN_SHARED_SECRET_LENGTH).toBe(32);
    // The gate's and the console's tests pin the same name for the header they send.
    expect(SHARED_SECRET_HEADER).toBe("x-countersign-resolve-secret");
    expect(parseSharedSecret({ RESOLVE_SHARED_SECRET: ` ${TEST_SECRET} ` })).toBe(TEST_SECRET);
    expect(parseSharedSecret({ RESOLVE_SHARED_SECRET: "a".repeat(32) })).toBe("a".repeat(32));
  });

  it("is null when unset, blank or too short", () => {
    expect(parseSharedSecret({})).toBeNull();
    expect(parseSharedSecret({ RESOLVE_SHARED_SECRET: "   " })).toBeNull();
    expect(parseSharedSecret({ RESOLVE_SHARED_SECRET: "a".repeat(31) })).toBeNull();
  });
});

describe("secretMatches", () => {
  it("matches only the exact secret", () => {
    expect(secretMatches(TEST_SECRET, TEST_SECRET)).toBe(true);
    expect(secretMatches(TEST_SECRET, TEST_SECRET.toUpperCase())).toBe(false);
    expect(secretMatches(TEST_SECRET, `${TEST_SECRET} `)).toBe(false);
    expect(secretMatches(TEST_SECRET, "")).toBe(false);
    expect(secretMatches(TEST_SECRET, undefined)).toBe(false);
    expect(secretMatches(TEST_SECRET, [TEST_SECRET])).toBe(false);
  });

  it("matches nothing when Resolve has no secret", () => {
    expect(secretMatches(null, TEST_SECRET)).toBe(false);
    expect(secretMatches(null, "")).toBe(false);
  });
});

describe("Resolve's HTTP API with a shared secret", () => {
  it("keeps /health open without the secret", async () => {
    const base = await listen(TEST_SECRET);
    const res = await fetch(`${base}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it.each(WRONG)("answers 401 to a message with %s and stores nothing", async (_, headers) => {
    const base = await listen(TEST_SECRET);
    const res = await postMessage(base, headers);
    expect(res.status).toBe(401);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ message: SHARED_SECRET_REFUSAL });
    expect(text).not.toContain(TEST_SECRET);
    expect(await listThreads(handle.db)).toEqual([]);
    expect(queued).toEqual([]);
  });

  it.each(ROUTES)("answers 401 to %s %s without the secret", async (method, path) => {
    const base = await listen(TEST_SECRET);
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { "content-type": "application/json" },
      ...(method === "POST" ? { body: JSON.stringify({ dispute_id: "PP-D-1" }) } : {}),
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ message: SHARED_SECRET_REFUSAL });
    expect(queued).toEqual([]);
  });

  it("refuses before reading the body, so a bad body without the secret is 401, not 400", async () => {
    const base = await listen(TEST_SECRET);
    expect((await postMessage(base, {}, "not json")).status).toBe(401);
    expect((await postMessage(base, {}, "x".repeat(11 * 1024 * 1024))).status).toBe(401);
    expect(await listThreads(handle.db)).toEqual([]);
  });

  it("takes a message with the right secret, and reads it back with it", async () => {
    const base = await listen(TEST_SECRET);
    const res = await postMessage(base, { [SHARED_SECRET_HEADER]: TEST_SECRET });
    expect(res.status).toBe(202);
    const { thread_id } = (await res.json()) as { thread_id: string };
    expect(await listThreads(handle.db)).toHaveLength(1);
    expect(queued).toHaveLength(1);
    const thread = await fetch(`${base}/threads/${thread_id}`, {
      headers: { [SHARED_SECRET_HEADER]: TEST_SECRET },
    });
    expect(thread.status).toBe(200);
    expect((await fetch(`${base}/threads/${thread_id}`)).status).toBe(401);
  });

  it("takes no one's calls when it has no secret of its own", async () => {
    const base = await listen(null);
    expect((await fetch(`${base}/health`)).status).toBe(200);
    const tries: Record<string, string>[] = [{}, { [SHARED_SECRET_HEADER]: TEST_SECRET }];
    for (const headers of tries) {
      expect((await postMessage(base, headers)).status).toBe(401);
      expect((await fetch(`${base}/threads`, { headers })).status).toBe(401);
    }
    expect(await listThreads(handle.db)).toEqual([]);
    expect(queued).toEqual([]);
  });
});

describe("serve", () => {
  it("reads RESOLVE_SHARED_SECRET and refuses calls without it", async () => {
    const lines: string[] = [];
    const serving = await serve(
      { PORT: "0", RESOLVE_SHARED_SECRET: TEST_SECRET },
      { database: handle, host: "127.0.0.1", log: (line) => lines.push(line) },
    );
    try {
      const base = `http://127.0.0.1:${serving.port}`;
      expect((await fetch(`${base}/health`)).status).toBe(200);
      expect((await postMessage(base, {})).status).toBe(401);
      expect((await postMessage(base, { [SHARED_SECRET_HEADER]: TEST_SECRET })).status).toBe(202);
    } finally {
      await serving.close();
    }
    expect(lines.join("\n")).not.toMatch(/RESOLVE_SHARED_SECRET/);
  });

  it("logs a missing or short secret by name, never by value, and takes no calls", async () => {
    const short = "short-illustrative-secret";
    for (const env of [{ PORT: "0" }, { PORT: "0", RESOLVE_SHARED_SECRET: short }]) {
      const lines: string[] = [];
      const serving = await serve(env, {
        database: handle,
        host: "127.0.0.1",
        log: (line) => lines.push(line),
      });
      try {
        const base = `http://127.0.0.1:${serving.port}`;
        expect((await fetch(`${base}/health`)).status).toBe(200);
        expect((await postMessage(base, { [SHARED_SECRET_HEADER]: short })).status).toBe(401);
      } finally {
        await serving.close();
      }
      expect(lines).toContain(
        "RESOLVE_SHARED_SECRET is unset (needs 32 or more characters). Every route but /health answers 401.",
      );
      expect(lines.join("\n")).not.toContain(short);
    }
    expect(await listThreads(handle.db)).toEqual([]);
  });
});
