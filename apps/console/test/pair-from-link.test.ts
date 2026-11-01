import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import { APPROVAL_ROUTE_MESSAGES, APPROVER_COOKIE, pairRoute } from "../src/approval-routes";
import { FIELD_ERROR } from "../src/controls";
import { pairFromLink, pairingCodeFromHash } from "../src/pair-link";
import { resetSessionLimits, SESSION_COOKIE } from "../src/session-limits";

// The approvals page's half of phone pairing (ADR 0044): the code in the QR link's fragment is
// dropped from the address bar, then traded once through the console's pairing route.

const KEY = "approver-key-0123456789abcdefghijklmnop";
const CODE = "AbCdEfGhIjKlMnOpQrStUv";
const REFUSED = "That code has expired or was used. Sign in with the approver key.";
const env = { GATE_URL: "http://gate.test:8787" };

type GateAnswer = () => Response | Promise<Response>;

// A phone's browser: its address bar's fragment, and a fetch that reaches the console's real
// `POST /api/approvals/pair` route, which calls a fake gate.
function phone(hash: string, answer: GateAnswer) {
  const state = { hash, cleared: 0, routeCalls: [] as string[], gateBodies: [] as string[] };
  const responses: Response[] = [];
  const gateFetch = (async (_url: URL | string, init?: RequestInit) => {
    state.gateBodies.push(String(init?.body));
    return answer();
  }) as typeof fetch;
  const browserFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    state.routeCalls.push(`${init?.method ?? "GET"} ${String(input)}`);
    const response = await pairRoute(new Request(`http://console.test${String(input)}`, init), {
      env,
      fetch: gateFetch,
    });
    responses.push(response.clone());
    return response;
  }) as typeof fetch;
  const browser = {
    get hash() {
      return state.hash;
    },
    clearHash() {
      state.cleared += 1;
      state.hash = "";
    },
    fetch: browserFetch,
  };
  return { state, browser, responses };
}

beforeEach(() => resetSessionLimits());

describe("pairingCodeFromHash", () => {
  it("reads the code from #pair=", () => {
    expect(pairingCodeFromHash(`#pair=${CODE}`)).toBe(CODE);
    expect(pairingCodeFromHash(`pair=${CODE}`)).toBe(CODE);
  });
  it("is null when the fragment has no pairing code", () => {
    for (const hash of ["", "#", "#cards", "#other=1"])
      expect(pairingCodeFromHash(hash)).toBeNull();
  });
});

describe("pairFromLink", () => {
  it("drops the fragment, posts the code once and is paired on a 200", async () => {
    const { state, browser, responses } = phone(`#pair=${CODE}`, () =>
      Response.json({ approver_key: KEY }),
    );
    expect(await pairFromLink(browser)).toEqual({ paired: true });
    expect(state.cleared).toBe(1);
    expect(state.hash).toBe("");
    expect(state.routeCalls).toEqual(["POST /api/approvals/pair"]);
    expect(state.gateBodies).toEqual([JSON.stringify({ code: CODE })]);
    // The route set the cookies the sign-in sets, and the key never reached the page.
    const answer = responses[0];
    const cookies = answer?.headers.getSetCookie() ?? [];
    expect(cookies.some((c) => c.startsWith(`${APPROVER_COOKIE}=`))).toBe(true);
    expect(cookies.some((c) => c.startsWith(`${SESSION_COOKIE}=`))).toBe(true);
    expect(await answer?.text()).not.toContain(KEY);
    // A second mount finds no fragment and posts nothing.
    expect(await pairFromLink(browser)).toBeNull();
    expect(state.routeCalls).toHaveLength(1);
  });

  it("gives the gate's sentence on a 401", async () => {
    const { state, browser } = phone(`#pair=${CODE}`, () =>
      Response.json({ message: REFUSED }, { status: 401 }),
    );
    expect(await pairFromLink(browser)).toEqual({ paired: false, message: REFUSED });
    expect(state.cleared).toBe(1);
    expect(state.routeCalls).toHaveLength(1);
  });

  it("fails closed to the unreachable sentence when the gate is down or answers junk", async () => {
    for (const answer of [
      () => Promise.reject(new TypeError("fetch failed")),
      () => new Response("<html>", { status: 500 }),
      () => Response.json({ nope: true }),
    ] satisfies GateAnswer[]) {
      const { browser } = phone(`#pair=${CODE}`, answer);
      expect(await pairFromLink(browser)).toEqual({
        paired: false,
        message: APPROVAL_ROUTE_MESSAGES.unreachable,
      });
    }
  });

  it("fails closed when the console can't be reached", async () => {
    let cleared = 0;
    const outcome = await pairFromLink({
      hash: `#pair=${CODE}`,
      clearHash: () => {
        cleared += 1;
      },
      fetch: (async () => {
        throw new TypeError("offline");
      }) as typeof fetch,
    });
    expect(outcome).toEqual({ paired: false, message: APPROVAL_ROUTE_MESSAGES.unreachable });
    expect(cleared).toBe(1);
  });

  it("does nothing without a #pair= fragment", async () => {
    for (const hash of ["", "#cards"]) {
      const { state, browser } = phone(hash, () => Response.json({ approver_key: KEY }));
      expect(await pairFromLink(browser)).toBeNull();
      expect(state.cleared).toBe(0);
      expect(state.hash).toBe(hash);
      expect(state.routeCalls).toEqual([]);
    }
  });
});

describe("pair-from-link.tsx", () => {
  const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

  it("runs the exchange on mount, refreshes on 200 and shows a refusal as an alert", () => {
    const source = read("../app/approvals/pair-from-link.tsx");
    expect(source.startsWith('"use client";')).toBe(true);
    expect(source).toContain("pairFromLink(");
    expect(source).toContain("history.replaceState");
    expect(source).toContain("router.refresh()");
    expect(source).toContain('role="alert"');
    expect(source).toContain("className={FIELD_ERROR}");
    expect(FIELD_ERROR).toBe("text-caption-lg text-danger-foreground");
    expect(source).not.toMatch(/GATE_URL|localStorage|document\.cookie|server-only/);
  });

  it("is rendered above the sign-in and on the signed-in board", () => {
    const page = read("../app/approvals/page.tsx");
    expect(page).toContain('import { PairFromLink } from "./pair-from-link";');
    // Both sign-ins carry it first, so a refused code shows above the title.
    expect([...page.matchAll(/<SignIn\s+before=\{<PairFromLink \/>\}/g)]).toHaveLength(2);
    expect([...page.matchAll(/<SignIn/g)]).toHaveLength(2);
    // Signed in, or the gate unreachable, it still drops and trades the code, showing nothing.
    const quiet = [...page.matchAll(/<PairFromLink quiet \/>\s*<ApprovalsBoard/g)];
    expect(quiet).toHaveLength(2);
    const sign = read("../app/sign-in.tsx");
    expect(sign.indexOf("{before}")).toBeGreaterThan(-1);
    expect(sign.indexOf("{before}")).toBeLessThan(sign.indexOf("{fields}"));
  });

  it("puts the start page's pairing code in the QR link", () => {
    const start = read("../app/page.tsx");
    expect(start).toContain("pairedApprovalsUrl(");
  });
});
