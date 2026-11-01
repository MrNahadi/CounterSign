import { request } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PAIRING_MESSAGES } from "../../apps/gate/src/pairing";
import { fixtures } from "./fixtures";
import { HARNESS_KEY, HARNESS_PAIRING_CODE, PAIRING_REFUSED, startUpstream } from "./upstream";

// The fake gate and Resolve the harness serves its fixtures from, through `startUpstream`.

const SIGNED_IN = { authorization: `Bearer ${HARNESS_KEY}` };
const NOW = new Date("2026-11-01T12:00:00Z");

/** One request on its own connection, so no socket outlives a fake that closed. */
function call(
  url: string,
  options: { method?: string; headers?: Record<string, string> } = {},
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const outgoing = request(
      url,
      { method: options.method ?? "GET", headers: options.headers ?? {}, agent: false },
      (incoming) => {
        let body = "";
        incoming.setEncoding("utf8");
        incoming.on("data", (chunk: string) => {
          body += chunk;
        });
        incoming.on("end", () => resolve({ status: incoming.statusCode ?? 0, body }));
      },
    );
    outgoing.on("error", reject);
    outgoing.end();
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("ui-shots upstream", () => {
  it("serves the gate's approvals to the harness key and refuses anyone else", async () => {
    const upstream = await startUpstream(fixtures(NOW));
    try {
      const signedIn = await call(`${upstream.gateUrl}/approvals?before=9`, {
        headers: SIGNED_IN,
      });
      expect(signedIn.status).toBe(200);
      expect(JSON.parse(signedIn.body)).toEqual(fixtures(NOW).approvals);

      const anonymous = await call(`${upstream.gateUrl}/approvals`);
      expect(anonymous.status).toBe(401);
    } finally {
      await upstream.close();
    }
  });

  it("mints a pairing code for the harness key and refuses every trade with the gate's sentence", async () => {
    const upstream = await startUpstream(fixtures(NOW));
    try {
      const minted = await call(`${upstream.gateUrl}/approvals/pairing-codes`, {
        method: "POST",
        headers: SIGNED_IN,
      });
      expect(minted.status).toBe(201);
      expect(JSON.parse(minted.body)).toEqual({ code: HARNESS_PAIRING_CODE });
      expect(HARNESS_PAIRING_CODE).toMatch(/^[A-Za-z0-9_-]{22}$/);

      const anonymousMint = await call(`${upstream.gateUrl}/approvals/pairing-codes`, {
        method: "POST",
      });
      expect(anonymousMint.status).toBe(401);

      const traded = await call(`${upstream.gateUrl}/approvals/pair`, { method: "POST" });
      expect(traded.status).toBe(401);
      expect(JSON.parse(traded.body)).toEqual({ message: PAIRING_REFUSED });
      expect(PAIRING_REFUSED).toBe(PAIRING_MESSAGES.refused);
    } finally {
      await upstream.close();
    }
  });

  it("answers 404 and logs any path the fixtures don't hold", async () => {
    const log = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const upstream = await startUpstream(fixtures(NOW));
    try {
      const gate = await call(`${upstream.gateUrl}/nowhere`, { headers: SIGNED_IN });
      expect(gate.status).toBe(404);
      expect(JSON.parse(gate.body)).toEqual({ message: "Not in the ui-shots fixtures." });

      const resolve = await call(`${upstream.resolveUrl}/threads`, { method: "POST" });
      expect(resolve.status).toBe(404);
    } finally {
      await upstream.close();
    }
    expect(log).toHaveBeenCalledWith("upstream: no fixture for GET /nowhere\n");
    expect(log).toHaveBeenCalledWith("upstream: no fixture for POST /threads\n");
  });

  it("frees both ports when it closes", async () => {
    const first = await startUpstream(fixtures(NOW));
    await first.close();
    const second = await startUpstream(fixtures(NOW));
    await second.close();
  });
});
