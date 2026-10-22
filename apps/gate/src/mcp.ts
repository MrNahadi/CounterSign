// The gate's MCP surface (ADRs 0001 and 0028): `POST /mcp`, stateless Streamable HTTP in JSON mode,
// with a new low-level `Server` and transport per request. A principal key in
// `Authorization: Bearer` picks the principal and its mandate; anything else gets one fixed 401
// before any MCP handling. Guarded tools hand their raw arguments to propose(), which is the only
// validation, so every call, valid or not, is decided and recorded. Read-only tools are answered
// by the rail client and the carrier mock, and aren't recorded. The one non-guarded extension,
// prepare_dispute_evidence, builds a dispute's evidence pack and moves no money (ADR 0035). No AI.

import type { CarrierAdapter } from "@countersign/carrier-mock";
import type { Database } from "@countersign/db";
import type { PayPalClient } from "@countersign/rail-paypal";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  type CallToolResult,
  ListToolsRequestSchema,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import express, { type Express, type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import type { AgentResponse } from "./decide";
import {
  callPrepare,
  PREPARE_DESCRIPTION,
  PREPARE_TOOL,
  PrepareArgumentsSchema,
} from "./prepare-evidence";
import type { Principal, Principals } from "./principals";
import { GUARDED_TOOLS, type GuardedTool, guardedToolArguments } from "./proposal";
import { propose } from "./propose";
import { callRead, isReadTool, READ_DESCRIPTIONS, READ_TOOLS, readToolArguments } from "./reads";

export const MCP_PATH = "/mcp";
export const MCP_BODY_LIMIT = "256kb";

// The one body every refused key gets. It never says which principals exist or which keys are set.
export const UNAUTHORIZED_BODY = { message: "A valid principal key is required." } as const;

// The only error a guarded call answers: nothing was written, so nothing was done. Nothing a
// database or rail error carries reaches the agent.
export const UNRECORDED_MESSAGE = "Countersign couldn't record this proposal, so nothing was done.";

export type McpDeps = {
  principals: Principals;
  db?: Database;
  // Built from the environment, never from a request. Throws when PayPal's variables are missing.
  rail?: () => PayPalClient;
  carrier?: CarrierAdapter;
  // Read once per guarded call, as the decision time.
  clock: () => Date;
};

const EXTENSION = "Countersign extension: PayPal's Agent Toolkit has no such tool.";
const DECIDED =
  "Countersign decides each call against the merchant's mandate and answers allowed, pending approval or denied, with reasons.";

const DESCRIPTIONS: Record<GuardedTool, { text: string; extension: boolean }> = {
  create_refund: {
    text: "Refund a captured payment, in full or in part. Name the support ticket in justification.ticket_id.",
    extension: false,
  },
  accept_dispute_claim: {
    text: "Accept the buyer's claim in a dispute, which refunds them the disputed amount.",
    extension: false,
  },
  provide_dispute_evidence: {
    text: "Provide evidence for a dispute, such as proof of fulfillment or of a refund.",
    extension: true,
  },
  make_offer: {
    text: "Offer the buyer a refund, a return or a replacement to settle a dispute.",
    extension: true,
  },
  send_invoice: { text: "Send an invoice to its recipients.", extension: false },
  pay_order: { text: "Capture payment for an approved order.", extension: false },
  create_payout: {
    text: "Send money to a PayPal account by email address.",
    extension: true,
  },
};

function describe(tool: GuardedTool): string {
  const { text, extension } = DESCRIPTIONS[tool];
  return [extension ? EXTENSION : null, text, DECIDED].filter(Boolean).join(" ");
}

// The advertised schema leaves out the `$schema` dialect marker, which Gemini refuses, so Resolve's
// sanitizer makes no rewrite on any gate tool (ADR 0014: Gemini-safe by construction). The zod
// schemas still validate every argument.
function advertised(schema: z.ZodType): Tool["inputSchema"] {
  const { $schema: _dialect, ...rest } = z.toJSONSchema(schema, { io: "input" });
  return rest as Tool["inputSchema"];
}

// Built once: the schemas never change while the gate runs.
const GUARDED_TOOL_LIST: Tool[] = GUARDED_TOOLS.map((tool) => ({
  name: tool,
  description: describe(tool),
  inputSchema: advertised(guardedToolArguments(tool)),
}));

const READ_TOOL_LIST: Tool[] = READ_TOOLS.map((tool) => ({
  name: tool,
  description: `${READ_DESCRIPTIONS[tool]} Read-only: nothing is decided or recorded.`,
  inputSchema: advertised(readToolArguments(tool)),
}));

// Countersign's own non-guarded extensions: nothing is decided, and no money moves.
const EXTENSION_TOOL_LIST: Tool[] = [
  {
    name: PREPARE_TOOL,
    description: `${EXTENSION} ${PREPARE_DESCRIPTION}`,
    inputSchema: advertised(PrepareArgumentsSchema),
  },
];

const TOOL_LIST: Tool[] = [...GUARDED_TOOL_LIST, ...READ_TOOL_LIST, ...EXTENSION_TOOL_LIST];

function answer(response: AgentResponse): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(response) }],
    structuredContent: response,
    isError: false,
  };
}

const unrecorded = (): CallToolResult => ({
  content: [{ type: "text", text: UNRECORDED_MESSAGE }],
  isError: true,
});

// The MCP arguments as the proposal the agent made: the tool's name, its PayPal arguments and
// the justification, unvalidated.
function proposalOf(name: string, args: Record<string, unknown> | undefined): unknown {
  const { justification, ...rest } = args ?? {};
  const named = args !== undefined && Object.hasOwn(args, "justification");
  return { tool: name, args: rest, ...(named ? { justification } : {}) };
}

// Any tool name but a read-only one is a guarded call, so an unknown name is UNKNOWN_ACTION.
async function callGuarded(
  principal: Principal,
  name: string,
  args: Record<string, unknown> | undefined,
  deps: McpDeps,
): Promise<CallToolResult> {
  const now = deps.clock();
  const proposal = proposalOf(name, args);
  const { db, carrier } = deps;
  if (db === undefined || carrier === undefined || deps.rail === undefined) return unrecorded();
  let rail: PayPalClient;
  try {
    rail = deps.rail();
  } catch {
    return unrecorded();
  }
  try {
    const result = await propose({
      mandate: principal.mandate,
      principal: principal.name,
      proposal,
      now,
      rail,
      carrier,
      db,
      clock: deps.clock,
    });
    return result.ok ? answer(result.response) : unrecorded();
  } catch {
    return unrecorded();
  }
}

function buildServer(principal: Principal, deps: McpDeps): Server {
  const server = new Server(
    { name: "countersign-gate", version: "0.7.0" },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: TOOL_LIST }));
  server.setRequestHandler(CallToolRequestSchema, (request) => {
    const { name, arguments: args } = request.params;
    if (isReadTool(name)) return callRead(name, args, deps);
    if (name === PREPARE_TOOL) return callPrepare(args, deps);
    return callGuarded(principal, name, args, deps);
  });
  return server;
}

const jsonRpcError = (code: number, message: string) => ({
  jsonrpc: "2.0",
  error: { code, message },
  id: null,
});

export function mountMcp(app: Express, deps: McpDeps): void {
  // Before the body is read: a refused key never reaches MCP.
  const authenticate = (req: Request, res: Response, next: NextFunction) => {
    const principal = deps.principals.authenticate(req.headers.authorization);
    if (principal === null) {
      res.status(401).set("WWW-Authenticate", "Bearer").json(UNAUTHORIZED_BODY);
      return;
    }
    res.locals.principal = principal;
    next();
  };

  app.post(
    MCP_PATH,
    authenticate,
    express.json({ limit: MCP_BODY_LIMIT }),
    async (req: Request, res: Response) => {
      const principal = res.locals.principal as Principal;
      const server = buildServer(principal, deps);
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      res.on("close", () => {
        void transport.close();
        void server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    },
    // A body the JSON reader refused: too large or not JSON. Never echoed.
    (error: unknown, _req: Request, res: Response, _next: NextFunction) => {
      const status = (error as { status?: unknown } | null)?.status;
      if (status === 413) res.status(413).json(jsonRpcError(-32600, "Request body too large."));
      else res.status(400).json(jsonRpcError(-32700, "Parse error."));
    },
  );

  // Stateless: no SSE stream to open and no session to end.
  app.all(MCP_PATH, (_req: Request, res: Response) => {
    res.status(405).set("Allow", "POST").json(jsonRpcError(-32000, "Method not allowed."));
  });
}
