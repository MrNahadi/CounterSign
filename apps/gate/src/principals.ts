import { createHash, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { type Mandate, parseMandate } from "@countersign/mandate";
import { z } from "zod";

// Principal keys (ADR 0028): one environment variable per principal. A key under 32 characters
// counts as unset. The principal comes only from the key, and its mandate is fixed by the gate.
export const SUPPORT_AGENT_KEY_VAR = "COUNTERSIGN_SUPPORT_AGENT_KEY";
export const MIN_KEY_LENGTH = 32;

export type PrincipalName = "support-agent";

export type Principal = { name: PrincipalName; mandate: Mandate };

export type Environment = Readonly<Record<string, string | undefined>>;

const KeySchema = z.string().min(MIN_KEY_LENGTH);

const PRINCIPAL_KEYS: readonly { name: PrincipalName; variable: string }[] = [
  { name: "support-agent", variable: SUPPORT_AGENT_KEY_VAR },
];

export type PrincipalEnv = {
  keys: { name: PrincipalName; key: string }[];
  // Variables that are missing or too short. Names only, never values.
  unset: string[];
};

// Reads the principal keys from the environment with zod.
export function parsePrincipalEnv(env: Environment): PrincipalEnv {
  const keys: PrincipalEnv["keys"] = [];
  const unset: string[] = [];
  for (const { name, variable } of PRINCIPAL_KEYS) {
    const parsed = KeySchema.safeParse(env[variable]);
    if (parsed.success) keys.push({ name, key: parsed.data });
    else unset.push(variable);
  }
  return { keys, unset };
}

const digest = (value: string) => createHash("sha256").update(value, "utf8").digest();

// `Authorization: Bearer <key>`, read with zod into the key alone.
const BearerHeader = z
  .string()
  .regex(/^Bearer \S+$/)
  .transform((header) => header.slice("Bearer ".length));

// The key from an `Authorization` header, or null for no header, another scheme or an empty key.
export function bearerKey(header: unknown): string | null {
  const parsed = BearerHeader.safeParse(header);
  return parsed.success ? parsed.data : null;
}

const SUPPORT_AGENT_MANDATE = new URL(
  "../../../packages/mandate/fixtures/kikapu-studio-v3.json",
  import.meta.url,
);

// The mandate file's parsed JSON. Throws if the file can't be read or isn't JSON.
export function readSupportAgentMandate(): unknown {
  return JSON.parse(readFileSync(SUPPORT_AGENT_MANDATE, "utf8"));
}

export type Principals = {
  // The principal a header names, or null. Every refusal looks the same.
  authenticate(header: string | undefined): Principal | null;
  // Variables to name in the startup log line.
  unset: string[];
  // Why the mandate didn't load, or null.
  mandateProblem: string | null;
};

export type PrincipalOptions = {
  env: Environment;
  // The support agent's mandate JSON, for tests. Defaults to the kikapu-studio v3 fixture.
  readMandate?: () => unknown;
};

// Parses the env and the mandate once. With no usable key or no mandate, every header is refused.
export function loadPrincipals(options: PrincipalOptions): Principals {
  const { keys, unset } = parsePrincipalEnv(options.env);
  let mandate: Mandate | null = null;
  let mandateProblem: string | null = null;
  try {
    const parsed = parseMandate((options.readMandate ?? readSupportAgentMandate)());
    if (parsed.ok) mandate = parsed.mandate;
    else mandateProblem = parsed.error;
  } catch {
    mandateProblem = "The support agent's mandate file couldn't be read.";
  }
  const known = keys.map(({ name, key }) => ({ name, hash: digest(key) }));

  return {
    unset,
    mandateProblem,
    authenticate(header) {
      const presented = bearerKey(header);
      if (presented === null || mandate === null) return null;
      const presentedHash = digest(presented);
      // Every key is compared, with no early exit, so timing doesn't say which one matched.
      let matched: PrincipalName | null = null;
      for (const { name, hash } of known) {
        if (timingSafeEqual(presentedHash, hash)) matched = name;
      }
      return matched === null ? null : { name: matched, mandate };
    },
  };
}
