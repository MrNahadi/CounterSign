import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createTestDatabase, type Database, type DatabaseHandle } from "@countersign/db";
import express, { type Express } from "express";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { type AppDeps, createApp } from "../src/app";
import { mountApprovals } from "../src/approvals-api";
import { APPROVER_KEY_VAR, loadApprover } from "../src/approver";
import {
  MAX_PAIRING_CODES,
  PAIR_PATH,
  PAIRING_CODES_PATH,
  PAIRING_MESSAGES,
  PAIRING_TTL_MS,
} from "../src/pairing";
import { SUPPORT_AGENT_KEY_VAR } from "../src/principals";

// Phone pairing (ADR 0044) through `createApp`, so the mount order before the approval API is
// tested too. A fixed, movable clock; illustrative keys.

const SLOW = 60_000;
const START = new Date("2026-11-01T09:00:00Z").getTime();
const APPROVER_KEY = "approver-key-illustrative-0123456789abcd";
const AGENT_KEY = "agent-key-illustrative-0123456789abcdef";
const ENV = { [APPROVER_KEY_VAR]: APPROVER_KEY, [SUPPORT_AGENT_KEY_VAR]: AGENT_KEY };

let servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.map((s) => new Promise((resolve) => s.close(resolve))));
  servers = [];
  vi.restoreAllMocks();
});

async function listen(app: Express): Promise<string> {
  const server = createServer(app);
  servers.push(server);
  server.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

function gate(deps: Partial<AppDeps> = {}) {
  let now = START;
  const logged: string[] = [];
  const url = listen(
    createApp({
      env: ENV,
      clock: () => new Date(now),
      log: (line) => logged.push(line),
      ...deps,
    }),
  );
  return {
    url,
    logged,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

type Reply = { status: number; text: string; body: unknown; headers: Headers };

async function post(url: string, body?: string, key?: string): Promise<Reply> {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      ...(key === undefined ? {} : { Authorization: `Bearer ${key}` }),
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(body === undefined ? {} : { body }),
  });
  const text = await res.text();
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = null;
  }
  return { status: res.status, text, body: parsed, headers: res.headers };
}

async function get(url: string, key?: string): Promise<Reply> {
  const res = await fetch(url, {
    headers: key === undefined ? {} : { Authorization: `Bearer ${key}` },
  });
  const text = await res.text();
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = null;
  }
  return { status: res.status, text, body: parsed, headers: res.headers };
}

const mint = async (base: string) => {
  const reply = await post(`${base}${PAIRING_CODES_PATH}`, undefined, APPROVER_KEY);
  expect(reply.status).toBe(201);
  return (reply.body as { code: string; expires_at: string }).code;
};

const pair = (base: string, code: unknown) => post(`${base}${PAIR_PATH}`, JSON.stringify({ code }));

const refused = (reply: Reply) => {
  expect(reply.status).toBe(401);
  expect(reply.body).toEqual({ message: PAIRING_MESSAGES.refused });
  expect(reply.text).not.toContain(APPROVER_KEY);
};

describe("minting a pairing code", () => {
  it("needs the approver key and answers 201 with a 22-character base64url code and its expiry", async () => {
    const g = gate();
    const base = await g.url;
    const reply = await post(`${base}${PAIRING_CODES_PATH}`, undefined, APPROVER_KEY);
    expect(reply.status).toBe(201);
    const body = reply.body as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["code", "expires_at"]);
    expect(body.code).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(body.expires_at).toBe(new Date(START + PAIRING_TTL_MS).toISOString());
    expect(reply.text).not.toContain(APPROVER_KEY);
    expect(reply.headers.get("cache-control")).toBe("no-store");

    // A JSON body, as the console sends, is ignored.
    const withBody = await post(`${base}${PAIRING_CODES_PATH}`, "{}", APPROVER_KEY);
    expect(withBody.status).toBe(201);
    expect((withBody.body as { code: string }).code).not.toBe(body.code);
  });

  it("is 401 without the approver key, or with a principal key", async () => {
    const base = await gate().url;
    for (const key of [undefined, AGENT_KEY, "not-the-key-0123456789abcdefghijkl"]) {
      const reply = await post(`${base}${PAIRING_CODES_PATH}`, undefined, key);
      expect(reply.status).toBe(401);
      expect(reply.body).toEqual({ message: "A valid approver key is required." });
    }
  });

  it("is 401 when the gate has no approver key", async () => {
    const base = await gate({ env: { [SUPPORT_AGENT_KEY_VAR]: AGENT_KEY } }).url;
    const reply = await post(`${base}${PAIRING_CODES_PATH}`, undefined, APPROVER_KEY);
    expect(reply.status).toBe(401);
  });
});

describe("trading a pairing code", () => {
  it("trades a valid code once, with no key, for the approver key", async () => {
    const g = gate();
    const base = await g.url;
    const code = await mint(base);
    const first = await pair(base, code);
    expect(first.status).toBe(200);
    expect(first.body).toEqual({ approver_key: APPROVER_KEY });
    expect(first.headers.get("cache-control")).toBe("no-store");
    refused(await pair(base, code));
  });

  it("refuses an expired code, and takes one just inside its five minutes", async () => {
    const g = gate();
    const base = await g.url;
    const inside = await mint(base);
    const late = await mint(base);
    g.advance(PAIRING_TTL_MS - 1);
    expect((await pair(base, inside)).status).toBe(200);
    g.advance(1);
    refused(await pair(base, late));
  });

  it("refuses an unknown or malformed code, and a body that isn't the JSON", async () => {
    const base = await gate().url;
    await mint(base);
    refused(await pair(base, "AAAAAAAAAAAAAAAAAAAAAA"));
    for (const code of ["short", "A".repeat(23), "AAAAAAAAAAAAAAAAAAAAA=", 42, null]) {
      refused(await pair(base, code));
    }
    refused(await post(`${base}${PAIR_PATH}`, "not json"));
    refused(await post(`${base}${PAIR_PATH}`, JSON.stringify({ code: "A".repeat(22), x: 1 })));
    refused(await post(`${base}${PAIR_PATH}`, JSON.stringify({ code: "A".repeat(2000) })));
    refused(await post(`${base}${PAIR_PATH}`));
  });

  it("refuses a code minted on another gate", async () => {
    const one = await gate().url;
    const two = await gate().url;
    refused(await pair(two, await mint(one)));
  });

  it("holds at most 50 live codes, dropping the soonest to expire", async () => {
    const g = gate();
    const base = await g.url;
    const codes: string[] = [];
    for (let i = 0; i <= MAX_PAIRING_CODES; i += 1) {
      codes.push(await mint(base));
      g.advance(1);
    }
    expect(MAX_PAIRING_CODES).toBe(50);
    refused(await pair(base, codes[0]));
    for (const code of codes.slice(1)) expect((await pair(base, code)).status).toBe(200);
  });

  it("writes no code or key to any log line", async () => {
    const lines: string[] = [];
    const capture = (...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
    };
    for (const method of ["log", "info", "warn", "error", "debug"] as const) {
      vi.spyOn(console, method).mockImplementation(capture);
    }
    const g = gate();
    const base = await g.url;
    const code = await mint(base);
    await pair(base, code);
    await pair(base, code);
    await pair(base, "nope");
    await post(`${base}${PAIR_PATH}`, "not json");
    for (const line of [...lines, ...g.logged]) {
      expect(line).not.toContain(code);
      expect(line).not.toContain(APPROVER_KEY);
    }
  });
});

describe("the approval API beside pairing", { timeout: SLOW }, () => {
  let handle: DatabaseHandle;
  let db: Database;

  beforeAll(async () => {
    handle = await createTestDatabase();
    db = handle.db;
  }, SLOW);

  afterAll(async () => {
    await handle.close();
  });

  // The approval API alone, as it was mounted before pairing existed.
  const approvalsOnly = () => {
    const app = express();
    mountApprovals(app, {
      approver: loadApprover(ENV),
      db,
      mandates: [],
      clock: () => new Date(START),
    });
    return listen(app);
  };

  it("answers GET and POST /approvals/<id> exactly as before", async () => {
    const before = await approvalsOnly();
    const after = await gate({ db }).url;
    const answer = JSON.stringify({ answer: "approve", intent_hash: "a".repeat(64) });
    const requests: [string, (base: string) => Promise<Reply>][] = [
      ["GET a step-up", (b) => get(`${b}/approvals/7`, APPROVER_KEY)],
      ["GET a step-up, no key", (b) => get(`${b}/approvals/7`)],
      ["GET /approvals/pair", (b) => get(`${b}/approvals/pair`, APPROVER_KEY)],
      ["GET /approvals/pairing-codes", (b) => get(`${b}/approvals/pairing-codes`, APPROVER_KEY)],
      ["GET the list", (b) => get(`${b}/approvals`, APPROVER_KEY)],
      ["POST an answer", (b) => post(`${b}/approvals/7`, answer, APPROVER_KEY)],
      ["POST an answer, no key", (b) => post(`${b}/approvals/7`, answer)],
      ["POST a bad body", (b) => post(`${b}/approvals/7`, "{}", APPROVER_KEY)],
      ["POST to a bad ID", (b) => post(`${b}/approvals/abc`, answer, APPROVER_KEY)],
    ];
    for (const [name, send] of requests) {
      const was = await send(before);
      const now = await send(after);
      expect({ name, status: now.status, body: now.body }).toEqual({
        name,
        status: was.status,
        body: was.body,
      });
    }
  });
});
