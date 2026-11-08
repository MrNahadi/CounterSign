import { beforeEach, describe, expect, it } from "vitest";
import { APPROVAL_ROUTE_MESSAGES, APPROVER_COOKIE, refusalResponse } from "../src/approval-routes";
import {
  limitSession,
  newSessionCookie,
  resetSessionLimits,
  SESSION_COOKIE,
  SESSION_LIMIT_MESSAGES,
  SESSION_WINDOW_MS,
  sessionIdFrom,
} from "../src/session-limits";

// Each signed-in session's limits on runs and resets (brief §8, ADR 0044), through `limitSession`.

const KEY = "approver-key-0123456789abcdefghijklmnop";
const SESSION_A = "a".repeat(22);
const SESSION_B = "b".repeat(22);
const NOW = Date.parse("2026-11-01T10:00:00.000Z");

function request(cookie?: string) {
  const headers = new Headers();
  if (cookie !== undefined) headers.set("cookie", cookie);
  return new Request("http://localhost:3000/api/scenarios", { method: "POST", headers });
}

const signedIn = (session: string) =>
  request(`${APPROVER_COOKIE}=${KEY}; ${SESSION_COOKIE}=${session}`);

beforeEach(() => {
  resetSessionLimits();
});

describe("limitSession", () => {
  it("allows 12 runs in ten minutes and refuses the 13th with 429", () => {
    for (let i = 0; i < 12; i += 1) {
      expect(limitSession(signedIn(SESSION_A), "run", NOW + i * 1000)).toBeNull();
    }
    expect(limitSession(signedIn(SESSION_A), "run", NOW + 12_000)).toEqual({
      ok: false,
      status: 429,
      message: "This session has started a lot of runs. Try again in a few minutes.",
    });
  });

  it("allows 3 resets in ten minutes and refuses the 4th with 429", () => {
    for (let i = 0; i < 3; i += 1) {
      expect(limitSession(signedIn(SESSION_A), "reset", NOW + i * 1000)).toBeNull();
    }
    expect(limitSession(signedIn(SESSION_A), "reset", NOW + 3000)).toEqual({
      ok: false,
      status: 429,
      message: "This session has reset the demo a lot. Try again in a few minutes.",
    });
  });

  it("counts runs and resets apart", () => {
    for (let i = 0; i < 12; i += 1) limitSession(signedIn(SESSION_A), "run", NOW);
    expect(limitSession(signedIn(SESSION_A), "reset", NOW)).toBeNull();
    for (let i = 0; i < 2; i += 1) limitSession(signedIn(SESSION_A), "reset", NOW);
    expect(limitSession(signedIn(SESSION_A), "reset", NOW)?.status).toBe(429);
    expect(limitSession(signedIn(SESSION_A), "run", NOW)?.status).toBe(429);
  });

  it("doesn't count one session's requests against another", () => {
    for (let i = 0; i < 12; i += 1) limitSession(signedIn(SESSION_A), "run", NOW);
    for (let i = 0; i < 3; i += 1) limitSession(signedIn(SESSION_A), "reset", NOW);
    expect(limitSession(signedIn(SESSION_A), "run", NOW)?.status).toBe(429);
    expect(limitSession(signedIn(SESSION_B), "run", NOW)).toBeNull();
    expect(limitSession(signedIn(SESSION_B), "reset", NOW)).toBeNull();
  });

  it("allows a run again once the oldest leaves the ten-minute window", () => {
    for (let i = 0; i < 12; i += 1) limitSession(signedIn(SESSION_A), "run", NOW + i * 1000);
    expect(limitSession(signedIn(SESSION_A), "run", NOW + SESSION_WINDOW_MS - 1)?.status).toBe(429);
    expect(limitSession(signedIn(SESSION_A), "run", NOW + SESSION_WINDOW_MS)).toBeNull();
    expect(limitSession(signedIn(SESSION_A), "run", NOW + SESSION_WINDOW_MS)?.status).toBe(429);
  });

  it("spends nothing on a refusal", () => {
    for (let i = 0; i < 12; i += 1) limitSession(signedIn(SESSION_A), "run", NOW);
    for (let i = 0; i < 5; i += 1) {
      expect(limitSession(signedIn(SESSION_A), "run", NOW + 60_000)?.status).toBe(429);
    }
    // The twelve from NOW leave the window together; the refused ones never counted.
    for (let i = 0; i < 12; i += 1) {
      expect(limitSession(signedIn(SESSION_A), "run", NOW + SESSION_WINDOW_MS)).toBeNull();
    }
  });

  it("refuses 401 'Sign in again.' with no session cookie, and the answer clears the key", () => {
    for (const req of [
      request(`${APPROVER_COOKIE}=${KEY}`),
      request(`${APPROVER_COOKIE}=${KEY}; ${SESSION_COOKIE}=not-a-session`),
      request(`${APPROVER_COOKIE}=${KEY}; ${SESSION_COOKIE}=`),
    ]) {
      const refusal = limitSession(req, "run", NOW);
      expect(refusal).toEqual({
        ok: false,
        status: 401,
        message: APPROVAL_ROUTE_MESSAGES.signInAgain,
      });
      if (refusal === null) throw new Error("expected a refusal");
      const response = refusalResponse(req, refusal);
      expect(response.status).toBe(401);
      expect(response.headers.get("set-cookie")).toBe(
        `${APPROVER_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`,
      );
    }
  });

  it("words its refusals as the requirements say", () => {
    expect(SESSION_LIMIT_MESSAGES).toEqual({
      run: "This session has started a lot of runs. Try again in a few minutes.",
      reset: "This session has reset the demo a lot. Try again in a few minutes.",
      attack: "This session has sent a lot of attacks. Try again in a few minutes.",
      analyst: "This session has asked the analyst a lot. Try again in a few minutes.",
    });
  });

  it("allows 10 analyst questions in ten minutes, counted apart from attacks", () => {
    for (let i = 0; i < 10; i += 1) {
      expect(limitSession(signedIn(SESSION_A), "analyst", NOW + i * 1000)).toBeNull();
    }
    expect(limitSession(signedIn(SESSION_A), "analyst", NOW + 10_000)).toEqual({
      ok: false,
      status: 429,
      message: SESSION_LIMIT_MESSAGES.analyst,
    });
    expect(limitSession(signedIn(SESSION_A), "attack", NOW + 10_000)).toBeNull();
    expect(limitSession(signedIn(SESSION_A), "analyst", NOW + SESSION_WINDOW_MS)).toBeNull();
  });

  it("allows 6 attacks in ten minutes, counted apart from runs and resets", () => {
    for (let i = 0; i < 6; i += 1) {
      expect(limitSession(signedIn(SESSION_A), "attack", NOW + i * 1000)).toBeNull();
    }
    expect(limitSession(signedIn(SESSION_A), "attack", NOW + 6_000)).toEqual({
      ok: false,
      status: 429,
      message: SESSION_LIMIT_MESSAGES.attack,
    });
    expect(limitSession(signedIn(SESSION_A), "run", NOW + 6_000)).toBeNull();
    expect(limitSession(signedIn(SESSION_A), "reset", NOW + 6_000)).toBeNull();
    expect(limitSession(signedIn(SESSION_A), "attack", NOW + SESSION_WINDOW_MS)).toBeNull();
  });
});

describe("the session cookie", () => {
  it("is 16 random bytes, base64url, HttpOnly and SameSite Strict, Secure on HTTPS", () => {
    const plain = newSessionCookie(request());
    expect(plain).toMatch(
      new RegExp(
        `^${SESSION_COOKIE}=[A-Za-z0-9_-]{22}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200$`,
      ),
    );
    expect(newSessionCookie(request())).not.toBe(plain);
    const secure = newSessionCookie(new Request("https://console.test/api/approvals/session"));
    expect(secure).toMatch(/; Secure$/);
  });

  it("reads back from the Cookie header", () => {
    const value = newSessionCookie(request()).split(";")[0] ?? "";
    expect(sessionIdFrom(request(`${APPROVER_COOKIE}=${KEY}; ${value}`))).toBe(
      value.slice(`${SESSION_COOKIE}=`.length),
    );
    expect(sessionIdFrom(request(`${APPROVER_COOKIE}=${KEY}`))).toBeNull();
  });
});
