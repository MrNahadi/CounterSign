import { createHash, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { bearerKey, type Environment, MIN_KEY_LENGTH, parsePrincipalEnv } from "./principals";

// The approver key (ADR 0032): the one credential the gate's approval API takes. It follows the
// principal-key rules, and a value equal to any principal key also counts as unset, so no agent
// can answer its own step-up. Read by the gate only.
export const APPROVER_KEY_VAR = "COUNTERSIGN_APPROVER_KEY";

export type Approver = {
  // True only for `Authorization: Bearer <the approver key>`. Every refusal looks the same.
  authenticate(header: string | undefined): boolean;
  // True when the variable is missing, too short or a principal key's value.
  unset: boolean;
};

const KeySchema = z.string().min(MIN_KEY_LENGTH);

const digest = (value: string) => createHash("sha256").update(value, "utf8").digest();

// Reads the approver key from the environment with zod, once.
export function loadApprover(env: Environment): Approver {
  const parsed = KeySchema.safeParse(env[APPROVER_KEY_VAR]);
  const principalHashes = parsePrincipalEnv(env).keys.map(({ key }) => digest(key));
  const hash = parsed.success ? digest(parsed.data) : null;
  // Compared in constant time against every principal key, with no early exit.
  let clashes = false;
  if (hash !== null) {
    for (const principal of principalHashes) {
      if (timingSafeEqual(hash, principal)) clashes = true;
    }
  }
  const key = clashes ? null : hash;
  return {
    unset: key === null,
    authenticate(header) {
      const presented = bearerKey(header);
      if (presented === null || key === null) return false;
      return timingSafeEqual(digest(presented), key);
    },
  };
}

// The startup line for an unset approver key: the variable's name, never its value.
export function approverLines(approver: Approver): string[] {
  if (!approver.unset) return [];
  return [
    `Approver key unset: ${APPROVER_KEY_VAR} (needs ${MIN_KEY_LENGTH} or more characters and must differ from every principal key). The approval API answers 401.`,
  ];
}
