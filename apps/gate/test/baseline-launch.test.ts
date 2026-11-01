import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type AppDeps, createApp } from "../src/app";
import { APPROVAL_MESSAGES } from "../src/approvals-api";
import { APPROVER_KEY_VAR } from "../src/approver";
import { BASELINE_LAUNCH_MESSAGES, BASELINE_LAUNCH_PATH } from "../src/baseline-launch";
import { OPS_AGENT_KEY_VAR, SUPPORT_AGENT_KEY_VAR } from "../src/principals";
import { createFakeSandbox } from "./fake-sandbox";

// POST /baseline/launch on a listening createApp (T-010), with a fake Resolve on 127.0.0.1 that
// records what it receives. Illustrative keys and tokens.

const APPROVER_KEY = "approver-key-illustrative-0123456789abcd";
const SUPPORT_KEY = "support-key-illustrative-0123456789abcde";
const OPS_KEY = "ops-key-illustrative-0123456789abcdefgh";
const TOKEN = "A21AA-illustrative-sandbox-access-token-0123456789";
const EXPIRES_AT = Date.parse("2026-10-20T20:00:00.000Z");
const THREAD = `tkt_${"a".repeat(32)}`;
const ACCEPTED = { ticket_id: THREAD, thread_id: THREAD, run_id: "run_illustrative_1" };

type Received = { url: string; method: string; headers: IncomingMessage["headers"]; body: unknown };
type FakeResolve = {
  url: string;
  received: Received[];
  answer: { status: number; body: string; headers?: Record<string, string> };
};

let servers: Server[] = [];
let logLines: string[] = [];
let consoleSpies: { mock: { calls: unknown[][] }; mockRestore: () => void }[] = [];

beforeEach(() => {
  logLines = [];
  consoleSpies = (["log", "info", "warn", "error", "debug"] as const).map((name) =>
    vi.spyOn(console, name).mockImplementation(() => {}),
  );
});

afterEach(async () => {
  for (const server of servers) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  servers = [];
  for (const spy of consoleSpies) spy.mockRestore();
});

async function listenOn(server: Server): Promise<string> {
  servers.push(server);
  server.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

async function fakeResolve(): Promise<FakeResolve> {
  const fake: FakeResolve = {
    url: "",
    received: [],
    answer: { status: 202, body: JSON.stringify(ACCEPTED) },
  };
  const server = createServer((req, res) => {
    let raw = "";
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => {
      raw += chunk;
    });
    req.on("end", () => {
      fake.received.push({
        url: req.url ?? "",
        method: req.method ?? "",
        headers: req.headers,
        body: JSON.parse(raw),
      });
      res.writeHead(fake.answer.status, {
        "content-type": "application/json",
        ...fake.answer.headers,
      });
      res.end(fake.answer.body);
    });
  });
  fake.url = await listenOn(server);
  return fake;
}

const env = (resolveUrl: string | undefined) => ({
  [APPROVER_KEY_VAR]: APPROVER_KEY,
  [SUPPORT_AGENT_KEY_VAR]: SUPPORT_KEY,
  [OPS_AGENT_KEY_VAR]: OPS_KEY,
  ...(resolveUrl === undefined ? {} : { RESOLVE_AGENT_URL: resolveUrl }),
});

let tokensIssued = 0;
const tokenRail = () => {
  const sandbox = createFakeSandbox();
  sandbox.issueAccessToken = async () => {
    tokensIssued += 1;
    return { accessToken: TOKEN, expiresAt: EXPIRES_AT };
  };
  return sandbox;
};

async function gate(deps: Partial<AppDeps> & { resolveUrl?: string }): Promise<string> {
  const { resolveUrl, ...rest } = deps;
  const app = createApp({
    env: env(resolveUrl),
    rail: tokenRail,
    log: (line) => logLines.push(line),
    ...rest,
  });
  return listenOn(createServer(app));
}

const launch = async (base: string, body: unknown, key: string | null = APPROVER_KEY) => {
  const res = await fetch(`${base}${BASELINE_LAUNCH_PATH}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(key ? { Authorization: `Bearer ${key}` } : {}),
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, text, body: JSON.parse(text) as Record<string, unknown> };
};

// Every line the gate wrote, through its log or the console.
const allLogged = () =>
  [
    ...logLines,
    ...consoleSpies.flatMap((spy) => spy.mock.calls.map((call) => call.map(String).join(" "))),
  ].join("\n");

beforeEach(() => {
  tokensIssued = 0;
});

describe("POST /baseline/launch", () => {
  it("is 401 without the approver key, and with a principal key, before minting or calling Resolve", async () => {
    const resolve = await fakeResolve();
    const base = await gate({ resolveUrl: resolve.url });
    for (const key of [null, "not-the-key", SUPPORT_KEY, OPS_KEY]) {
      const answer = await launch(base, { scenario_id: "beat-3-attack-email" }, key);
      expect(answer.status).toBe(401);
      expect(answer.body).toEqual({ message: APPROVAL_MESSAGES.unauthorized });
    }
    expect(tokensIssued).toBe(0);
    expect(resolve.received).toEqual([]);
  });

  it("is 400 for a body that isn't { scenario_id }", async () => {
    const resolve = await fakeResolve();
    const base = await gate({ resolveUrl: resolve.url });
    const bad: unknown[] = [
      "not json",
      {},
      [],
      { scenario_id: "" },
      { scenario_id: "Beat-3" },
      { scenario_id: "a".repeat(41) },
      { scenario_id: "../messages" },
      { scenario_id: "beat-3-attack-email", mode: "baseline" },
      { scenario_id: 3 },
      { scenario_id: "beat-3-attack-email", pad: "x".repeat(2000) },
    ];
    for (const body of bad) {
      const answer = await launch(base, body);
      expect(answer.status, JSON.stringify(body)).toBe(400);
      expect(answer.body).toEqual({ message: BASELINE_LAUNCH_MESSAGES.badBody });
    }
    expect(tokensIssued).toBe(0);
    expect(resolve.received).toEqual([]);
  });

  it("mints one token and sends it only to Resolve's scenario route, then passes the 202 through", async () => {
    const resolve = await fakeResolve();
    const base = await gate({ resolveUrl: resolve.url });
    const answer = await launch(base, { scenario_id: "beat-3-attack-email" });
    expect(answer.status).toBe(202);
    expect(answer.body).toEqual(ACCEPTED);
    expect(tokensIssued).toBe(1);
    expect(resolve.received).toHaveLength(1);
    const [received] = resolve.received;
    expect(received?.method).toBe("POST");
    expect(received?.url).toBe("/scenarios/beat-3-attack-email");
    expect(received?.headers["content-type"]).toContain("application/json");
    expect(received?.headers.authorization).toBeUndefined();
    expect(received?.body).toEqual({
      mode: "baseline",
      paypal_token: { access_token: TOKEN, expires_at: EXPIRES_AT },
    });
    expect(answer.text).not.toContain(TOKEN);
    expect(allLogged()).not.toContain(TOKEN);
    expect(allLogged()).not.toContain(APPROVER_KEY);
  });

  it("passes Resolve's 400, 404, 409, 500 and 503 sentences through", async () => {
    const resolve = await fakeResolve();
    const base = await gate({ resolveUrl: resolve.url });
    const answers: [number, string][] = [
      [400, "This scenario runs in protected mode only."],
      [404, "There's no scenario with that ID."],
      [409, "Order KIK-1035 isn't seeded. Reset the demo first."],
      [500, "Resolve couldn't store the message. Try again."],
      [503, "Resolve has no database."],
    ];
    for (const [status, message] of answers) {
      resolve.answer = { status, body: JSON.stringify({ message }) };
      const answer = await launch(base, { scenario_id: "beat-4-stalled-parcel" });
      expect(answer.status).toBe(status);
      expect(answer.body).toEqual({ message });
      expect(answer.text).not.toContain(TOKEN);
    }
    expect(tokensIssued).toBe(answers.length);
    expect(allLogged()).not.toContain(TOKEN);
  });

  it("is 502 'Resolve couldn't be reached' for any other answer from Resolve", async () => {
    const resolve = await fakeResolve();
    const base = await gate({ resolveUrl: resolve.url });
    const others: FakeResolve["answer"][] = [
      { status: 200, body: JSON.stringify(ACCEPTED) },
      { status: 201, body: JSON.stringify(ACCEPTED) },
      { status: 401, body: JSON.stringify({ message: "no" }) },
      { status: 502, body: JSON.stringify({ message: "bad gateway" }) },
      { status: 202, body: "not json" },
      { status: 202, body: JSON.stringify({ message: "accepted" }) },
      { status: 202, body: JSON.stringify({ ...ACCEPTED, thread_id: "not-a-thread" }) },
      { status: 404, body: JSON.stringify({ error: "nope" }) },
      { status: 409, body: JSON.stringify({ message: "" }) },
      { status: 302, body: "{}", headers: { location: "http://127.0.0.1:1/elsewhere" } },
    ];
    for (const other of others) {
      resolve.answer = other;
      const answer = await launch(base, { scenario_id: "beat-3-attack-email" });
      expect(answer.status, JSON.stringify(other)).toBe(502);
      expect(answer.body).toEqual({ message: BASELINE_LAUNCH_MESSAGES.resolveUnreachable });
      expect(answer.text).not.toContain(TOKEN);
    }
    expect(allLogged()).not.toContain(TOKEN);
  });

  it("is 502 'Resolve couldn't be reached' when nothing listens at Resolve's address", async () => {
    const closed = createServer();
    const url = await listenOn(closed);
    servers = servers.filter((server) => server !== closed);
    await new Promise<void>((resolve) => closed.close(() => resolve()));
    const base = await gate({ resolveUrl: url });
    const answer = await launch(base, { scenario_id: "beat-3-attack-email" });
    expect(answer.status).toBe(502);
    expect(answer.body).toEqual({ message: BASELINE_LAUNCH_MESSAGES.resolveUnreachable });
    expect(allLogged()).not.toContain(TOKEN);
  });

  it("is 502 when Resolve doesn't answer within 10 seconds", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      let seenSignal: AbortSignal | undefined;
      const hanging = (async (_url: unknown, init?: RequestInit) => {
        seenSignal = init?.signal ?? undefined;
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        });
      }) as typeof fetch;
      const base = await gate({ resolveUrl: "http://resolve.test:8788", launchFetch: hanging });
      const pending = launch(base, { scenario_id: "beat-3-attack-email" });
      await vi.waitFor(() => expect(seenSignal).toBeDefined());
      await vi.advanceTimersByTimeAsync(10_000);
      const answer = await pending;
      expect(seenSignal?.aborted).toBe(true);
      expect(answer.status).toBe(502);
      expect(answer.body).toEqual({ message: BASELINE_LAUNCH_MESSAGES.resolveUnreachable });
    } finally {
      vi.useRealTimers();
    }
  });

  it("sends with redirects refused, to the default address when RESOLVE_AGENT_URL is unset or blank", async () => {
    for (const resolveUrl of [undefined, "", "   "]) {
      const calls: { url: string; init: RequestInit | undefined }[] = [];
      const recording = (async (url: string | URL | Request, init?: RequestInit) => {
        calls.push({ url: String(url), init });
        return new Response(JSON.stringify(ACCEPTED), {
          status: 202,
          headers: { "content-type": "application/json" },
        });
      }) as typeof fetch;
      const base = await gate({
        ...(resolveUrl === undefined ? {} : { resolveUrl }),
        launchFetch: recording,
      });
      const answer = await launch(base, { scenario_id: "beat-3-attack-email" });
      expect(answer.status).toBe(202);
      expect(calls).toHaveLength(1);
      expect(calls[0]?.url).toBe("http://127.0.0.1:8788/scenarios/beat-3-attack-email");
      expect(calls[0]?.init?.method).toBe("POST");
      expect(calls[0]?.init?.redirect).toBe("error");
    }
  });

  it("is 503 'can't reach Resolve' only when RESOLVE_AGENT_URL isn't an http(s) URL", async () => {
    for (const resolveUrl of ["not a url", "ftp://resolve.test", "file:///etc/hosts"]) {
      const base = await gate({ resolveUrl });
      const answer = await launch(base, { scenario_id: "beat-3-attack-email" });
      expect(answer.status).toBe(503);
      expect(answer.body).toEqual({ message: BASELINE_LAUNCH_MESSAGES.noResolve });
    }
    expect(tokensIssued).toBe(0);
  });

  it("is 503 'PayPal isn't set up' when the gate has no rail, or building it throws", async () => {
    const resolve = await fakeResolve();
    const none = await gate({ resolveUrl: resolve.url, rail: undefined });
    const throwing = await gate({
      resolveUrl: resolve.url,
      rail: () => {
        throw new Error("PAYPAL_CLIENT_ID is unset");
      },
    });
    for (const base of [none, throwing]) {
      const answer = await launch(base, { scenario_id: "beat-3-attack-email" });
      expect(answer.status).toBe(503);
      expect(answer.body).toEqual({ message: BASELINE_LAUNCH_MESSAGES.noPayPal });
    }
    expect(resolve.received).toEqual([]);
  });

  it("is 502 'PayPal didn't issue a token' when minting fails, and calls no Resolve", async () => {
    const resolve = await fakeResolve();
    const base = await gate({
      resolveUrl: resolve.url,
      rail: () => {
        const sandbox = createFakeSandbox();
        sandbox.issueAccessToken = async () => {
          throw new Error("PayPal answered 401");
        };
        return sandbox;
      },
    });
    const answer = await launch(base, { scenario_id: "beat-3-attack-email" });
    expect(answer.status).toBe(502);
    expect(answer.body).toEqual({ message: BASELINE_LAUNCH_MESSAGES.noToken });
    expect(resolve.received).toEqual([]);
  });

  it("answers the sentences requirements.md gives", () => {
    expect(BASELINE_LAUNCH_MESSAGES).toEqual({
      badBody: "Send JSON with scenario_id.",
      noResolve: "The gate can't reach Resolve, so baseline mode can't start.",
      noPayPal: "PayPal isn't set up on the gate, so baseline mode can't start.",
      noToken: "PayPal didn't issue a token. Try again in a minute.",
      resolveUnreachable: "Resolve couldn't be reached. Try again in a minute.",
    });
  });
});
