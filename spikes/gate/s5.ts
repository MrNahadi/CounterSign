import { createHash, randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express from "express";
import { z } from "zod";

// Spike S5: agent -> Countersign MCP -> PayPal REST, for one tool. The gate serves PayPal's tool
// name over stateless Streamable HTTP (ADR 0001), checks a principal key, and executes with the
// intent hash as PayPal-Request-Id, so the same intent can't refund twice. No decision logic yet.
//   tsx --env-file=.env.local spikes/gate/s5.ts <capture-id> [usd]

const env = z
  .object({
    PAYPAL_BASE_URL: z.url(),
    PAYPAL_CLIENT_ID: z.string().min(1),
    PAYPAL_CLIENT_SECRET: z.string().min(1),
  })
  .parse(process.env);
const [captureId, usd = "1.00"] = process.argv.slice(2);
if (!captureId) throw new Error("Pass a capture ID");
const principalKey = randomBytes(24).toString("hex");

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

// Stand-in for RFC 8785: sorted keys, no whitespace. Enough for flat spike intents.
function intentHash(intent: Record<string, string | number>): string {
  const canonical = JSON.stringify(Object.fromEntries(Object.entries(intent).sort()));
  return createHash("sha256").update(canonical).digest("hex");
}

function buildServer(): McpServer {
  const server = new McpServer({ name: "countersign-gate-s5", version: "0.0.0" });
  server.registerTool(
    "create_refund",
    {
      title: "Refund a captured payment",
      description:
        "Refund all or part of a PayPal capture. Countersign decides and executes it; the same intent never refunds twice.",
      inputSchema: {
        capture_id: z.string().min(1),
        amount: z.object({
          currency_code: z.enum(["USD"]),
          value: z.string().regex(/^\d+\.\d{2}$/),
        }),
        note_to_payer: z.string().max(255).optional(),
      },
    },
    async ({ capture_id, amount, note_to_payer }) => {
      const minor = Math.round(Number(amount.value) * 100);
      const hash = intentHash({
        rail: "paypal",
        action: "refund",
        target: capture_id,
        amount_minor: minor,
        currency: amount.currency_code,
      });
      const res = await fetch(`${env.PAYPAL_BASE_URL}/v2/payments/captures/${capture_id}/refund`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${await paypalToken()}`,
          "content-type": "application/json",
          "paypal-request-id": hash,
          prefer: "return=representation",
        },
        body: JSON.stringify({ amount, note_to_payer }),
      });
      const body = (await res.json()) as { id?: string; status?: string; message?: string };
      const result = {
        decision: "allow (no rules yet: spike S5)",
        intent_hash: hash,
        paypal_status: res.status,
        refund_id: body.id,
        refund_status: body.status,
        error: res.ok ? undefined : body.message,
      };
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
        isError: !res.ok,
      };
    },
  );
  return server;
}

const app = express();
app.use(express.json());
app.post("/mcp", async (req, res) => {
  if (req.get("authorization") !== `Bearer ${principalKey}`) {
    res.status(401).json({ error: "unknown principal" });
    return;
  }
  const server = buildServer();
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
});
app.all("/mcp", (_req, res) => {
  res.status(405).end();
});

const listener = app.listen(0, "127.0.0.1");
await new Promise<void>((resolve) => listener.once("listening", resolve));
const { port } = listener.address() as AddressInfo;
const url = new URL(`http://127.0.0.1:${port}/mcp`);

async function connect(key: string): Promise<Client> {
  const client = new Client({ name: "countersign-s5-agent", version: "0.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(url, {
      requestInit: { headers: { authorization: `Bearer ${key}` } },
    }),
  );
  return client;
}

try {
  try {
    await connect("not-a-principal-key");
    console.log("unknown principal: UNEXPECTEDLY CONNECTED");
  } catch (error) {
    console.log(
      `unknown principal: rejected (${error instanceof Error ? error.message.slice(0, 80) : error})`,
    );
  }

  const client = await connect(principalKey);
  const { tools } = await client.listTools();
  console.log(`gate tools: ${tools.map((tool) => tool.name).join(", ")}`);

  const args = { capture_id: captureId, amount: { currency_code: "USD", value: usd } };
  for (const attempt of ["first call", "same intent again"]) {
    const result = await client.callTool({ name: "create_refund", arguments: args });
    const text =
      Array.isArray(result.content) && "text" in result.content[0] ? result.content[0].text : "";
    console.log(`${attempt}: ${text}`);
  }
  await client.close();
} finally {
  listener.close();
}
