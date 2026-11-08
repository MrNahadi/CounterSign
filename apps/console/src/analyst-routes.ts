import { type ApprovalDeps, readBody, refuse, withSignIn } from "./approval-routes";
import { askStructured, type GenerateContent, geminiModel } from "./gemini";
import {
  ANALYST_COPY,
  ANALYST_RESPONSE_SCHEMA,
  ANALYST_SYSTEM,
  AnalystQuestionSchema,
  type AnalystSpec,
  AnalystSpecSchema,
} from "./risk-analyst";
import { limitSession } from "./session-limits";

// `POST /api/risk/analyst` (PLAN D2): one typed question, one Gemini call with structured output
// and no tools, one widget spec from the allowlist in `risk-analyst.ts`, read with zod. It opens
// with the approvals sign-in, counts against the session's analyst limit and a daily cap for the
// whole console (brief §8: the demo can't run up unbounded AI cost), and fails closed: no key, a
// stopped model, or an answer outside the allowlist is a refusal, never a guessed widget. It
// calls nothing but the gate's key check and Gemini, and returns only the spec: it can't move
// money, and it decides nothing the gate decides.

/** Questions the whole console answers in a UTC day, across every session. */
export const ANALYST_DAILY_LIMIT = 200;
/** Enough for the six-field spec with low thinking; a longer answer stops and is refused. */
export const ANALYST_MAX_OUTPUT_TOKENS = 2_048;

export type AnalystDeps = ApprovalDeps & {
  /** Gemini, or null when the server has no key. */
  generate: GenerateContent | null;
  now?: () => number;
};

let today = { day: "", count: 0 };

/** Takes one of today's questions; false when they're spent. */
function takeDaily(now: number): boolean {
  const day = new Date(now).toISOString().slice(0, 10);
  if (today.day !== day) today = { day, count: 0 };
  if (today.count >= ANALYST_DAILY_LIMIT) return false;
  today.count++;
  return true;
}

/** Forgets today's count, for tests. */
export function resetAnalystDay(): void {
  today = { day: "", count: 0 };
}

/** The prompt: the question marked off as data. */
export const analystPrompt = (question: string) =>
  `The merchant's question, between the markers:\n<question>\n${question}\n</question>`;

export function analystRoute(request: Request, deps: AnalystDeps): Promise<Response> | Response {
  return withSignIn(request, deps, async () => {
    const generate = deps.generate;
    if (generate === null) return refuse(503, ANALYST_COPY.notSetUp);
    // Counted after the key is checked, so a stranger never spends a slot.
    const limited = limitSession(request, "analyst");
    if (limited !== null) return limited;
    const question = AnalystQuestionSchema.safeParse(await readBody(request));
    if (!question.success) return refuse(400, ANALYST_COPY.badQuestion);
    if (!takeDaily(deps.now?.() ?? Date.now())) return refuse(429, ANALYST_COPY.dailyLimit);

    let answer: unknown;
    try {
      answer = await askStructured(generate, {
        model: geminiModel(deps.env),
        system: ANALYST_SYSTEM,
        prompt: analystPrompt(question.data.question),
        schema: ANALYST_RESPONSE_SCHEMA,
        maxOutputTokens: ANALYST_MAX_OUTPUT_TOKENS,
      });
    } catch {
      return refuse(502, ANALYST_COPY.failed);
    }
    const spec = AnalystSpecSchema.safeParse(answer);
    if (!spec.success) return refuse(502, ANALYST_COPY.failed);
    return { ok: true, value: { spec: spec.data satisfies AnalystSpec } };
  });
}
