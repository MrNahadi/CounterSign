import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NUDGE_TIMEOUT_MS, type NudgeFetch, nudgeResolve, resolveAgentUrl } from "../src/nudge";

describe("nudgeResolve", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("posts { dispute_id } to <RESOLVE_AGENT_URL>/disputes once", async () => {
    const seen: { url: string; init: Parameters<NudgeFetch>[1] }[] = [];
    const fetch: NudgeFetch = async (url, init) => {
      seen.push({ url, init });
      return { ok: true };
    };

    const took = await nudgeResolve("PP-D-1", {
      env: { RESOLVE_AGENT_URL: "https://resolve.example" },
      fetch,
    });

    expect(took).toBe(true);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.url).toBe("https://resolve.example/disputes");
    expect(seen[0]?.init.method).toBe("POST");
    expect(seen[0]?.init.headers["content-type"]).toBe("application/json");
    expect(JSON.parse(seen[0]?.init.body ?? "")).toEqual({ dispute_id: "PP-D-1" });
  });

  it("gives up after 2 seconds and aborts the request", async () => {
    let signal: AbortSignal | undefined;
    const fetch: NudgeFetch = (_url, init) => {
      signal = init.signal;
      // Ignores its signal, so only the timeout settles the nudge.
      return new Promise(() => {});
    };
    let settled: boolean | undefined;
    const nudge = nudgeResolve("PP-D-1", { env: {}, fetch }).then((took) => {
      settled = took;
    });

    await vi.advanceTimersByTimeAsync(NUDGE_TIMEOUT_MS - 1);
    expect(settled).toBeUndefined();
    expect(signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await nudge;
    expect(settled).toBe(false);
    expect(signal?.aborted).toBe(true);
    expect(NUDGE_TIMEOUT_MS).toBe(2000);
  });

  it("answers false, never throwing, for a failure, a refusal or a bad address", async () => {
    const failing: NudgeFetch = async () => {
      throw new Error("connect ECONNREFUSED");
    };
    const thrower: NudgeFetch = () => {
      throw new Error("sync");
    };
    const refusing: NudgeFetch = async () => ({ ok: false });
    const unused: NudgeFetch = async () => {
      throw new Error("should not be called");
    };

    expect(await nudgeResolve("PP-D-1", { env: {}, fetch: failing })).toBe(false);
    expect(await nudgeResolve("PP-D-1", { env: {}, fetch: thrower })).toBe(false);
    expect(await nudgeResolve("PP-D-1", { env: {}, fetch: refusing })).toBe(false);
    expect(
      await nudgeResolve("PP-D-1", { env: { RESOLVE_AGENT_URL: "ftp://x" }, fetch: unused }),
    ).toBe(false);
  });
});

describe("resolveAgentUrl", () => {
  it("defaults to the local Resolve and refuses anything but http(s)", () => {
    expect(resolveAgentUrl({})?.toString()).toBe("http://127.0.0.1:8788/");
    expect(resolveAgentUrl({ RESOLVE_AGENT_URL: "  " })?.toString()).toBe("http://127.0.0.1:8788/");
    expect(resolveAgentUrl({ RESOLVE_AGENT_URL: "not a url" })).toBeNull();
    expect(resolveAgentUrl({ RESOLVE_AGENT_URL: "file:///etc" })).toBeNull();
  });
});
