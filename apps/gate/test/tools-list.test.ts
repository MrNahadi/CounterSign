import { readFileSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app";

// The gate's `tools/list` answer, recorded in `fixtures/tools-list.json` so Resolve's schema
// sanitizer test can read exactly what the model is shown in protected mode. This test fails when
// the live answer drifts from the recording; re-record the fixture when the change is intended.

const KEY = "test-support-agent-key-0123456789abcdef";
const ENV = { COUNTERSIGN_SUPPORT_AGENT_KEY: KEY };
const FIXTURE = new URL("./fixtures/tools-list.json", import.meta.url);

let server: Server | undefined;
let client: Client | undefined;

afterEach(async () => {
  await client?.close().catch(() => {});
  if (server) {
    const open = server;
    open.closeAllConnections();
    await new Promise<void>((resolve) => open.close(() => resolve()));
  }
  server = undefined;
  client = undefined;
});

async function listAllTools(): Promise<unknown> {
  server = createApp({ env: ENV }).listen(0, "127.0.0.1");
  const listening = server;
  await new Promise<void>((resolve) => listening.once("listening", resolve));
  const { port } = listening.address() as AddressInfo;
  client = new Client({ name: "fixture-check", version: "0.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${KEY}` } },
    }),
  );
  const tools: unknown[] = [];
  let cursor: string | undefined;
  do {
    const page = await client.listTools(cursor === undefined ? {} : { cursor });
    tools.push(...page.tools);
    cursor = page.nextCursor;
  } while (cursor !== undefined);
  return { tools };
}

describe("tools/list fixture", () => {
  it("matches the gate's live tools/list answer exactly", async () => {
    const recorded = JSON.parse(readFileSync(FIXTURE, "utf8"));
    expect(await listAllTools()).toEqual(recorded);
  });
});
