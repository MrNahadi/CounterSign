import "server-only";
import {
  type Content,
  type FunctionCallingConfig,
  FunctionCallingConfigMode,
  type GenerateContentConfig,
  type GenerateContentResponse,
  GoogleGenAI,
  HarmBlockThreshold,
  HarmCategory,
  type Part,
  ThinkingLevel,
} from "@google/genai";
import type {
  AgAiConversationItem,
  AgAiEvent,
  AgAiOutputItem,
  AgLlmRequest,
  AgLlmResponse,
} from "ag-studio";

// Spike S9: the Risk desk analyst's model turn, run server-side so the Gemini key never reaches
// the browser (ADR 0016). Studio's adapter posts an AgLlmRequest; this replies with NDJSON lines:
// {"event": AgAiEvent} for each content event, then {"response": AgLlmResponse} or {"error": ...}.
// Spike only: no session check, rate limit or budget yet (phase 16 adds them).

export const runtime = "nodejs";

const apiKey = process.env.GEMINI_API_KEY;
const model = process.env.GEMINI_MODEL || "gemini-3.5-flash-lite";
const ai = apiKey
  ? new GoogleGenAI({
      apiKey,
      vertexai: false,
      httpOptions: {
        timeout: 90_000,
        retryOptions: { attempts: 3, httpStatusCodes: [408, 500, 502, 503, 504] },
      },
    })
  : undefined;

// Gemini 3 needs each step's own model content (with its thought signatures) when that step is
// replayed. Studio's history has no field for them, so the original content is kept here, keyed by
// tool call ID. In memory only: fine for a spike, lost on restart.
const modelContentByCallId = new Map<string, Content>();
const SKIP_SIGNATURE = "skip_thought_signature_validator";
let turnCount = 0;

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

// ADR 0014's sanitizer, plus Studio's `{ not: {} }` marker for optional union members.
function sanitize(schema: Json, root: Json = schema, depth = 0): Json {
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

function parseJson(text: string): Json {
  try {
    return JSON.parse(text) as Json;
  } catch {
    return text;
  }
}

// Studio's conversation -> Gemini contents. Consecutive parts with the same role are merged.
function toContents(items: AgAiConversationItem[]): { contents: Content[]; system: string[] } {
  const contents: Content[] = [];
  const system: string[] = [];
  const namesByCallId = new Map<string, string>();
  const replayed = new Set<Content>();
  const push = (role: "user" | "model", parts: Part[]) => {
    const last = contents.at(-1);
    if (last?.role === role && !replayed.has(last)) last.parts?.push(...parts);
    else contents.push({ role, parts });
  };

  for (const item of items) {
    if (item.type === "message" && item.kind === "input") {
      const text = item.content.map((part) => (part.type === "text" ? part.text : "")).join("\n");
      if (item.role === "system") system.push(text);
      else push("user", [{ text }]);
    } else if (item.type === "message" && item.kind === "output") {
      const text = item.content
        .map((part) => (part.type === "text" ? part.text : part.refusal))
        .join("\n");
      push("model", [{ text }]);
    } else if (item.type === "function_call") {
      namesByCallId.set(item.callId, item.name);
      const original = modelContentByCallId.get(item.callId);
      if (original) {
        if (!replayed.has(original)) {
          replayed.add(original);
          contents.push(original);
        }
      } else {
        push("model", [
          {
            functionCall: {
              id: item.callId,
              name: item.name,
              args: parseJson(item.arguments) as Record<string, unknown>,
            },
            thoughtSignature: SKIP_SIGNATURE,
          },
        ]);
      }
    } else if (item.type === "function_call_output") {
      const output = parseJson(item.output);
      push("user", [
        {
          functionResponse: {
            id: item.callId,
            name: namesByCallId.get(item.callId) ?? "unknown",
            response: { output },
          },
        },
      ]);
    }
  }
  return { contents, system };
}

function toolConfig(choice: AgLlmRequest["toolChoice"]): FunctionCallingConfig {
  if (choice === "none") return { mode: FunctionCallingConfigMode.NONE };
  if (choice === "required") return { mode: FunctionCallingConfigMode.ANY };
  if (choice && typeof choice === "object") {
    return { mode: FunctionCallingConfigMode.ANY, allowedFunctionNames: [choice.name] };
  }
  return { mode: FunctionCallingConfigMode.VALIDATED };
}

const thinkingLevels: Record<string, ThinkingLevel> = {
  low: ThinkingLevel.LOW,
  medium: ThinkingLevel.MEDIUM,
  high: ThinkingLevel.HIGH,
};

// ADR 0015: nothing is read until the response passes. A failure here means no tool call runs.
function failClosed(response: GenerateContentResponse): Content {
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

async function runTurn(
  request: AgLlmRequest,
): Promise<{ events: AgAiEvent[]; response: AgLlmResponse }> {
  if (!ai) throw new Error("GEMINI_API_KEY is not set on the server");
  const { contents, system } = toContents(request.input);
  const tools = request.tools ?? [];
  const config: GenerateContentConfig = {
    systemInstruction: [request.instructions, ...system].filter(Boolean).join("\n\n") || undefined,
    thinkingConfig: {
      thinkingLevel: thinkingLevels[String(request.model?.effort)] ?? ThinkingLevel.LOW,
    },
    safetySettings: [
      HarmCategory.HARM_CATEGORY_HARASSMENT,
      HarmCategory.HARM_CATEGORY_HATE_SPEECH,
      HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT,
      HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT,
      HarmCategory.HARM_CATEGORY_JAILBREAK,
    ].map((category) => ({ category, threshold: HarmBlockThreshold.OFF })),
  };
  if (tools.length > 0) {
    config.tools = [
      {
        functionDeclarations: tools.map((tool) => ({
          name: tool.name,
          description: tool.description,
          parametersJsonSchema: sanitize(tool.parameters as Json),
        })),
      },
    ];
    config.toolConfig = { functionCallingConfig: toolConfig(request.toolChoice) };
  }
  if (request.responseFormat?.type === "json") {
    config.responseMimeType = "application/json";
    config.responseJsonSchema = sanitize(request.responseFormat.schema as Json);
  }

  const started = Date.now();
  const result = await ai.models.generateContent({ model, contents, config });
  const content = failClosed(result);
  turnCount += 1;

  const responseId = result.responseId ?? `turn-${Date.now()}`;
  const events: AgAiEvent[] = [];
  const output: AgAiOutputItem[] = [];
  const text = (content.parts ?? [])
    .filter((part) => part.text && !part.thought)
    .map((part) => part.text)
    .join("");
  if (text) {
    const messageId = `msg-${responseId}`;
    events.push(
      { type: "TEXT_MESSAGE_START", messageId, role: "assistant" },
      { type: "TEXT_MESSAGE_CONTENT", messageId, delta: text },
      { type: "TEXT_MESSAGE_END", messageId },
    );
    output.push({
      id: messageId,
      kind: "output",
      type: "message",
      role: "assistant",
      status: "completed",
      content: [{ type: "text", text, annotations: [] }],
    });
  }
  let callIndex = 0;
  for (const part of content.parts ?? []) {
    const call = part.functionCall;
    if (!call?.name) continue;
    call.id ??= `${responseId}-call-${callIndex++}`;
    modelContentByCallId.set(call.id, content);
    const args = JSON.stringify(call.args ?? {});
    events.push(
      { type: "TOOL_CALL_START", toolCallId: call.id, toolCallName: call.name },
      { type: "TOOL_CALL_ARGS", toolCallId: call.id, delta: args },
      { type: "TOOL_CALL_END", toolCallId: call.id },
    );
    output.push({
      id: call.id,
      kind: "output",
      type: "function_call",
      callId: call.id,
      name: call.name,
      arguments: args,
      status: "completed",
    });
  }

  const usage = result.usageMetadata;
  console.log(
    `[risk-desk] turn ${turnCount}: ${result.modelVersion}, ${Date.now() - started} ms, ${tools.length} tools, ` +
      `${output.filter((item) => item.type === "function_call").length} calls, tokens in ${usage?.promptTokenCount} out ${usage?.candidatesTokenCount} thinking ${usage?.thoughtsTokenCount ?? 0}`,
  );
  return {
    events,
    response: {
      id: responseId,
      createdAt: Date.now(),
      status: "completed",
      model: result.modelVersion,
      output,
      usage: {
        inputTokens: usage?.promptTokenCount ?? 0,
        outputTokens: usage?.candidatesTokenCount ?? 0,
        totalTokens: usage?.totalTokenCount,
        reasoningTokens: usage?.thoughtsTokenCount,
        cachedInputTokens: usage?.cachedContentTokenCount,
      },
    },
  };
}

export async function POST(req: Request): Promise<Response> {
  const request = (await req.json()) as AgLlmRequest;
  const lines: string[] = [];
  try {
    const { events, response } = await runTurn(request);
    for (const event of events) lines.push(JSON.stringify({ event }));
    lines.push(JSON.stringify({ response }));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.log(`[risk-desk] turn failed: ${message}`);
    lines.push(JSON.stringify({ error: { code: "model_stopped", message } }));
  }
  return new Response(`${lines.join("\n")}\n`, {
    headers: { "content-type": "application/x-ndjson" },
  });
}
