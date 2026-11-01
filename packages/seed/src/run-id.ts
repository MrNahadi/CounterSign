// Run IDs and the vault tokens a seed run needs. Shared by the seed CLI and the gate's demo reset.

import { randomBytes } from "node:crypto";
import { TimestampSchema } from "@countersign/mandate";
import { z } from "zod";
import { RunIdSchema, type SeedBuyer } from "./seed-catalog";

export const VAULT_ENV_NAMES = ["PAYPAL_SEED_VAULT_TOKEN", "PAYPAL_SEED_VAULT_TOKEN_B"] as const;

const RandomSuffixSchema = z.string().regex(/^[a-z0-9]{4,10}$/);

/** The random part of a new run ID: 6 lowercase letters and digits. */
export function randomRunSuffix(): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  return [...randomBytes(6)].map((byte) => alphabet[byte % alphabet.length]).join("");
}

/** A new run ID: the seeding date and a random suffix, such as `20261017k3x9qa`. */
export function newRunId(seededAt: string, suffix: string): string {
  const date = TimestampSchema.parse(seededAt).slice(0, 10).replaceAll("-", "");
  return RunIdSchema.parse(`${date}${RandomSuffixSchema.parse(suffix)}`);
}

/** Both vault tokens, or the names (never the values) of those that are missing or empty. */
export function readVaultTokens(
  env: Readonly<Record<string, string | undefined>>,
): { ok: true; tokens: Record<SeedBuyer, string> } | { ok: false; missing: string[] } {
  const [nameA, nameB] = VAULT_ENV_NAMES;
  const a = env[nameA];
  const b = env[nameB];
  const missing = VAULT_ENV_NAMES.filter((name) => !env[name]);
  if (a && b && missing.length === 0) return { ok: true, tokens: { A: a, B: b } };
  return { ok: false, missing };
}
