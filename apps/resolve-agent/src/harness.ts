import {
  type Database,
  eq,
  readAttachment,
  readRunsByThread,
  readThread,
  seedOrders,
  type ThreadTicket,
} from "@countersign/db";
import { isCurrency } from "@countersign/mandate";
import { toPayPalDisplayAmount } from "@countersign/rail-paypal";
import type { Content, FunctionCall, GenerateContentResponse, Part } from "@google/genai";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { z } from "zod";
import {
  buildModelRequest,
  callModel,
  type GenerateContent,
  type ModelFailure,
  type ToolDeclaration,
} from "./model";
import { type SchemaRewrite, sanitizeSchema } from "./sanitize";

// Resolve's function-calling loop (ADRs 0014 and 0031). The same loop runs both modes: only the
// MCP client differs. Every model call and tool call is in the trace; any failed check, limit,
// unknown tool or transport failure ends the run with no further tool call.

export const MAX_MODEL_CALLS = 8;
export const MAX_TOOL_CALLS = 12;

export const FIND_ORDER = "find_order";
export const NO_ORDER = "No order with that number.";

export type HarnessOutcome =
  | "replied"
  | ModelFailure
  | "step_cap"
  | "unknown_tool"
  | "empty_reply"
  | "tool_transport_failed";

export type ModelStep = {
  kind: "model";
  step: number;
  model: string;
  modelVersion: string | null;
  responseId: string | null;
  finishReason: string | null;
  promptFeedback: unknown;
  usage: {
    prompt: number | null;
    candidates: number | null;
    thoughts: number | null;
    cached: number | null;
  };
  latencyMs: number;
  /** Set when the call or its check failed. */
  outcome?: ModelFailure;
};

export type ToolStep = {
  kind: "tool";
  step: number;
  id: string;
  name: string;
  args: Record<string, unknown>;
  /** The full `CallToolResult`, or null when the transport failed. */
  result: unknown;
  latencyMs: number;
  /** True for `find_order`, which runs here and not on the MCP server. */
  local: boolean;
};

export type HarnessTrace = {
  tools: string[];
  rewrites: (SchemaRewrite & { tool: string })[];
  steps: (ModelStep | ToolStep)[];
};

export type HarnessResult = {
  status: "replied" | "stopped" | "failed";
  outcome: HarnessOutcome;
  reply: string | null;
  /** Every `modelVersion` reported, in order. */
  modelVersions: string[];
  toolCallCount: number;
  trace: HarnessTrace;
};

export type HarnessInput = {
  db: Database;
  /** A connected MCP client: the gate in protected mode, PayPal's server in baseline mode. */
  client: Client;
  generateContent: GenerateContent;
  model: string;
  ticketId: string;
  threadId: string;
  /** A monotonic clock in milliseconds, for latency only. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
};

export class TicketNotInThreadError extends Error {
  override readonly name = "TicketNotInThreadError";
}

// ---- find_order: the shop's order book over seed_orders (ADR 0031) ----

const FIND_ORDER_SCHEMA = {
  type: "object",
  properties: {
    order_number: {
      type: "string",
      description: "The shop's order number, KIK- and four digits, such as KIK-1042.",
      pattern: "^KIK-\\d{4}$",
    },
  },
  required: ["order_number"],
  additionalProperties: false,
};

const FIND_ORDER_DESCRIPTION =
  "Look up an order in Kikapu Studio's order book by its order number, such as KIK-1042. Answers the PayPal order ID, capture ID, amount and tracking number.";

const FindOrderArgs = z.strictObject({
  order_number: z.string().regex(/^KIK-\d{4}$/),
});

type ToolResult = {
  content: { type: "text"; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

const errorResult = (text: string): ToolResult => ({
  content: [{ type: "text", text }],
  isError: true,
});

export async function findOrder(db: Database, args: unknown): Promise<ToolResult> {
  const parsed = FindOrderArgs.safeParse(args);
  if (!parsed.success) {
    return errorResult("order_number must be KIK- and four digits, such as KIK-1042.");
  }
  const [row] = await db
    .select()
    .from(seedOrders)
    .where(eq(seedOrders.orderNumber, parsed.data.order_number))
    .limit(1);
  if (!row) return errorResult(NO_ORDER);
  const amount = isCurrency(row.currency)
    ? toPayPalDisplayAmount({ minor: row.amountMinor, currency: row.currency })
    : null;
  if (!amount) return errorResult(NO_ORDER);
  // Never the payer's email: the records that decide a refund are the gate's to read.
  const order = {
    order_number: row.orderNumber,
    paypal_order_id: row.paypalOrderId,
    capture_id: row.paypalCaptureId,
    amount: { value: amount.value, currency_code: amount.currency_code },
    tracking_number: row.trackingNumber,
  };
  return { content: [{ type: "text", text: JSON.stringify(order) }], structuredContent: order };
}

// ---- Tools ----

export async function listServerTools(client: Client) {
  const tools: { name: string; description?: string; inputSchema: unknown }[] = [];
  let cursor: string | undefined;
  do {
    const page = await client.listTools(cursor === undefined ? {} : { cursor });
    tools.push(...page.tools);
    cursor = page.nextCursor;
  } while (cursor !== undefined);
  return tools;
}

export function declare(tools: { name: string; description?: string; inputSchema: unknown }[]) {
  const rewrites: HarnessTrace["rewrites"] = [];
  const declarations: ToolDeclaration[] = tools
    .filter((tool) => tool.name !== FIND_ORDER)
    .concat({
      name: FIND_ORDER,
      description: FIND_ORDER_DESCRIPTION,
      inputSchema: FIND_ORDER_SCHEMA,
    })
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .map((tool) => {
      const { schema, rewrites: made } = sanitizeSchema(tool.inputSchema);
      for (const rewrite of made) rewrites.push({ tool: tool.name, ...rewrite });
      return {
        name: tool.name,
        description: tool.description ?? "",
        parametersJsonSchema: schema,
      };
    });
  return { declarations, rewrites };
}

const joinedText = (result: unknown): string => {
  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (item): item is { type: "text"; text: string } =>
        typeof item === "object" &&
        item !== null &&
        item.type === "text" &&
        typeof item.text === "string",
    )
    .map((item) => item.text)
    .join("\n");
};

// ADR 0014's mapping: `{ output: structuredContent ?? joined text }`, or `{ error }` on isError.
function toResponse(result: unknown): Record<string, unknown> {
  const { isError, structuredContent } = result as {
    isError?: unknown;
    structuredContent?: unknown;
  };
  if (isError === true) return { error: joinedText(result) };
  return { output: structuredContent ?? joinedText(result) };
}

// ---- The user turn ----

const sender = (ticket: ThreadTicket) =>
  ticket.senderEmail ?? ticket.senderPhone ?? "an unknown sender";

async function renderUserTurn(db: Database, ticketId: string, threadId: string): Promise<Content> {
  const thread = await readThread(db, threadId);
  const index = thread.findIndex((ticket) => ticket.id === ticketId);
  const ticket = thread[index];
  if (index < 0 || !ticket) {
    throw new TicketNotInThreadError(`Ticket ${ticketId} isn't in thread ${threadId}.`);
  }
  const runs = await readRunsByThread(db, threadId);
  const earlier: string[] = [];
  for (const prior of thread.slice(0, index)) {
    earlier.push(
      `Customer message from ${sender(prior)}, received ${prior.receivedAt}:\n${prior.body}`,
    );
    for (const run of runs) {
      if (run.ticketId === prior.id && run.status === "replied" && run.reply) {
        earlier.push(`Resolve replied:\n${run.reply}`);
      }
    }
  }
  const header = [
    "The message to answer:",
    `Ticket ID: ${ticket.id}`,
    `Channel: ${ticket.channel}`,
    `From: ${sender(ticket)}`,
    ...(ticket.subject === null ? [] : [`Subject: ${ticket.subject}`]),
    `Received: ${ticket.receivedAt}`,
  ].join("\n");
  const text = [
    ...(earlier.length > 0 ? ["The conversation so far, oldest first:", ...earlier] : []),
    header,
    ticket.body,
  ].join("\n\n");
  const parts: Part[] = [{ text }];
  for (const { id } of ticket.attachments) {
    const attachment = await readAttachment(db, id);
    if (!attachment) {
      parts.push({ text: `(Photo ${id} couldn't be read.)` });
      continue;
    }
    parts.push({
      inlineData: {
        mimeType: attachment.contentType,
        data: Buffer.from(attachment.bytes).toString("base64"),
      },
    });
  }
  return { role: "user", parts };
}

// ---- The loop ----

const num = (value: unknown) => (typeof value === "number" ? value : null);
const str = (value: unknown) => (typeof value === "string" ? value : null);

function modelStep(
  step: number,
  model: string,
  response: GenerateContentResponse | undefined,
  latencyMs: number,
): ModelStep {
  const usage = response?.usageMetadata;
  return {
    kind: "model",
    step,
    model,
    modelVersion: str(response?.modelVersion),
    responseId: str(response?.responseId),
    finishReason: str(response?.candidates?.[0]?.finishReason),
    promptFeedback: response?.promptFeedback ?? null,
    usage: {
      prompt: num(usage?.promptTokenCount),
      candidates: num(usage?.candidatesTokenCount),
      thoughts: num(usage?.thoughtsTokenCount),
      cached: num(usage?.cachedContentTokenCount),
    },
    latencyMs,
  };
}

const STOPPED_OUTCOMES = new Set<HarnessOutcome>(["step_cap", "unknown_tool", "empty_reply"]);

export async function runHarness(input: HarnessInput): Promise<HarnessResult> {
  const now = input.now ?? (() => performance.now());
  const trace: HarnessTrace = { tools: [], rewrites: [], steps: [] };
  const modelVersions: string[] = [];
  let toolCallCount = 0;

  const end = (outcome: HarnessOutcome, reply: string | null = null): HarnessResult => ({
    status:
      outcome === "replied"
        ? "replied"
        : outcome.startsWith("model_stopped:") || STOPPED_OUTCOMES.has(outcome)
          ? "stopped"
          : "failed",
    outcome,
    reply,
    modelVersions,
    toolCallCount,
    trace,
  });

  const userTurn = await renderUserTurn(input.db, input.ticketId, input.threadId);

  let serverTools: Awaited<ReturnType<typeof listServerTools>>;
  try {
    serverTools = await listServerTools(input.client);
  } catch {
    return end("tool_transport_failed");
  }
  const { declarations, rewrites } = declare(serverTools);
  trace.tools = declarations.map((declaration) => declaration.name);
  trace.rewrites = rewrites;
  const declared = new Set(trace.tools);

  const contents: Content[] = [userTurn];
  for (let step = 1; ; step++) {
    if (step > MAX_MODEL_CALLS) return end("step_cap");
    const request = buildModelRequest({ model: input.model, contents, declarations });
    const started = now();
    const result = await callModel({
      generateContent: input.generateContent,
      request,
      ...(input.sleep ? { sleep: input.sleep } : {}),
    });
    const traced = modelStep(step, input.model, result.response, now() - started);
    if (traced.modelVersion !== null) modelVersions.push(traced.modelVersion);
    if (!result.ok) {
      trace.steps.push({ ...traced, outcome: result.outcome });
      return end(result.outcome);
    }
    trace.steps.push(traced);
    // Appended unchanged, so thought signatures stay in the parts where they arrived.
    contents.push(result.content);

    const parts = result.content.parts ?? [];
    const calls = parts
      .map((part) => part.functionCall)
      .filter((call): call is FunctionCall => call !== undefined);
    if (calls.length === 0) {
      const reply = parts
        .filter((part) => typeof part.text === "string" && part.thought !== true)
        .map((part) => part.text)
        .join("")
        .trim();
      return reply === "" ? end("empty_reply") : end("replied", reply);
    }

    // Every check runs before any call in the response does.
    if (calls.some((call) => typeof call.name !== "string" || !declared.has(call.name))) {
      return end("unknown_tool");
    }
    if (toolCallCount + calls.length > MAX_TOOL_CALLS) return end("step_cap");

    const responses: Part[] = [];
    for (const [index, call] of calls.entries()) {
      const name = call.name as string;
      const id = call.id ?? `local_${step}_${index + 1}`;
      const args = call.args ?? {};
      const local = name === FIND_ORDER;
      toolCallCount++;
      const callStarted = now();
      let callResult: unknown;
      try {
        callResult = local
          ? await findOrder(input.db, args)
          : await input.client.callTool({ name, arguments: args });
      } catch {
        trace.steps.push({
          kind: "tool",
          step,
          id,
          name,
          args,
          result: null,
          latencyMs: now() - callStarted,
          local,
        });
        return end("tool_transport_failed");
      }
      trace.steps.push({
        kind: "tool",
        step,
        id,
        name,
        args,
        result: callResult,
        latencyMs: now() - callStarted,
        local,
      });
      responses.push({ functionResponse: { id, name, response: toResponse(callResult) } });
    }
    contents.push({ role: "user", parts: responses });
  }
}
