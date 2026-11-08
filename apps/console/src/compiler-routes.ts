import { hashMandate, type Mandate } from "@countersign/mandate";
import { type ApprovalDeps, readBody, refuse, withSignIn } from "./approval-routes";
import { askStructured, type GenerateContent, geminiModel } from "./gemini";
import {
  COMPILED_RESPONSE_SCHEMA,
  COMPILER_COPY,
  COMPILER_SYSTEM,
  CompileRequestSchema,
  compileAnswer,
  compilerPrompt,
} from "./mandate-compiler";
import { type ReadBack, readBackMandate } from "./mandate-readback";
import { limitSession } from "./session-limits";

// `POST /api/mandate/compile` (PLAN E1): the merchant's plain-English rules in, one Gemini call
// with structured output and no tools, and back a draft mandate (version N+1, checked by the
// gate's `MandateSchema`), its hash, and Countersign's own read-back in plain English. It opens
// with the approvals sign-in, counts against the session's compile limit and a daily cap for the
// whole console (brief §8: no unbounded AI cost), and fails closed: no key, no readable current
// mandate, a stopped model or an answer that doesn't pass the check is a refusal, never a guessed
// mandate. The draft is only returned: nothing here signs, stores or sends it to the gate, and the
// gate never calls this route, so the model is never at decision time.

/** Compiles the whole console runs in a UTC day, across every session. */
export const COMPILER_DAILY_LIMIT = 100;
/** Room for a full mandate's rules with low thinking; a longer answer stops and is refused. */
export const COMPILER_MAX_OUTPUT_TOKENS = 8_192;

export type CompilerDeps = ApprovalDeps & {
  /** Gemini, or null when the server has no key. */
  generate: GenerateContent | null;
  /** The signed mandate in use, or null when it couldn't be read. */
  current: Mandate | null;
  now?: () => number;
};

export type CompileAnswer = {
  mandate: Mandate;
  hash: string;
  readBack: ReadBack;
  /** The merchant's rules Gemini said it couldn't express; nothing was compiled for them. */
  leftOut: string[];
  base: { version: number; hash: string };
};

let today = { day: "", count: 0 };

/** Takes one of today's compiles; false when they're spent. */
function takeDaily(now: number): boolean {
  const day = new Date(now).toISOString().slice(0, 10);
  if (today.day !== day) today = { day, count: 0 };
  if (today.count >= COMPILER_DAILY_LIMIT) return false;
  today.count++;
  return true;
}

/** Forgets today's count, for tests. */
export function resetCompilerDay(): void {
  today = { day: "", count: 0 };
}

export function compileRoute(request: Request, deps: CompilerDeps): Promise<Response> | Response {
  return withSignIn(request, deps, async () => {
    const { generate, current } = deps;
    if (generate === null) return refuse(503, COMPILER_COPY.notSetUp);
    if (current === null) return refuse(503, COMPILER_COPY.noMandate);
    // Counted after the key is checked, so a stranger never spends a slot.
    const limited = limitSession(request, "compile");
    if (limited !== null) return limited;
    const body = CompileRequestSchema.safeParse(await readBody(request));
    if (!body.success) return refuse(400, COMPILER_COPY.badRules);
    if (!takeDaily(deps.now?.() ?? Date.now())) return refuse(429, COMPILER_COPY.dailyLimit);

    let answer: unknown;
    try {
      answer = await askStructured(generate, {
        model: geminiModel(deps.env),
        system: COMPILER_SYSTEM,
        prompt: compilerPrompt(body.data.rules, current),
        schema: COMPILED_RESPONSE_SCHEMA,
        maxOutputTokens: COMPILER_MAX_OUTPUT_TOKENS,
      });
    } catch {
      return refuse(502, COMPILER_COPY.failed);
    }
    const compiled = compileAnswer(answer, current);
    if (!compiled.ok) {
      const stop = /[.!?]$/.test(compiled.error) ? "" : ".";
      return refuse(502, `${COMPILER_COPY.invalid}: ${compiled.error}${stop}`);
    }
    return {
      ok: true,
      value: {
        mandate: compiled.mandate,
        hash: hashMandate(compiled.mandate).hash,
        readBack: readBackMandate(compiled.mandate),
        leftOut: compiled.leftOut,
        base: { version: current.version, hash: hashMandate(current).hash },
      } satisfies CompileAnswer,
    };
  });
}
