import { describe, expect, it } from "vitest";
import {
  loadPrincipals,
  parsePrincipalEnv,
  readSupportAgentMandate,
  SUPPORT_AGENT_KEY_VAR,
} from "../src/principals";

const KEY = "test-support-agent-key-0123456789abcdef";

const principals = (env: Record<string, string | undefined>) => loadPrincipals({ env });

describe("principal keys", () => {
  it("authenticates the support agent with the kikapu-studio v3 mandate", () => {
    const found = principals({ [SUPPORT_AGENT_KEY_VAR]: KEY }).authenticate(`Bearer ${KEY}`);
    expect(found?.name).toBe("support-agent");
    expect(found?.mandate.principal).toBe("support-agent");
    expect(found?.mandate.version).toBe(3);
  });

  it("parses the mandate once", () => {
    let reads = 0;
    const loaded = loadPrincipals({
      env: { [SUPPORT_AGENT_KEY_VAR]: KEY },
      readMandate: () => {
        reads += 1;
        return readSupportAgentMandate();
      },
    });
    loaded.authenticate(`Bearer ${KEY}`);
    loaded.authenticate(`Bearer ${KEY}`);
    expect(reads).toBe(1);
  });

  it("refuses every bad header the same way", () => {
    const loaded = principals({ [SUPPORT_AGENT_KEY_VAR]: KEY });
    const bad = [
      undefined,
      "",
      KEY,
      `Basic ${KEY}`,
      `bearer ${KEY}`,
      "Bearer ",
      "Bearer",
      `Bearer ${KEY}x`,
      `Bearer ${KEY.slice(1)}`,
      "Bearer wrong-key-wrong-key-wrong-key-wrong-key",
    ];
    for (const header of bad) expect(loaded.authenticate(header)).toBeNull();
  });

  it("treats a key under 32 characters as unset", () => {
    const short = "a".repeat(31);
    const loaded = principals({ [SUPPORT_AGENT_KEY_VAR]: short });
    expect(loaded.authenticate(`Bearer ${short}`)).toBeNull();
    expect(loaded.unset).toEqual([SUPPORT_AGENT_KEY_VAR]);
  });

  it("refuses every header with no key configured, naming the variable and no value", () => {
    const loaded = principals({});
    expect(loaded.authenticate(`Bearer ${KEY}`)).toBeNull();
    expect(loaded.unset).toEqual([SUPPORT_AGENT_KEY_VAR]);
    const parsed = parsePrincipalEnv({ [SUPPORT_AGENT_KEY_VAR]: "short-secret" });
    expect(JSON.stringify(parsed)).not.toContain("short-secret");
  });

  it("refuses every header when the mandate doesn't parse", () => {
    const loaded = loadPrincipals({
      env: { [SUPPORT_AGENT_KEY_VAR]: KEY },
      readMandate: () => ({ nope: true }),
    });
    expect(loaded.authenticate(`Bearer ${KEY}`)).toBeNull();
    expect(loaded.mandateProblem).not.toBeNull();
  });

  it("refuses every header when the mandate can't be read", () => {
    const loaded = loadPrincipals({
      env: { [SUPPORT_AGENT_KEY_VAR]: KEY },
      readMandate: () => {
        throw new Error("ENOENT /secret/path");
      },
    });
    expect(loaded.authenticate(`Bearer ${KEY}`)).toBeNull();
    expect(loaded.mandateProblem).not.toContain("/secret");
  });
});
