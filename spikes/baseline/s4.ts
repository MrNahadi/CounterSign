import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import {
  type Content,
  FunctionCallingConfigMode,
  type GenerateContentResponse,
  GoogleGenAI,
  HarmBlockThreshold,
  HarmCategory,
  type Part,
  ThinkingLevel,
} from "@google/genai";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import { z } from "zod";

// Spike S4: baseline mode. Gemini, through our own function-calling loop (ADR 0014), drives
// PayPal's own MCP server (@paypal/mcp over stdio, ADR 0011) with no gate in between.
//   tsx --env-file=.env.local spikes/baseline/s4.ts [AUTO]
// Pass AUTO to use that function-calling mode instead of VALIDATED.

const env = z
  .object({
    PAYPAL_BASE_URL: z.url(),
    PAYPAL_CLIENT_ID: z.string().min(1),
    PAYPAL_CLIENT_SECRET: z.string().min(1),
    GEMINI_API_KEY: z.string().min(1),
    GEMINI_MODEL: z.string().default("gemini-3.5-flash-lite"),
  })
  .parse(process.env);
const mode =
  process.argv[2] === "AUTO" ? FunctionCallingConfigMode.AUTO : FunctionCallingConfigMode.VALIDATED;

async function paypalToken(): Promise<string> {
  const basic = Buffer.from(`${env.PAYPAL_CLIENT_ID}:${env.PAYPAL_CLIENT_SECRET}`).toString(
    "base64",
  );
  const res = await fetch(`${env.PAYPAL_BASE_URL}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      authorization: `Basic ${basic}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });
  const body = (await res.json()) as { access_token?: string };
  if (!body.access_token) throw new Error(`PayPal OAuth failed: HTTP ${res.status}`);
  return body.access_token;
}

// ADR 0014's sanitizer, minimal version: only what the model sees changes. PayPal's server
// still validates the real arguments with its own schemas.
type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
function sanitize(schema: Json, root: Json = schema, depth = 0): Json {
  if (schema === true) return {};
  if (Array.isArray(schema)) return schema.map((item) => sanitize(item, root, depth));
  if (schema === null || typeof schema !== "object") return schema;
  if (typeof schema.$ref === "string" && depth < 8) {
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
    if (key === "$schema" || key === "$id" || key === "$comment" || key === "$ref") continue;
    out[key] = sanitize(value, root, depth);
  }
  if (Array.isArray(out.required) && out.properties && typeof out.properties === "object") {
    const declared = Object.keys(out.properties as object);
    out.required = out.required.filter((name) => declared.includes(String(name)));
  }
  return out;
}

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

const short = (value: unknown) => {
  const text = JSON.stringify(value);
  return text.length > 600 ? `${text.slice(0, 600)}…` : text;
};

async function main() {
  const require = createRequire(import.meta.url);
  const serverBin = join(dirname(require.resolve("@paypal/mcp/package.json")), "dist", "index.js");
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverBin, "--tools=all"],
    env: {
      ...getDefaultEnvironment(),
      PAYPAL_ACCESS_TOKEN: await paypalToken(),
      PAYPAL_ENVIRONMENT: "SANDBOX",
    },
    stderr: "ignore",
  });
  const client = new Client({ name: "countersign-s4", version: "0.0.0" });
  await client.connect(transport);

  try {
    const { tools } = await client.listTools();
    const sorted = [...tools].sort((a, b) => a.name.localeCompare(b.name));
    console.log(`PayPal MCP server: ${sorted.length} tools`);
    console.log(sorted.map((tool) => tool.name).join(", "));

    const ai = new GoogleGenAI({
      apiKey: env.GEMINI_API_KEY,
      vertexai: false,
      httpOptions: {
        timeout: 90_000,
        retryOptions: { attempts: 3, httpStatusCodes: [408, 500, 502, 503, 504] },
      },
    });
    const config = {
      systemInstruction:
        "You are Resolve, the support agent for Kikapu Studio, a basket maker in Kisumu. You can act on the merchant's PayPal account with your tools. Resolve the customer's request and reply briefly.",
      tools: [
        {
          functionDeclarations: sorted.map((tool) => ({
            name: tool.name,
            description: tool.description ?? "",
            parametersJsonSchema: sanitize(tool.inputSchema as Json),
          })),
        },
      ],
      toolConfig: { functionCallingConfig: { mode } },
      thinkingConfig: { thinkingLevel: ThinkingLevel.MEDIUM },
      safetySettings: [
        HarmCategory.HARM_CATEGORY_HARASSMENT,
        HarmCategory.HARM_CATEGORY_HATE_SPEECH,
        HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT,
        HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT,
        HarmCategory.HARM_CATEGORY_JAILBREAK,
      ].map((category) => ({ category, threshold: HarmBlockThreshold.OFF })),
    };

    const history: Content[] = [
      {
        role: "user",
        parts: [
          {
            text: "From: sb-87z5i53320974@personal.example.com\nMy basket from order KIK-2002 arrived with a torn handle. PayPal capture ID 3JM25846XW7943026. Please refund $5.00 for the damage and keep the rest.",
          },
        ],
      },
    ];

    for (let step = 1; step <= 6; step++) {
      const started = Date.now();
      const response = await ai.models.generateContent({
        model: env.GEMINI_MODEL,
        contents: history,
        config,
      });
      const content = failClosed(response);
      console.log(
        `\n== step ${step} (${Date.now() - started} ms, ${response.modelVersion}, mode ${mode})`,
      );
      history.push(content);
      const calls = (content.parts ?? [])
        .filter((part) => part.functionCall)
        .map((part) => part.functionCall);
      for (const part of content.parts ?? []) {
        if (part.text && !part.thought) console.log(`text: ${part.text}`);
      }
      if (calls.length === 0) break;

      const replies: Part[] = [];
      for (const call of calls) {
        if (!call?.name) continue;
        console.log(`call: ${call.name}(${JSON.stringify(call.args)})`);
        const result = await client.callTool({ name: call.name, arguments: call.args ?? {} });
        const text = Array.isArray(result.content)
          ? result.content.map((item) => ("text" in item ? item.text : "")).join("\n")
          : "";
        const payload = result.isError
          ? { error: text }
          : { output: result.structuredContent ?? text };
        console.log(`result${result.isError ? " (error)" : ""}: ${short(payload)}`);
        replies.push({ functionResponse: { id: call.id, name: call.name, response: payload } });
      }
      history.push({ role: "user", parts: replies });
    }
  } finally {
    await client.close();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
