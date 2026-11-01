import { describe, expect, it } from "vitest";
import {
  newRunId,
  randomRunSuffix,
  readVaultTokens,
  StoredRowSchema,
  VAULT_ENV_NAMES,
} from "../src";

describe("readVaultTokens", () => {
  it("gives both tokens when both are set", () => {
    expect(
      readVaultTokens({ PAYPAL_SEED_VAULT_TOKEN: "a", PAYPAL_SEED_VAULT_TOKEN_B: "b" }),
    ).toEqual({
      ok: true,
      tokens: { A: "a", B: "b" },
    });
  });

  it("names only the missing variables, in VAULT_ENV_NAMES order", () => {
    expect(readVaultTokens({})).toEqual({ ok: false, missing: [...VAULT_ENV_NAMES] });
    expect(readVaultTokens({ PAYPAL_SEED_VAULT_TOKEN: "a" })).toEqual({
      ok: false,
      missing: ["PAYPAL_SEED_VAULT_TOKEN_B"],
    });
    expect(
      readVaultTokens({ PAYPAL_SEED_VAULT_TOKEN: "", PAYPAL_SEED_VAULT_TOKEN_B: "secret-b" }),
    ).toEqual({ ok: false, missing: ["PAYPAL_SEED_VAULT_TOKEN"] });
  });

  it("never puts a value in the missing list", () => {
    const result = readVaultTokens({ PAYPAL_SEED_VAULT_TOKEN_B: "secret-b" });
    expect(JSON.stringify(result)).not.toContain("secret-b");
  });
});

describe("randomRunSuffix", () => {
  it("is 6 characters of lowercase letters and digits", () => {
    for (let i = 0; i < 50; i++) expect(randomRunSuffix()).toMatch(/^[a-z0-9]{6}$/);
  });

  it("builds a valid run ID with newRunId", () => {
    expect(newRunId("2026-10-17T09:00:00.000Z", "k3x9qa")).toBe("20261017k3x9qa");
  });
});

describe("StoredRowSchema", () => {
  it("is exported and rejects a missing row", () => {
    expect(StoredRowSchema.safeParse(undefined).success).toBe(false);
  });
});
