import { createHash, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { type Mandate, parseMandate } from "@countersign/mandate";
import { z } from "zod";

// Principal keys (ADR 0028): one environment variable per principal. A key under 32 characters
// counts as unset, and so do two principal variables holding the same value (ADR 0039). The
// principal comes only from the key, and its mandate is fixed by the gate.
export const SUPPORT_AGENT_KEY_VAR = "COUNTERSIGN_SUPPORT_AGENT_KEY";
export const OPS_AGENT_KEY_VAR = "COUNTERSIGN_OPS_AGENT_KEY";
export const MIN_KEY_LENGTH = 32;

export type PrincipalName = "support-agent" | "ops-agent";

export type Principal = { name: PrincipalName; mandate: Mandate };

export type Environment = Readonly<Record<string, string | undefined>>;

const KeySchema = z.string().min(MIN_KEY_LENGTH);

const PRINCIPAL_KEYS: readonly { name: PrincipalName; variable: string }[] = [
  { name: "support-agent", variable: SUPPORT_AGENT_KEY_VAR },
  { name: "ops-agent", variable: OPS_AGENT_KEY_VAR },
];

export type PrincipalEnv = {
  keys: { name: PrincipalName; key: string }[];
  // Variables that are missing, too short or equal to another principal's. Names only, never values.
  unset: string[];
};

// Every principal variable whose value is long enough, before the equality check. The approver
// key must differ from each of these, even ones that count as unset for sharing a value.
export function principalKeyCandidates(env: Environment): string[] {
  return PRINCIPAL_KEYS.flatMap(({ variable }) => {
    const parsed = KeySchema.safeParse(env[variable]);
    return parsed.success ? [parsed.data] : [];
  });
}

// Reads the principal keys from the environment with zod.
export function parsePrincipalEnv(env: Environment): PrincipalEnv {
  const parsed = PRINCIPAL_KEYS.map(({ name, variable }) => ({
    name,
    variable,
    key: KeySchema.safeParse(env[variable]).data ?? null,
  }));
  const keys: PrincipalEnv["keys"] = [];
  const unset: string[] = [];
  for (const { name, variable, key } of parsed) {
    const shared = parsed.some((other) => other.name !== name && other.key === key);
    if (key !== null && !shared) keys.push({ name, key });
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

const MANDATE_FILES: Record<PrincipalName, URL> = {
  "support-agent": new URL(
    "../../../packages/mandate/fixtures/kikapu-studio-v3.json",
    import.meta.url,
  ),
  "ops-agent": new URL(
    "../../../packages/mandate/fixtures/kikapu-studio-ops-v1.json",
    import.meta.url,
  ),
};

// A principal's mandate file's parsed JSON. Throws if the file can't be read or isn't JSON.
export function readPrincipalMandate(name: PrincipalName): unknown {
  return JSON.parse(readFileSync(MANDATE_FILES[name], "utf8"));
}

// The support agent's mandate file's parsed JSON.
export function readSupportAgentMandate(): unknown {
  return readPrincipalMandate("support-agent");
}

// The words startup lines use for each principal.
export const PRINCIPAL_LABELS: Record<PrincipalName, string> = {
  "support-agent": "support agent",
  "ops-agent": "ops agent",
};

export type MandateProblem = { principal: PrincipalName; problem: string };

export type Principals = {
  // The principal a header names, or null. Every refusal looks the same.
  authenticate(header: string | undefined): Principal | null;
  // Variables to name in the startup log line.
  unset: string[];
  // Each mandate that didn't load, and why. Only its own principal is refused.
  mandateProblems: MandateProblem[];
  // The mandates that loaded, so approval cards can show the checks a step-up's rules used.
  mandates: Mandate[];
};

export type PrincipalOptions = {
  env: Environment;
  // A principal's mandate JSON, for tests. Defaults to that principal's fixture.
  readMandate?: (name: PrincipalName) => unknown;
};

function loadMandate(
  name: PrincipalName,
  read: (name: PrincipalName) => unknown,
): { mandate: Mandate } | { problem: string } {
  try {
    const parsed = parseMandate(read(name));
    return parsed.ok ? { mandate: parsed.mandate } : { problem: parsed.error };
  } catch {
    return { problem: `The ${PRINCIPAL_LABELS[name]}'s mandate file couldn't be read.` };
  }
}

// Parses the env and the mandates once. A principal with no usable key or no mandate is refused.
export function loadPrincipals(options: PrincipalOptions): Principals {
  const { keys, unset } = parsePrincipalEnv(options.env);
  const read = options.readMandate ?? readPrincipalMandate;
  const mandates = new Map<PrincipalName, Mandate>();
  const mandateProblems: MandateProblem[] = [];
  for (const { name } of PRINCIPAL_KEYS) {
    const loaded = loadMandate(name, read);
    if ("mandate" in loaded) mandates.set(name, loaded.mandate);
    else mandateProblems.push({ principal: name, problem: loaded.problem });
  }
  const known = keys.map(({ name, key }) => ({ name, hash: digest(key) }));

  return {
    unset,
    mandateProblems,
    mandates: [...mandates.values()],
    authenticate(header) {
      const presented = bearerKey(header);
      if (presented === null) return null;
      const presentedHash = digest(presented);
      // Every key is compared, with no early exit, so timing doesn't say which one matched.
      let matched: PrincipalName | null = null;
      for (const { name, hash } of known) {
        if (timingSafeEqual(presentedHash, hash)) matched = name;
      }
      const mandate = matched === null ? undefined : mandates.get(matched);
      return matched === null || mandate === undefined ? null : { name: matched, mandate };
    },
  };
}
