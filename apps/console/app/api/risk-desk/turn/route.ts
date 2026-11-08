import "server-only";
import {
  type Content,
  type FunctionCallingConfig,
  FunctionCallingConfigMode,
  type GenerateContentConfig,
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
import {
  answerText,
  failClosed,
  geminiFromEnv,
  geminiModel,
  type Json,
  SAFETY_OFF,
  sanitize,
  THINKING_LEVELS,
} from "../../../../src/gemini";

// Spike S9: AG Studio's agent turn, run server-side so the Gemini key never reaches the browser
// (ADR 0016). Studio's adapter posts an AgLlmRequest; this replies with NDJSON lines:
// {"event": AgAiEvent} for each content event, then {"response": AgLlmResponse} or {"error": ...}.
// Spike only: no session check, rate limit or budget yet, and the desk doesn't call it. The
// desk's analyst is app/api/risk/analyst, which has them; both share src/gemini.ts.

export const runtime = "nodejs";

const model = geminiModel(process.env);
const generate = geminiFromEnv(process.env);

// Gemini 3 needs each step's own model content (with its thought signatures) when that step is
// replayed. Studio's history has no field for them, so the original content is kept here, keyed by
// tool call ID. In memory only: fine for a spike, lost on restart.
const modelContentByCallId = new Map<string, Content>();
const SKIP_SIGNATURE = "skip_thought_signature_validator";
let turnCount = 0;

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

async function runTurn(
  request: AgLlmRequest,
): Promise<{ events: AgAiEvent[]; response: AgLlmResponse }> {
  if (!generate) throw new Error("GEMINI_API_KEY is not set on the server");
  const { contents, system } = toContents(request.input);
  const tools = request.tools ?? [];
  const config: GenerateContentConfig = {
    systemInstruction: [request.instructions, ...system].filter(Boolean).join("\n\n") || undefined,
    thinkingConfig: {
      thinkingLevel: THINKING_LEVELS[String(request.model?.effort)] ?? ThinkingLevel.LOW,
    },
    safetySettings: SAFETY_OFF,
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
  const result = await generate({ model, contents, config });
  // ADR 0015: a failure here means no tool call runs.
  const content = failClosed(result);
  turnCount += 1;

  const responseId = result.responseId ?? `turn-${Date.now()}`;
  const events: AgAiEvent[] = [];
  const output: AgAiOutputItem[] = [];
  const text = answerText(content);
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
