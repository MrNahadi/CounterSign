import { describe, expect, it } from "vitest";
import { APPROVER_KEY_VAR, loadApprover } from "../src/approver";
import {
  loadPrincipals,
  OPS_AGENT_KEY_VAR,
  parsePrincipalEnv,
  readPrincipalMandate,
  readSupportAgentMandate,
  SUPPORT_AGENT_KEY_VAR,
} from "../src/principals";

const KEY = "test-support-agent-key-0123456789abcdef";
const OPS_KEY = "test-ops-agent-key-0123456789abcdef0123";
const APPROVER_KEY = "approver-key-illustrative-0123456789abcd";

const principals = (env: Record<string, string | undefined>) => loadPrincipals({ env });

describe("principal keys", () => {
  it("authenticates the support agent with the kikapu-studio v3 mandate", () => {
    const found = principals({ [SUPPORT_AGENT_KEY_VAR]: KEY }).authenticate(`Bearer ${KEY}`);
    expect(found?.name).toBe("support-agent");
    expect(found?.mandate.principal).toBe("support-agent");
    expect(found?.mandate.version).toBe(3);
  });

  it("parses each mandate once", () => {
    const reads: string[] = [];
    const loaded = loadPrincipals({
      env: { [SUPPORT_AGENT_KEY_VAR]: KEY },
      readMandate: (name) => {
        reads.push(name);
        return name === "support-agent" ? readSupportAgentMandate() : readPrincipalMandate(name);
      },
    });
    loaded.authenticate(`Bearer ${KEY}`);
    loaded.authenticate(`Bearer ${KEY}`);
    expect(reads).toEqual(["support-agent", "ops-agent"]);
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
    expect(loaded.unset).toEqual([SUPPORT_AGENT_KEY_VAR, OPS_AGENT_KEY_VAR]);
  });

  it("refuses every header with no key configured, naming the variables and no value", () => {
    const loaded = principals({});
    expect(loaded.authenticate(`Bearer ${KEY}`)).toBeNull();
    expect(loaded.unset).toEqual([SUPPORT_AGENT_KEY_VAR, OPS_AGENT_KEY_VAR]);
    const parsed = parsePrincipalEnv({ [SUPPORT_AGENT_KEY_VAR]: "short-secret" });
    expect(JSON.stringify(parsed)).not.toContain("short-secret");
  });

  it("refuses every header when the mandate doesn't parse", () => {
    const loaded = loadPrincipals({
      env: { [SUPPORT_AGENT_KEY_VAR]: KEY },
      readMandate: () => ({ nope: true }),
    });
    expect(loaded.authenticate(`Bearer ${KEY}`)).toBeNull();
    expect(loaded.mandateProblems.map((each) => each.principal)).toEqual([
      "support-agent",
      "ops-agent",
    ]);
    expect(loaded.mandates).toEqual([]);
  });

  it("refuses every header when the mandate can't be read", () => {
    const loaded = loadPrincipals({
      env: { [SUPPORT_AGENT_KEY_VAR]: KEY },
      readMandate: () => {
        throw new Error("ENOENT /secret/path");
      },
    });
    expect(loaded.authenticate(`Bearer ${KEY}`)).toBeNull();
    expect(JSON.stringify(loaded.mandateProblems)).not.toContain("/secret");
  });
});

describe("the ops agent's key", () => {
  const both = { [SUPPORT_AGENT_KEY_VAR]: KEY, [OPS_AGENT_KEY_VAR]: OPS_KEY };

  it("authenticates the ops agent with the kikapu-studio-ops v1 mandate", () => {
    const found = principals(both).authenticate(`Bearer ${OPS_KEY}`);
    expect(found?.name).toBe("ops-agent");
    expect(found?.mandate.id).toBe("kikapu-studio-ops");
    expect(found?.mandate.version).toBe(1);
    expect(found?.mandate.principal).toBe("ops-agent");
  });

  it("authenticates each principal only with its own key and mandate", () => {
    const loaded = principals(both);
    expect(loaded.authenticate(`Bearer ${KEY}`)?.mandate.id).toBe("kikapu-studio");
    expect(loaded.authenticate(`Bearer ${OPS_KEY}`)?.mandate.id).toBe("kikapu-studio-ops");
    expect(loaded.unset).toEqual([]);
    expect(loaded.mandateProblems).toEqual([]);
    expect(loaded.mandates.map((mandate) => mandate.id)).toEqual([
      "kikapu-studio",
      "kikapu-studio-ops",
    ]);
  });

  it("leaves the support agent working when only the ops key is unset", () => {
    const loaded = principals({ [SUPPORT_AGENT_KEY_VAR]: KEY, [OPS_AGENT_KEY_VAR]: "short" });
    expect(loaded.authenticate(`Bearer ${KEY}`)?.name).toBe("support-agent");
    expect(loaded.authenticate("Bearer short")).toBeNull();
    expect(loaded.unset).toEqual([OPS_AGENT_KEY_VAR]);
  });

  it("counts two principal variables with the same value as both unset, naming no value", () => {
    const loaded = principals({ [SUPPORT_AGENT_KEY_VAR]: KEY, [OPS_AGENT_KEY_VAR]: KEY });
    expect(loaded.authenticate(`Bearer ${KEY}`)).toBeNull();
    expect(loaded.unset).toEqual([SUPPORT_AGENT_KEY_VAR, OPS_AGENT_KEY_VAR]);
    expect(
      JSON.stringify(parsePrincipalEnv({ [SUPPORT_AGENT_KEY_VAR]: KEY, [OPS_AGENT_KEY_VAR]: KEY })),
    ).not.toContain(KEY);
  });

  it("refuses only the principal whose mandate doesn't load", () => {
    const loaded = loadPrincipals({
      env: both,
      readMandate: (name) => (name === "ops-agent" ? { nope: true } : readPrincipalMandate(name)),
    });
    expect(loaded.authenticate(`Bearer ${OPS_KEY}`)).toBeNull();
    expect(loaded.authenticate(`Bearer ${KEY}`)?.name).toBe("support-agent");
    expect(loaded.mandateProblems.map((each) => each.principal)).toEqual(["ops-agent"]);
    expect(loaded.mandates.map((mandate) => mandate.id)).toEqual(["kikapu-studio"]);
  });
});

describe("the approver key", () => {
  const approverFor = (env: Record<string, string>) =>
    loadApprover({ ...env, [APPROVER_KEY_VAR]: APPROVER_KEY });

  it("works when it differs from both principal keys", () => {
    const approver = approverFor({ [SUPPORT_AGENT_KEY_VAR]: KEY, [OPS_AGENT_KEY_VAR]: OPS_KEY });
    expect(approver.unset).toBe(false);
    expect(approver.authenticate(`Bearer ${APPROVER_KEY}`)).toBe(true);
  });

  it.each([
    [
      "the support agent's key",
      { [SUPPORT_AGENT_KEY_VAR]: APPROVER_KEY, [OPS_AGENT_KEY_VAR]: OPS_KEY },
    ],
    ["the ops agent's key", { [SUPPORT_AGENT_KEY_VAR]: KEY, [OPS_AGENT_KEY_VAR]: APPROVER_KEY }],
    [
      "both principal keys, which are themselves unset for being equal",
      { [SUPPORT_AGENT_KEY_VAR]: APPROVER_KEY, [OPS_AGENT_KEY_VAR]: APPROVER_KEY },
    ],
  ])("counts as unset when it equals %s", (_label, env) => {
    const approver = approverFor(env);
    expect(approver.unset).toBe(true);
    expect(approver.authenticate(`Bearer ${APPROVER_KEY}`)).toBe(false);
  });
});
