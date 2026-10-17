// Which database the CLIs open, and how they say it went wrong without showing a secret.
// `DATABASE_URL` wins when it's set; otherwise a PGlite directory, `.countersign/pglite` from
// the repo root unless `--pglite <dir>` names another. Every message names the database as
// "DATABASE_URL" or the directory, never the connection string.

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { DatabaseTarget } from "./client";

/** The local PGlite directory the CLIs use when nothing else is named. Git ignores it. */
export const DEFAULT_PGLITE_DIR = fileURLToPath(
  new URL("../../../.countersign/pglite", import.meta.url),
);

export type Environment = Readonly<Record<string, string | undefined>>;

// An empty or blank DATABASE_URL counts as unset, as `DATABASE_URL=` in an env file means.
const EnvSchema = z.object({
  DATABASE_URL: z
    .string()
    .optional()
    .transform((value) => (value === undefined || value.trim() === "" ? undefined : value)),
});

/** Picks the database: DATABASE_URL when set, otherwise the PGlite directory. */
export function resolveDatabaseTarget(
  env: Environment,
  pgliteDir: string | undefined,
): DatabaseTarget {
  const { DATABASE_URL } = EnvSchema.parse({ DATABASE_URL: env.DATABASE_URL });
  if (DATABASE_URL !== undefined) return { kind: "postgres", url: DATABASE_URL };
  return { kind: "pglite", dir: pgliteDir === undefined ? DEFAULT_PGLITE_DIR : resolve(pgliteDir) };
}

/** How messages name a database: "DATABASE_URL", never its value, or the PGlite directory. */
export function targetName(target: DatabaseTarget): string {
  return target.kind === "postgres" ? "DATABASE_URL" : target.dir;
}

export type PgliteOption =
  | { ok: true; pgliteDir: string | undefined; rest: string[] }
  | { ok: false; error: string };

// A directory named on the command line: not blank, and not another option.
const PgliteDirSchema = z.string().refine((dir) => dir.trim() !== "" && !dir.startsWith("-"));

/** Takes `--pglite <dir>` out of a CLI's arguments. */
export function takePgliteOption(args: readonly string[]): PgliteOption {
  const rest: string[] = [];
  let pgliteDir: string | undefined;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg !== "--pglite") {
      if (arg !== undefined) rest.push(arg);
      continue;
    }
    const dir = PgliteDirSchema.safeParse(args[index + 1]);
    if (!dir.success) return { ok: false, error: "--pglite needs a directory." };
    if (pgliteDir !== undefined) return { ok: false, error: "--pglite is given twice." };
    pgliteDir = dir.data;
    index++;
  }
  return { ok: true, pgliteDir, rest };
}

const URL_LIKE = /[a-z][a-z0-9+.-]*:\/\/\S*/gi;
const REDACTED = "[redacted]";

// The pieces of a connection string that must never be shown: the whole string, and its
// password as written and decoded.
function secretsOf(target: DatabaseTarget): string[] {
  if (target.kind !== "postgres") return [];
  const secrets = [target.url];
  try {
    const { password } = new URL(target.url);
    if (password !== "") secrets.push(password, decodeURIComponent(password));
  } catch {
    // A string that isn't a URL has no parts to pick out; the whole string is still hidden.
  }
  return secrets.filter((secret) => secret.length > 0).sort((a, b) => b.length - a.length);
}

/** Removes the target's connection string, its password and anything URL-shaped from text. */
export function redactSecrets(text: string, target: DatabaseTarget): string {
  let redacted = text;
  for (const secret of secretsOf(target)) redacted = redacted.split(secret).join(REDACTED);
  return redacted.replace(URL_LIKE, REDACTED);
}

// The innermost cause is the driver's own error: Drizzle's wrapper repeats the SQL instead.
function innermost(error: unknown): unknown {
  let current = error;
  for (
    let depth = 0;
    depth < 8 && current instanceof Error && current.cause !== undefined;
    depth++
  ) {
    current = current.cause;
  }
  return current;
}

/** One line saying why a database call failed, with no secret in it. */
export function failureReason(error: unknown, target: DatabaseTarget): string {
  const cause = innermost(error);
  let reason = "unknown error";
  if (cause instanceof Error) {
    const code = (cause as { code?: unknown }).code;
    const message = cause.message.trim();
    if (message !== "") reason = message;
    else if (typeof code === "string" && code !== "") reason = code;
  } else if (typeof cause === "string" && cause.trim() !== "") {
    reason = cause.trim();
  }
  return redactSecrets(reason.replace(/\s*\n\s*/g, " "), target);
}

/** "Couldn't open the database at DATABASE_URL: <reason>", with no secret in it. */
export function openFailure(error: unknown, target: DatabaseTarget): string {
  return `Couldn't open the database at ${targetName(target)}: ${failureReason(error, target)}`;
}
