import { formatMoney } from "@countersign/mandate/money";
import { z } from "zod";
import { APPROVAL_ROUTE_MESSAGES } from "./approval-routes";
import { DECISION_BADGES, type Tone } from "./decisions-view";

// The mandate page's words, the answers it reads, and its three calls (PLAN E2, brief §6 "the
// merchant changes their rules"): compile and read back (E1), replay the decisions in the audit
// log with the draft, and sign it as version N+1. Every answer is parsed with zod before it's
// shown. Client-safe: plain Web APIs, zod and the money module only.

export const COMPILE_PATH = "/api/mandate/compile";
/** The longest plain-English rules the compiler takes (mandate-compiler.ts). */
export const MAX_RULES_CHARS = 4_000;
export const REPLAY_PATH = "/api/mandate/replay";
export const SIGN_PATH = "/api/mandate/sign";

export const MANDATE_COPY = {
  title: "Mandate",
  description:
    "Write your rules in plain English. Countersign compiles them, reads them back, shows what changes and which recorded decisions would flip, and then you sign the new version.",
  signInLine: "Sign in with the approver key to change your rules.",
  inForce: "In force now",
  inForceLine: "The signed mandate the gate decides with.",
  changeTitle: "Change your rules",
  rulesLabel: "Your rules",
  rulesHelp:
    "Write them as you'd tell a new hire. Anything the mandate can't say is listed, not guessed.",
  compile: "Compile",
  compiling: "Compiling",
  readBack: "Read back",
  readBackLine: "Read back by Countersign from the compiled rules, not by the model.",
  modelLine: "Compiled by Gemini, then checked against the mandate schema. Draft only, not signed.",
  leftOut: "Not compiled",
  leftOutLine: "Rules the mandate has no way to say. Nothing was compiled for them.",
  changes: "What changes",
  noChanges: "The draft reads the same as the mandate in force.",
  unchangedRules: (count: number) => `${count} ${count === 1 ? "rule is" : "rules are"} unchanged.`,
  flips: "Decisions it would flip",
  flipsLine:
    "Every decision in the audit log under the mandate in force, run again with the draft through the gate's own rule step, offline: no PayPal, no carrier and no AI.",
  replaying: "Replaying recorded decisions",
  sign: (version: number) => `Sign version ${version}`,
  signing: "Signing",
  signLine: (version: number) =>
    `Signing writes version ${version} and its hash to the audit log. The gate keeps deciding with the version in force until the new file is deployed; switching it over from here isn't built.`,
  signed: (version: number, seq: number) =>
    `Signed version ${version}. Its hash is in audit-log entry #${seq}.`,
  alreadySigned: (version: number, seq: number) =>
    `Version ${version} was already signed with these rules, in audit-log entry #${seq}.`,
  openAuditLog: "Open the audit log",
  unreachable: "The console couldn't be reached. Try again.",
  added: "Added",
  removed: "Removed",
  changed: "Changed",
  before: "Now",
  after: "Draft",
} as const;

const Hash = z.string().regex(/^[0-9a-f]{64}$/);
const Decision = z.enum(["allow", "step_up", "deny"]);

const ReadBackSchema = z.object({
  title: z.string(),
  rules: z.array(
    z.object({
      id: z.string(),
      decide: Decision,
      sentence: z.string(),
      checks: z.string().nullable(),
      reason: z.string().nullable(),
    }),
  ),
  limits: z.array(z.string()),
  payees: z.array(z.string()),
  always: z.array(z.string()),
});
export type ReadBackView = z.infer<typeof ReadBackSchema>;

const DiffItemSchema = z.object({
  area: z.enum(["rule", "limit", "payees", "time_zone"]),
  id: z.string(),
  kind: z.enum(["added", "removed", "changed"]),
  before: z.array(z.string()).nullable(),
  after: z.array(z.string()).nullable(),
});
export type DiffItemView = z.infer<typeof DiffItemSchema>;

export const CompileAnswerSchema = z.object({
  /** Passed back to replay and sign as it came; the gate checks it again. */
  mandate: z.object({ id: z.string(), version: z.number().int().positive() }).loose(),
  hash: Hash,
  readBack: ReadBackSchema,
  leftOut: z.array(z.string()),
  base: z.object({ version: z.number().int().positive(), hash: Hash }),
  diff: z.object({
    items: z.array(DiffItemSchema),
    unchangedRules: z.number().int().nonnegative(),
  }),
});
export type CompileAnswerView = z.infer<typeof CompileAnswerSchema>;

const MandateRef = z.object({ id: z.string(), version: z.number().int().positive(), hash: Hash });

export const FlipSchema = z.object({
  seq: z.number().int().positive(),
  intent_id: z.string(),
  ticket_id: z.string().nullable(),
  action: z.string(),
  amount: z.object({ minor: z.number().int().nonnegative(), currency: z.enum(["USD", "KES"]) }),
  claim: z.string().nullable(),
  before: Decision,
  after: Decision,
  reasons: z.array(z.object({ code: z.string(), detail: z.string() })),
  direction: z.enum(["looser", "tighter"]),
});
export type Flip = z.infer<typeof FlipSchema>;

export const ReplaySchema = z.object({
  base: MandateRef,
  draft: MandateRef,
  replayed: z.number().int().nonnegative(),
  unchanged: z.number().int().nonnegative(),
  flips: z.array(FlipSchema),
  counts: z.record(z.string(), z.number().int().nonnegative()),
  skipped: z.object({
    other_mandate: z.number().int().nonnegative(),
    no_intent: z.number().int().nonnegative(),
    unreadable: z.number().int().nonnegative(),
  }),
  partial: z.boolean(),
});
export type Replay = z.infer<typeof ReplaySchema>;

export const SignedSchema = z.object({
  id: z.string(),
  version: z.number().int().positive(),
  hash: Hash,
  seq: z.number().int().positive(),
  entry_hash: Hash,
  already_signed: z.boolean(),
  in_force: z.object({ version: z.number().int().positive(), hash: Hash }),
});
export type Signed = z.infer<typeof SignedSchema>;

const MessageSchema = z.object({ message: z.string().min(1) });

export type Call<T> = { ok: true; value: T } | { ok: false; message: string; signedOut?: true };

/** Posts JSON to one of the console's mandate routes and reads the answer with `schema`. */
export async function postJson<T>(
  path: string,
  body: unknown,
  schema: z.ZodType<T>,
  deps: { fetch?: typeof fetch } = {},
): Promise<Call<T>> {
  let response: Response;
  try {
    response = await (deps.fetch ?? fetch)(path, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    return { ok: false, message: MANDATE_COPY.unreachable };
  }
  if (response.status === 401) {
    return { ok: false, signedOut: true, message: APPROVAL_ROUTE_MESSAGES.signedOut };
  }
  let answer: unknown;
  try {
    answer = await response.json();
  } catch {
    return { ok: false, message: MANDATE_COPY.unreachable };
  }
  if (response.ok) {
    const parsed = schema.safeParse(answer);
    if (parsed.success) return { ok: true, value: parsed.data };
  } else {
    const refusal = MessageSchema.safeParse(answer);
    if (refusal.success) return { ok: false, message: refusal.data.message };
  }
  return { ok: false, message: MANDATE_COPY.unreachable };
}

export const compileRules = (rules: string, deps?: { fetch?: typeof fetch }) =>
  postJson(COMPILE_PATH, { rules }, CompileAnswerSchema, deps);

export const replayDraft = (mandate: unknown, deps?: { fetch?: typeof fetch }) =>
  postJson(REPLAY_PATH, { mandate }, ReplaySchema, deps);

export const signDraft = (mandate: unknown, baseHash: string, deps?: { fetch?: typeof fetch }) =>
  postJson(SIGN_PATH, { mandate, base_hash: baseHash }, SignedSchema, deps);

// --- The replay in words ---------------------------------------------------------------------

const plural = (count: number, one: string, many = `${one}s`) =>
  `${count} ${count === 1 ? one : many}`;

/**
 * What the change would have done, as the brief's example puts it ("This change would have
 * auto-approved 3 attack tickets"): the flips toward allow first, since they let money move with
 * no one asked, then holds that were denials, then the tighter ones.
 */
export function replaySummary(replay: Replay): string[] {
  const { flips } = replay;
  const base = `version ${replay.base.version}`;
  const toAllow = flips.filter((flip) => flip.after === "allow").length;
  const toHold = flips.filter((flip) => flip.before === "deny" && flip.after === "step_up").length;
  const tighter = flips.filter((flip) => flip.direction === "tighter").length;
  const lines: string[] = [];
  if (replay.replayed === 0) {
    lines.push(`The audit log holds no decisions under ${base} to replay.`);
  } else if (flips.length === 0) {
    lines.push(
      `This change flips none of the ${plural(replay.replayed, "decision")} recorded under ${base}.`,
    );
  } else {
    if (toAllow > 0) {
      lines.push(
        `This change would have auto-approved ${plural(toAllow, "action")} that ${base} held or denied.`,
      );
    }
    if (toHold > 0) {
      lines.push(`It would have held ${plural(toHold, "action")} that ${base} denied.`);
    }
    if (tighter > 0) {
      lines.push(
        `It would have held or denied ${plural(tighter, "action")} that ${base} let through further.`,
      );
    }
    lines.push(
      `${plural(replay.unchanged, "other decision")} of ${replay.replayed} stay the same.`,
    );
  }
  const { other_mandate, no_intent, unreadable } = replay.skipped;
  const skipped: string[] = [];
  if (other_mandate > 0) skipped.push(`${plural(other_mandate, "decision")} under another version`);
  if (no_intent > 0) skipped.push(`${plural(no_intent, "proposal")} refused before any rule`);
  if (unreadable > 0)
    skipped.push(`${plural(unreadable, "unreadable entry", "unreadable entries")}`);
  if (skipped.length > 0) lines.push(`Not replayed: ${skipped.join(", ")}.`);
  if (replay.partial) lines.push("Only the newest decisions were replayed; older ones weren't.");
  return lines;
}

export type FlipView = {
  key: string;
  title: string;
  amount: string;
  ticket: string | null;
  before: { label: string; tone: Tone };
  after: { label: string; tone: Tone };
  reasons: { code: string; detail: string }[];
  href: string;
};

export function flipView(flip: Flip): FlipView {
  return {
    key: `${flip.seq}`,
    title: flip.action,
    amount: formatMoney(flip.amount),
    ticket: flip.ticket_id,
    before: DECISION_BADGES[flip.before],
    after: DECISION_BADGES[flip.after],
    reasons: flip.reasons,
    href: `/decisions/${flip.seq}`,
  };
}

export const DIFF_LABELS = {
  added: { label: MANDATE_COPY.added, tone: "positive" },
  removed: { label: MANDATE_COPY.removed, tone: "danger" },
  changed: { label: MANDATE_COPY.changed, tone: "warning" },
} as const satisfies Record<DiffItemView["kind"], { label: string; tone: Tone }>;

const AREA_WORDS: Record<DiffItemView["area"], string> = {
  rule: "Rule",
  limit: "Daily limit",
  payees: "Payees",
  time_zone: "Time zone",
};

export function diffTitle(item: DiffItemView): string {
  return item.area === "rule" || item.area === "limit"
    ? `${AREA_WORDS[item.area]} ${item.id}`
    : AREA_WORDS[item.area];
}
