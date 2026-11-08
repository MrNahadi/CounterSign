import {
  type Content,
  type GenerateContentConfig,
  type GenerateContentParameters,
  type GenerateContentResponse,
  GoogleGenAI,
  HarmBlockThreshold,
  HarmCategory,
  ThinkingLevel,
} from "@google/genai";

// The console's Gemini plumbing (ADRs 0013-0017), shared by the Risk desk's two model routes:
// Studio's agent turn (app/api/risk-desk/turn) and the analyst (app/api/risk/analyst). Route
// handlers only: it reads `GEMINI_API_KEY`, which must never reach the browser (ADR 0016), so no
// client component imports this file. Nothing here moves money or decides anything.

export type GeminiEnv = Readonly<Record<string, string | undefined>>;

/** The one call the console makes; a test passes a fake. */
export type GenerateContent = (
  params: GenerateContentParameters,
) => Promise<GenerateContentResponse>;

export const DEFAULT_GEMINI_MODEL = "gemini-3.5-flash-lite";

/** The model from `GEMINI_MODEL`, else Flash-Lite (ADR 0017). */
export const geminiModel = (env: GeminiEnv): string =>
  env.GEMINI_MODEL?.trim() || DEFAULT_GEMINI_MODEL;

/** A `generateContent` on the Gemini Developer API, or null when the key isn't set. */
export function geminiFromEnv(env: GeminiEnv): GenerateContent | null {
  const apiKey = env.GEMINI_API_KEY?.trim();
  if (!apiKey) return null;
  const ai = new GoogleGenAI({
    apiKey,
    vertexai: false,
    httpOptions: {
      timeout: 90_000,
      retryOptions: { attempts: 3, httpStatusCodes: [408, 500, 502, 503, 504] },
    },
  });
  return (params) => ai.models.generateContent(params);
}

/** Safety filters off: the console's prompts are about its own audit log (ADR 0013). */
export const SAFETY_OFF: GenerateContentConfig["safetySettings"] = [
  HarmCategory.HARM_CATEGORY_HARASSMENT,
  HarmCategory.HARM_CATEGORY_HATE_SPEECH,
  HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT,
  HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT,
  HarmCategory.HARM_CATEGORY_JAILBREAK,
].map((category) => ({ category, threshold: HarmBlockThreshold.OFF }));

export const THINKING_LEVELS: Record<string, ThinkingLevel> = {
  low: ThinkingLevel.LOW,
  medium: ThinkingLevel.MEDIUM,
  high: ThinkingLevel.HIGH,
};

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/** ADR 0014's schema sanitizer, plus Studio's `{ not: {} }` marker for optional union members. */
export function sanitize(schema: Json, root: Json = schema, depth = 0): Json {
  if (schema === true) return {};
  if (Array.isArray(schema)) return schema.map((item) => sanitize(item, root, depth));
  if (schema === null || typeof schema !== "object") return schema;
  if (typeof schema.$ref === "string") {
    if (depth >= 6) return {};
    const target = schema.$ref
      .replace(/^#\//, "")
      .split("/")
      .reduce<Json | undefined>(
        (node, key) =>
          node && typeof node === "object" && !Array.isArray(node) ? node[key] : undefined,
        root,
      );
    return target === undefined ? {} : sanitize(target, root, depth + 1);
  }
  const out: { [key: string]: Json } = {};
  for (const [key, value] of Object.entries(schema)) {
    if (["$schema", "$id", "$comment", "$defs", "definitions"].includes(key)) continue;
    out[key] = sanitize(value, root, depth);
  }
  if (Array.isArray(out.anyOf)) {
    const branches = out.anyOf.filter(
      (branch) =>
        !(
          branch &&
          typeof branch === "object" &&
          !Array.isArray(branch) &&
          Object.keys(branch).length === 1 &&
          branch.not &&
          typeof branch.not === "object" &&
          Object.keys(branch.not).length === 0
        ),
    );
    if (branches.length === 1 && branches[0] && typeof branches[0] === "object") {
      delete out.anyOf;
      Object.assign(out, branches[0]);
    } else {
      out.anyOf = branches;
    }
  }
  if (Array.isArray(out.required) && out.properties && typeof out.properties === "object") {
    const declared = Object.keys(out.properties);
    out.required = out.required.filter((name) => declared.includes(String(name)));
  }
  return out;
}

/** ADR 0015: nothing is read until the response passes. A failure here means nothing runs. */
export function failClosed(response: GenerateContentResponse): Content {
  if (response.promptFeedback?.blockReason) {
    throw new Error(`model_stopped:prompt_blocked:${response.promptFeedback.blockReason}`);
  }
  const candidate = response.candidates?.[0];
  if (!candidate) throw new Error("model_stopped:no_candidate");
  if (String(candidate.finishReason) !== "STOP") {
    throw new Error(`model_stopped:${candidate.finishReason ?? "missing_finish_reason"}`);
  }
  if (!candidate.content?.parts?.length) throw new Error("model_stopped:empty_content");
  return candidate.content;
}

/** The answer's text, without thought parts, from content that passed `failClosed`. */
export function answerText(content: Content): string {
  return (content.parts ?? [])
    .filter((part) => part.text && !part.thought)
    .map((part) => part.text)
    .join("");
}

export type StructuredAsk = {
  model: string;
  system: string;
  prompt: string;
  /** A JSON Schema; sanitized before it's sent. */
  schema: Readonly<Record<string, unknown>>;
  maxOutputTokens: number;
};

/**
 * One structured-output call with no tools, so the model can only answer in `schema`'s shape
 * and can't call anything. The parsed JSON is still unchecked: the caller reads it with zod.
 * Throws on a stopped or unparsable answer.
 */
export async function askStructured(
  generate: GenerateContent,
  ask: StructuredAsk,
): Promise<unknown> {
  const result = await generate({
    model: ask.model,
    contents: [{ role: "user", parts: [{ text: ask.prompt }] }],
    config: {
      systemInstruction: ask.system,
      thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
      safetySettings: SAFETY_OFF,
      maxOutputTokens: ask.maxOutputTokens,
      responseMimeType: "application/json",
      responseJsonSchema: sanitize(ask.schema as Json),
    },
  });
  const text = answerText(failClosed(result));
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error("model_stopped:not_json");
  }
}
