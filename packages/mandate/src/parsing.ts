// What the mandate, case-file and proposal parsers share: the ID rule, and how a failed parse is
// put into words.

import { z } from "zod";

// An ID with no blank and no leading or trailing spaces. Rejected, never trimmed.
export const IdSchema = z
  .string()
  .regex(/^\S(?:.*\S)?$/, "Must be a non-blank ID without outer spaces");

export type ParseIssue = { path: (string | number)[]; message: string };

// A failed parse's issues. An unknown key's own path names the bad field, not just the object
// holding it.
export function parseIssues(error: z.ZodError): ParseIssue[] {
  return error.issues.flatMap((issue): ParseIssue[] => {
    const path = issue.path.map((key) => (typeof key === "number" ? key : String(key)));
    if (issue.code === "unrecognized_keys") {
      return issue.keys.map((key) => ({ path: [...path, key], message: `Unknown key ${key}` }));
    }
    return [{ path, message: issue.message }];
  });
}

// A path as `.rules[2].when`, or nothing at the root.
export function describePath(path: readonly (string | number)[]): string {
  return path.map((key) => (typeof key === "number" ? `[${key}]` : `.${key}`)).join("");
}

// The first issue as one line, after `prefix`: "Case file.now: Invalid ISO datetime".
export function firstIssueMessage(prefix: string, error: z.ZodError): string {
  const [first] = parseIssues(error);
  if (!first) return `${prefix}: invalid`;
  return `${prefix}${describePath(first.path)}: ${first.message}`;
}
