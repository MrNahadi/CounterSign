import { beforeEach, describe, expect, it } from "vitest";
import { APPROVAL_ROUTE_MESSAGES, APPROVER_COOKIE } from "../src/approval-routes";
import { resetRoute, scenarioRoute } from "../src/demo-routes";
import { messagesRoute, RESOLVE_UNREACHABLE } from "../src/resolve-routes";
import {
  resetSessionLimits,
  SESSION_COOKIE,
  SESSION_LIMIT_MESSAGES,
  SESSION_LIMITS,
} from "../src/session-limits";

// `POST /api/scenarios` and `POST /api/demo/reset`, with Resolve and the gate played by an
// injected fetch.

const env = { RESOLVE_AGENT_URL: "http://resolve.test:9000", GATE_URL: "http://gate.test" };
const KEY = "approver-key-0123456789abcdefghijklmnop";
const SESSION = "s".repeat(22);
const SIGNED_IN = `${APPROVER_COOKIE}=${encodeURIComponent(KEY)}; ${SESSION_COOKIE}=${SESSION}`;
const NO_SESSION = `${APPROVER_COOKIE}=${encodeURIComponent(KEY)}`;

const accepted = {
  ticket_id: `tkt_${"a".repeat(32)}`,
  thread_id: `tkt_${"a".repeat(32)}`,
  run_id: `run_${"b".repeat(32)}`,
};

const report = {
  complete: true,
  reset_at: "2026-12-01T10:00:00.000Z",
  took_ms: 14_000,
  orders: {
    kept: 27,
    replaced: ["KIK-1035", "KIK-1037", "KIK-1042"],
    run_id: "seed-1",
    failed: [],
  },
  cleared: {
    previous_head: { seq: 41, hash: "a".repeat(64) },
    entries: 41,
    tickets: 3,
    attachments: 1,
    runs: 4,
    drafts: 0,
    documents: 2,
  },
  disputes: { recorded: 1, already_recorded: 0, problems: 0 },
};

type Call = { url: string; init: RequestInit | undefined };

// The gate answers `gate(path)`; Resolve answers `resolve(path)`. `checks` counts the sign-in checks.
function world(
  opts: {
    resolve?: (path: string) => Response | Promise<Response>;
    gate?: (path: string) => Response | Promise<Response>;
  } = {},
) {
  const resolveCalls: Call[] = [];
  const gateCalls: Call[] = [];
  const fetchFake = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.host === "gate.test") {
      gateCalls.push({ url: String(input), init });
      return (opts.gate ?? (() => Response.json({ open: [], recent: [] })))(url.pathname);
    }
    resolveCalls.push({ url: String(input), init });
    return (opts.resolve ?? (() => Response.json(accepted, { status: 202 })))(url.pathname);
  }) as typeof fetch;
  const sent = (path: string) => gateCalls.filter((call) => new URL(call.url).pathname === path);
  return { resolveCalls, gateCalls, sent, fetch: fetchFake };
}

const post = (url: string, body: string, cookie: string | null = SIGNED_IN) =>
  new Request(`http://console.test${url}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(cookie === null ? {} : { cookie }) },
    body,
  });

const scenario = (body: unknown, cookie: string | null = SIGNED_IN) =>
  post("/api/scenarios", typeof body === "string" ? body : JSON.stringify(body), cookie);
const reset = (cookie: string | null = SIGNED_IN) => post("/api/demo/reset", "", cookie);

async function bodyOf(response: Response) {
  return { status: response.status, body: await response.json() };
}

const attack = { scenario_id: "beat-3-attack-email" };

beforeEach(() => {
  resetSessionLimits();
});

describe("POST /api/scenarios", () => {
  it("sends a protected scenario to Resolve with its mode and answers 202", async () => {
    const w = world();
    const answer = await scenarioRoute(scenario({ ...attack, mode: "protected" }), {
      env,
      fetch: w.fetch,
    });
    expect(await bodyOf(answer)).toEqual({ status: 202, body: accepted });
    expect(w.resolveCalls).toHaveLength(1);
    const [call] = w.resolveCalls;
    expect(call?.url).toBe("http://resolve.test:9000/scenarios/beat-3-attack-email");
    expect(call?.init?.method).toBe("POST");
    expect(JSON.parse(String(call?.init?.body))).toEqual({ mode: "protected" });
    expect(JSON.stringify(w.resolveCalls)).not.toContain(KEY);
    expect(w.sent("/baseline/launch")).toEqual([]);
  });

  it("sends a baseline scenario to the gate's launcher, not to Resolve", async () => {
    const w = world({
      gate: (path) =>
        path === "/baseline/launch"
          ? Response.json({ ...accepted, extra: "dropped" }, { status: 202 })
          : Response.json({ open: [], recent: [] }),
    });
    const answer = await scenarioRoute(scenario({ ...attack, mode: "baseline" }), {
      env,
      fetch: w.fetch,
    });
    expect(await bodyOf(answer)).toEqual({ status: 202, body: accepted });
    expect(w.resolveCalls).toEqual([]);
    const [launch] = w.sent("/baseline/launch");
    expect(launch?.init?.method).toBe("POST");
    expect(new Headers(launch?.init?.headers).get("authorization")).toBe(`Bearer ${KEY}`);
    expect(JSON.parse(String(launch?.init?.body))).toEqual(attack);
  });

  it("answers 400 'Send JSON with scenario_id and mode.' for a bad body", async () => {
    const bodies = [
      "{",
      "[]",
      "",
      JSON.stringify({ scenario_id: "beat-3-attack-email" }),
      JSON.stringify({ mode: "protected" }),
      JSON.stringify({ ...attack, mode: "turbo" }),
      JSON.stringify({ ...attack, mode: "protected", extra: true }),
      JSON.stringify({ scenario_id: "../threads", mode: "protected" }),
      JSON.stringify({ scenario_id: "A", mode: "protected" }),
      JSON.stringify({ scenario_id: "a".repeat(41), mode: "protected" }),
      JSON.stringify({ ...attack, mode: "protected", pad: "x".repeat(1100) }),
    ];
    for (const body of bodies) {
      const w = world();
      expect(await bodyOf(await scenarioRoute(scenario(body), { env, fetch: w.fetch }))).toEqual({
        status: 400,
        body: { message: "Send JSON with scenario_id and mode." },
      });
      expect(w.resolveCalls).toEqual([]);
      expect(w.sent("/baseline/launch")).toEqual([]);
    }
  });

  it("passes Resolve's 400, 404 and 409 sentences through, for either mode", async () => {
    const cases = [
      [400, "This scenario runs in protected mode only."],
      [404, "There's no scenario with that ID."],
      [409, "Order KIK-1035 isn't seeded. Reset the demo first."],
    ] as const;
    for (const [status, message] of cases) {
      const protectedWorld = world({ resolve: () => Response.json({ message }, { status }) });
      expect(
        await bodyOf(
          await scenarioRoute(scenario({ ...attack, mode: "protected" }), {
            env,
            fetch: protectedWorld.fetch,
          }),
        ),
      ).toEqual({ status, body: { message } });
      const baselineWorld = world({
        gate: (path) =>
          path === "/baseline/launch"
            ? Response.json({ message }, { status })
            : Response.json({ open: [], recent: [] }),
      });
      expect(
        await bodyOf(
          await scenarioRoute(scenario({ ...attack, mode: "baseline" }), {
            env,
            fetch: baselineWorld.fetch,
          }),
        ),
      ).toEqual({ status, body: { message } });
    }
  });

  it("passes the gate's 502 and 503 launch sentences through for baseline only", async () => {
    const cases = [
      [502, "PayPal didn't issue a token. Try again in a minute."],
      [503, "The gate can't reach Resolve, so baseline mode can't start."],
    ] as const;
    for (const [status, message] of cases) {
      const w = world({
        gate: (path) =>
          path === "/baseline/launch"
            ? Response.json({ message }, { status })
            : Response.json({ open: [], recent: [] }),
      });
      expect(
        await bodyOf(
          await scenarioRoute(scenario({ ...attack, mode: "baseline" }), { env, fetch: w.fetch }),
        ),
      ).toEqual({ status, body: { message } });
    }
    // Resolve's own 503 is not passed on: protected mode answers the unreachable sentence.
    const down = world({
      resolve: () => Response.json({ message: "Resolve has no database." }, { status: 503 }),
    });
    expect(
      await bodyOf(
        await scenarioRoute(scenario({ ...attack, mode: "protected" }), {
          env,
          fetch: down.fetch,
        }),
      ),
    ).toEqual({ status: 502, body: { message: RESOLVE_UNREACHABLE } });
  });

  it("answers 502 when Resolve or the gate is down or answers junk", async () => {
    const junk: (() => Response | Promise<Response>)[] = [
      () => Promise.reject(new TypeError("fetch failed")),
      () => new Response("<html>", { status: 202 }),
      () => Response.json({ ...accepted, thread_id: "nope" }, { status: 202 }),
      () => Response.json({ oops: true }, { status: 409 }),
      () => Response.json(accepted, { status: 200 }),
    ];
    for (const answer of junk) {
      const w = world({ resolve: answer });
      expect(
        await bodyOf(
          await scenarioRoute(scenario({ ...attack, mode: "protected" }), {
            env,
            fetch: w.fetch,
          }),
        ),
      ).toEqual({ status: 502, body: { message: RESOLVE_UNREACHABLE } });
      const g = world({
        gate: (path) =>
          path === "/baseline/launch" ? answer() : Response.json({ open: [], recent: [] }),
      });
      expect(
        await bodyOf(
          await scenarioRoute(scenario({ ...attack, mode: "baseline" }), { env, fetch: g.fetch }),
        ),
      ).toEqual({ status: 502, body: { message: RESOLVE_UNREACHABLE } });
    }
  });
});

describe("the order of the checks", () => {
  const protectedAttack = { ...attack, mode: "protected" };

  it("with no key cookie answers 401 without asking the gate or spending a slot", async () => {
    const w = world();
    const answer = await scenarioRoute(scenario(protectedAttack, null), { env, fetch: w.fetch });
    expect(await bodyOf(answer)).toEqual({
      status: 401,
      body: { message: APPROVAL_ROUTE_MESSAGES.signedOut },
    });
    expect(w.gateCalls).toEqual([]);
    expect(w.resolveCalls).toEqual([]);
    const resetAnswer = await resetRoute(reset(null), { env, fetch: w.fetch });
    expect(resetAnswer.status).toBe(401);
    expect(w.gateCalls).toEqual([]);
  });

  it("a wrong key spends no slot: the gate's 401 comes before the limit", async () => {
    const w = world({
      gate: () => Response.json({ message: "A valid approver key is required." }, { status: 401 }),
    });
    for (let i = 0; i < SESSION_LIMITS.run + 2; i += 1) {
      const answer = await scenarioRoute(scenario(protectedAttack), { env, fetch: w.fetch });
      expect(await bodyOf(answer)).toEqual({
        status: 401,
        body: { message: APPROVAL_ROUTE_MESSAGES.signInAgain },
      });
    }
    expect(w.resolveCalls).toEqual([]);
    // The same session, now with a good key, still has every slot.
    const good = world();
    for (let i = 0; i < SESSION_LIMITS.run; i += 1) {
      const answer = await scenarioRoute(scenario(protectedAttack), { env, fetch: good.fetch });
      expect(answer.status).toBe(202);
    }
  });

  it("a gate that can't be reached answers 502 and spends no slot", async () => {
    const down = world({ gate: () => Promise.reject(new TypeError("fetch failed")) });
    for (let i = 0; i < SESSION_LIMITS.run + 1; i += 1) {
      const answer = await scenarioRoute(scenario(protectedAttack), { env, fetch: down.fetch });
      expect(answer.status).toBe(502);
    }
    const good = world();
    expect(
      (await scenarioRoute(scenario(protectedAttack), { env, fetch: good.fetch })).status,
    ).toBe(202);
  });

  it("a key cookie without a session cookie is 401 'Sign in again.' and clears the key", async () => {
    const w = world();
    const answer = await scenarioRoute(scenario(protectedAttack, NO_SESSION), {
      env,
      fetch: w.fetch,
    });
    expect(await bodyOf(answer)).toEqual({
      status: 401,
      body: { message: APPROVAL_ROUTE_MESSAGES.signInAgain },
    });
    expect(answer.headers.get("set-cookie")).toMatch(/^countersign_approver=; .*Max-Age=0/);
    expect(w.resolveCalls).toEqual([]);
  });

  it("a bad body is refused before the sign-in and spends no slot", async () => {
    const w = world();
    for (let i = 0; i < SESSION_LIMITS.run + 1; i += 1) {
      expect((await scenarioRoute(scenario("{"), { env, fetch: w.fetch })).status).toBe(400);
    }
    expect((await scenarioRoute(scenario(protectedAttack), { env, fetch: w.fetch })).status).toBe(
      202,
    );
  });

  it("allows 12 runs in a session, then 429, with scenarios and messages counted together", async () => {
    const w = world();
    const chat = {
      channel: "email",
      sender_email: "payer@example.com",
      subject: "Hello",
      body: "Hi.",
      attachments: [],
      mode: "protected",
    };
    for (let i = 0; i < SESSION_LIMITS.run; i += 1) {
      const answer =
        i % 2 === 0
          ? await scenarioRoute(scenario(protectedAttack), { env, fetch: w.fetch })
          : await messagesRoute(post("/api/resolve/messages", JSON.stringify(chat)), {
              env,
              fetch: w.fetch,
            });
      expect(answer.status).toBe(202);
    }
    const sentenceOf = SESSION_LIMIT_MESSAGES.run;
    const over = await scenarioRoute(scenario(protectedAttack), { env, fetch: w.fetch });
    expect(await bodyOf(over)).toEqual({ status: 429, body: { message: sentenceOf } });
    const overChat = await messagesRoute(post("/api/resolve/messages", JSON.stringify(chat)), {
      env,
      fetch: w.fetch,
    });
    expect(await bodyOf(overChat)).toEqual({ status: 429, body: { message: sentenceOf } });
    expect(w.resolveCalls).toHaveLength(SESSION_LIMITS.run);
    // Another session is not affected.
    const other = `${APPROVER_COOKIE}=${encodeURIComponent(KEY)}; ${SESSION_COOKIE}=${"t".repeat(22)}`;
    expect(
      (await scenarioRoute(scenario(protectedAttack, other), { env, fetch: w.fetch })).status,
    ).toBe(202);
  });

  it("messagesRoute with no session cookie is 401 'Sign in again.' and sends nothing", async () => {
    const w = world();
    const answer = await messagesRoute(post("/api/resolve/messages", "{}", NO_SESSION), {
      env,
      fetch: w.fetch,
    });
    expect(await bodyOf(answer)).toEqual({
      status: 401,
      body: { message: APPROVAL_ROUTE_MESSAGES.signInAgain },
    });
    expect(w.resolveCalls).toEqual([]);
  });
});

describe("POST /api/demo/reset", () => {
  it("passes the gate's report through, with the key as the bearer", async () => {
    const w = world({
      gate: (path) => (path === "/demo/reset" ? Response.json(report) : Response.json({})),
    });
    const answer = await resetRoute(reset(), { env, fetch: w.fetch });
    expect(await bodyOf(answer)).toEqual({ status: 200, body: report });
    const [call] = w.sent("/demo/reset");
    expect(call?.init?.method).toBe("POST");
    expect(new Headers(call?.init?.headers).get("authorization")).toBe(`Bearer ${KEY}`);
    // The reset route has no sign-in check of its own: the gate's reset checks the key.
    expect(w.sent("/approvals")).toEqual([]);
    expect(w.resolveCalls).toEqual([]);
  });

  it("passes a report with cleared and disputes null through", async () => {
    const stalled = {
      ...report,
      complete: false,
      orders: {
        kept: 28,
        replaced: ["KIK-1035", "KIK-1037"],
        run_id: "seed-2",
        failed: [{ order_number: "KIK-1035", call: "seed", reason: "PayPal said no." }],
      },
      cleared: null,
      disputes: null,
    };
    const w = world({ gate: () => Response.json(stalled) });
    expect(await bodyOf(await resetRoute(reset(), { env, fetch: w.fetch }))).toEqual({
      status: 200,
      body: stalled,
    });
    const errored = {
      ...report,
      complete: false,
      disputes: { error: "the gate couldn't read its records" },
    };
    const e = world({ gate: () => Response.json(errored) });
    expect(await bodyOf(await resetRoute(reset(), { env, fetch: e.fetch }))).toEqual({
      status: 200,
      body: errored,
    });
  });

  it("turns the gate's 404 into 'The demo reset is off on this gate.'", async () => {
    const w = world({ gate: () => new Response("<html>Cannot POST</html>", { status: 404 }) });
    expect(await bodyOf(await resetRoute(reset(), { env, fetch: w.fetch }))).toEqual({
      status: 404,
      body: { message: "The demo reset is off on this gate." },
    });
  });

  it("passes the gate's 409 and 503 sentences through", async () => {
    const cases = [
      [409, "A reset is already running."],
      [409, "The demo was reset less than a minute ago. Try again in a minute."],
      [503, "PayPal isn't set up on the gate, so the demo can't be reset."],
      [503, "The demo couldn't be reset. Nothing was cleared."],
    ] as const;
    for (const [status, message] of cases) {
      resetSessionLimits();
      const w = world({ gate: () => Response.json({ message }, { status }) });
      expect(await bodyOf(await resetRoute(reset(), { env, fetch: w.fetch }))).toEqual({
        status,
        body: { message },
      });
    }
  });

  it("a gate 401 clears the key cookie", async () => {
    const w = world({
      gate: () => Response.json({ message: "A valid approver key is required." }, { status: 401 }),
    });
    const answer = await resetRoute(reset(), { env, fetch: w.fetch });
    expect(await bodyOf(answer)).toEqual({
      status: 401,
      body: { message: APPROVAL_ROUTE_MESSAGES.signInAgain },
    });
    expect(answer.headers.get("set-cookie")).toMatch(/^countersign_approver=; .*Max-Age=0/);
  });

  it("answers 502 when the gate is down or its report is unreadable", async () => {
    const answers: (() => Response | Promise<Response>)[] = [
      () => Promise.reject(new TypeError("fetch failed")),
      () => new Response("<html>", { status: 200 }),
      () => Response.json({ ...report, took_ms: -1 }),
      () => Response.json({ ...report, orders: { ...report.orders, replaced: ["nope"] } }),
      () => Response.json({ oops: true }, { status: 409 }),
      () => Response.json({ message: "x" }, { status: 500 }),
    ];
    for (const answer of answers) {
      resetSessionLimits();
      const w = world({ gate: answer });
      expect(await bodyOf(await resetRoute(reset(), { env, fetch: w.fetch }))).toEqual({
        status: 502,
        body: { message: APPROVAL_ROUTE_MESSAGES.unreachable },
      });
    }
  });

  it("a key cookie without a session cookie is 401 and never reaches the gate", async () => {
    const w = world({ gate: () => Response.json(report) });
    const answer = await resetRoute(reset(NO_SESSION), { env, fetch: w.fetch });
    expect(answer.status).toBe(401);
    expect(w.gateCalls).toEqual([]);
  });

  it("allows 3 resets in a session, then 429, without touching run slots", async () => {
    const w = world({ gate: () => Response.json(report) });
    for (let i = 0; i < SESSION_LIMITS.reset; i += 1) {
      expect((await resetRoute(reset(), { env, fetch: w.fetch })).status).toBe(200);
    }
    const over = await resetRoute(reset(), { env, fetch: w.fetch });
    expect(await bodyOf(over)).toEqual({
      status: 429,
      body: { message: SESSION_LIMIT_MESSAGES.reset },
    });
    expect(w.sent("/demo/reset")).toHaveLength(SESSION_LIMITS.reset);
    const run = world();
    expect(
      (
        await scenarioRoute(scenario({ ...attack, mode: "protected" }), {
          env,
          fetch: run.fetch,
        })
      ).status,
    ).toBe(202);
  });
});
