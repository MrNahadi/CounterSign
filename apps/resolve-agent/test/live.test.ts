// Live checks for Gemini and PayPal's own MCP server. They run only under LIVE=1 with the
// variables each needs, so `npm test` never calls out and needs no credentials. Nothing here
// prints a secret: only booleans, counts and the model version reach the output.

import { createRequire } from "node:module";
import { createTestDatabase, type DatabaseHandle, seedOrders, writeTicket } from "@countersign/db";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { connectBaseline, paypalTokenIssuer, stdioTransport } from "../src/baseline";
import { DraftOutputSchema, draftWithModel } from "../src/drafter";
import { declare, listServerTools, runHarness } from "../src/harness";
import {
  buildModelRequest,
  callModel,
  createGenerateContent,
  parseModelEnv,
  type ToolDeclaration,
} from "../src/model";
import { RECORDED_FACTS } from "./dispute-facts";

const present = z.string().min(1);
const GeminiLive = z.object({ LIVE: z.literal("1"), GEMINI_API_KEY: present });
const PayPalLive = z.object({
  PAYPAL_BASE_URL: present,
  PAYPAL_CLIENT_ID: present,
  PAYPAL_CLIENT_SECRET: present,
});

const gemini = GeminiLive.safeParse(process.env).success;
const paypal = gemini && PayPalLive.safeParse(process.env).success;
const modelEnv = gemini ? parseModelEnv(process.env) : null;

const TWO_MINUTES = 120_000;

function liveModel() {
  if (!modelEnv?.ok) throw new Error("The Gemini variables are not valid.");
  return {
    model: modelEnv.config.model,
    generateContent: createGenerateContent(modelEnv.config.apiKey),
  };
}

const GATE_FIXTURE = createRequire(import.meta.url).resolve(
  "@countersign/gate/test/fixtures/tools-list.json",
);

async function gateFixtureTools() {
  const { default: fixture } = await import(GATE_FIXTURE, { with: { type: "json" } });
  return z
    .object({
      tools: z.array(
        z.looseObject({
          name: z.string(),
          description: z.string().optional(),
          inputSchema: z.unknown(),
        }),
      ),
    })
    .parse(fixture).tools;
}

const HELLO = [
  {
    role: "user",
    parts: [{ text: "Hi, I just wanted to say thanks for the lovely basket." }],
  },
];

async function oneRequest(declarations: ToolDeclaration[]) {
  const { model, generateContent } = liveModel();
  const result = await callModel({
    generateContent,
    request: buildModelRequest({ model, contents: HELLO, declarations }),
  });
  // A passing result means the call answered 200 and the response check let it through.
  expect(result.ok).toBe(true);
  return result;
}

describe.skipIf(!gemini)("live: Gemini", () => {
  it(
    "drafts dispute notes from recorded facts that validate, with a model version",
    async () => {
      const { model, generateContent } = liveModel();
      const drafted = await draftWithModel(generateContent, model, RECORDED_FACTS);
      expect(drafted.notes).not.toBeNull();
      expect(DraftOutputSchema.safeParse(drafted.notes).success).toBe(true);
      expect(drafted.notes?.notes).toHaveLength(RECORDED_FACTS.suggested.length);
      expect(drafted.modelVersions).toHaveLength(1);
      console.log(`Dispute notes drafted by ${drafted.modelVersions[0]}.`);
    },
    TWO_MINUTES,
  );

  it(
    "accepts the gate's tool list plus find_order in VALIDATED mode",
    async () => {
      const { declarations } = declare(await gateFixtureTools());
      expect(declarations.some((tool) => tool.name === "find_order")).toBe(true);
      await oneRequest(declarations);
    },
    TWO_MINUTES,
  );

  it(
    "runs one short ticket to a reply against a stand-in MCP server",
    async () => {
      const handle: DatabaseHandle = await createTestDatabase();
      const server = new Server(
        { name: "stand-in", version: "1.0.0" },
        { capabilities: { tools: {} } },
      );
      server.setRequestHandler(ListToolsRequestSchema, () => ({
        tools: [
          {
            name: "get_order",
            description: "Read a PayPal order by its ID.",
            inputSchema: {
              type: "object",
              properties: { id: { type: "string" } },
              required: ["id"],
            },
          },
        ],
      }));
      server.setRequestHandler(CallToolRequestSchema, () => ({
        content: [{ type: "text", text: "Order is completed." }],
      }));
      const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
      await server.connect(serverSide);
      const client = new Client({ name: "resolve-live", version: "1.0.0" });
      await client.connect(clientSide);
      try {
        await handle.db.insert(seedOrders).values({
          orderNumber: "KIK-1035",
          runId: "live",
          paypalOrderId: "ORD1035",
          paypalCaptureId: "CAP1035",
          amountMinor: 4800,
          currency: "USD",
          payerEmail: "payer.1035@example.com",
          buyer: "A",
          trackingNumber: "KC-live-1035",
          role: "demo",
          seededAt: "2026-10-01T08:00:00Z",
        });
        await writeTicket(handle.db, {
          id: "tkt_live",
          channel: "chat",
          senderEmail: "payer.1035@example.com",
          senderPhone: null,
          subject: null,
          body: "Hello! Just saying thank you, my basket KIK-1035 arrived and it is lovely. Nothing else needed.",
          attachments: [],
          receivedAt: "2026-10-20T09:00:00Z",
          simulated: true,
        });
        const { model, generateContent } = liveModel();
        const result = await runHarness({
          db: handle.db,
          client,
          generateContent,
          model,
          ticketId: "tkt_live",
          threadId: "tkt_live",
        });
        expect(result.outcome).toBe("replied");
        expect(result.reply?.length ?? 0).toBeGreaterThan(0);
        expect(result.modelVersions.length).toBeGreaterThan(0);
        // The model version is not a secret; recording it is the point of this check.
        console.info(`live run replied on ${result.modelVersions.join(", ")}`);
      } finally {
        await client.close();
        await handle.close();
      }
    },
    TWO_MINUTES,
  );
});

describe.skipIf(!paypal)("live: PayPal's MCP server", () => {
  it(
    "starts with a fresh token, lists its tools, and Gemini accepts them with find_order",
    async () => {
      const client = await connectBaseline(paypalTokenIssuer(process.env), stdioTransport);
      expect(client).not.toBeNull();
      if (client === null) return;
      try {
        const tools = await listServerTools(client);
        expect(tools.length).toBeGreaterThan(0);
        const { declarations } = declare(tools);
        expect(declarations.some((tool) => tool.name === "find_order")).toBe(true);
        // One request only: no PayPal tool is called.
        await oneRequest(declarations);
      } finally {
        await client.close();
      }
    },
    TWO_MINUTES,
  );
});
