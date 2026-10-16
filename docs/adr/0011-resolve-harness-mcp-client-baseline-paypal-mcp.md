# 0011. Resolve uses one harness for both modes; baseline mode connects to PayPal's own MCP server over stdio

Status: accepted
Decided-by: answerer (researched)
Question: Phase 1 constitution, Q11. The baseline agent needs Claude (`claude-opus-5-5`) calling PayPal's Agent Toolkit tools (`create_refund` etc.) directly. What is the cleanest way to wire Claude to it, keeping the toolkit's zod 3 / ai 4 dependencies isolated to the baseline only?
Decision:
- Resolve has one harness for both modes. It calls `@anthropic-ai/sdk`'s `beta.messages.toolRunner` with `claude-opus-5-5`. Its tools come from an MCP client (the `@modelcontextprotocol/sdk` v1 `Client`) and are converted with `mcpTools` from `@anthropic-ai/sdk/helpers/beta/mcp`.
- Protected mode connects to the gate with `StreamableHTTPClientTransport`, authenticated by the principal's key.
- Baseline mode connects with `StdioClientTransport` to PayPal's own MCP server: `@paypal/mcp` 1.8.1, which is built on `@paypal/agent-toolkit`. It runs as a child process given a freshly minted sandbox access token (`PAYPAL_ACCESS_TOKEN`, `PAYPAL_ENVIRONMENT=SANDBOX`, `--tools=all`).
- Only the transport differs between the two modes. Model, prompt and settings are identical.
- Isolation: `@paypal/mcp` and `@paypal/agent-toolkit` (pinned 1.11.0) live in a workspace of their own, for example `apps/baseline-paypal-mcp`, that no other code imports. Spawn the server with `process.execPath` and the resolved bin path, not `npx`.
- Rejected options:
  - The Vercel AI SDK v4 adapter. It's a different harness from protected mode, and the AI SDK 4-era Anthropic provider predates Opus 5.5 options such as `output_config.effort` and server-side fallbacks. The baseline would no longer be the same agent.
  - Anthropic's MCP connector. It needs publicly reachable servers, so local bench runs can't use it, and it runs tool calls on Anthropic's side, so we control the trace less. PayPal documents remote-server auth for programmatic clients only vaguely. The README can describe the connector instead.
Basis:
- Brief §5, item 6: "switch Resolve to baseline mode and watch the same agent wired straight to PayPal's tools".
- Brief §8: "The baseline isn't tuned to fail."
- Brief §3: "keeps PayPal's tool names where they exist, so switching is one URL change".
- Brief §13: spike S4.
- The TypeScript MCP helpers (`mcpTools` with `toolRunner`, using the v1 `Client`) and the connector's limits ("only tool calls", "must be publicly exposed through HTTP"): https://platform.claude.com/docs/en/agents-and-tools/mcp-connector. The helper module also ships in the package: https://app.unpkg.com/@anthropic-ai/sdk@0.115.0/files/helpers/beta/mcp.d.ts
- PayPal's MCP server: local run with `npx -y @paypal/mcp --tools=all` and `PAYPAL_ACCESS_TOKEN` / `PAYPAL_ENVIRONMENT`; remote endpoints `https://mcp.sandbox.paypal.com/http` and `/sse`: https://developer.paypal.com/ai-tools/mcp-server.md
- npm registry: `@paypal/mcp` 1.8.1 depends on `@paypal/agent-toolkit` "latest" and `@modelcontextprotocol/sdk` ^1.6.1. `@paypal/agent-toolkit` 1.11.0 exports `./mcp` and depends on `zod` ^3.24.2, `ai` ^4.0.23, `openai` 4.86.1 and `@langchain/core` 0.3.6.
Consequences:
- Spike S4 passes when Claude calls `create_refund` on PayPal's MCP server through this shared harness.
- Sandbox tokens last hours. Mint a token when spawning the server, and respawn before it expires (on the hosted demo, once per baseline session).
- Declare `zod` 4 at the root so the hoisted copy is v4 and the toolkit gets a nested zod 3. If S4 shows a zod or SDK mismatch inside PayPal's server, install that workspace outside the npm workspace tree (`npm ci --prefix`) to isolate it fully.
- If the gate uses the toolkit for read pass-through, it uses the same out-of-process MCP client pattern and never imports the toolkit.
