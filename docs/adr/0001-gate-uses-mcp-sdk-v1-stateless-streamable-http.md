# 0001. The gate uses `@modelcontextprotocol/sdk` v1 (1.32.x) with stateless Streamable HTTP

Status: accepted
Decided-by: answerer (stated)
Question: Phase 1 constitution, Q1. Which MCP server package should the gate use for a Streamable HTTP MCP server: `@modelcontextprotocol/sdk` v1.32 or the v2 split package `@modelcontextprotocol/server` 2.3?
Decision: Pin `@modelcontextprotocol/sdk` 1.32.1 and use `McpServer` with `registerTool`. Serve it through `StreamableHTTPServerTransport` in stateless JSON mode: `sessionIdGenerator: undefined`, `enableJsonResponse: true`, and a new server and transport for each `POST /mcp`. `GET` and `DELETE /mcp` return 405. Don't use the v2 packages (`@modelcontextprotocol/server`, `/client`, `/node`, `/express`).
Basis:
- Brief §9, Framework: "Gate: `@modelcontextprotocol/sdk` (Streamable HTTP server) with a small HTTP framework, Zod for schemas." That package name is the v1 line.
- The v1.x README calls it "the maintenance line" and says it "implements the MCP spec up to 2025-11-25". It gets bug fixes and security updates for at least six months after v2's release on 2026-07-27, which is past 22 Dec 2026: https://github.com/modelcontextprotocol/typescript-sdk/blob/v1.x/README.md and https://github.com/modelcontextprotocol/typescript-sdk
- Anthropic's MCP connector (beta `mcp-client-2025-11-20`) supports Streamable HTTP and tool calls only, and cites the 2025-11-25 spec. The Anthropic TypeScript SDK's `mcpTools` helper examples use the v1 `Client`: https://platform.claude.com/docs/en/agents-and-tools/mcp-connector
- `@paypal/agent-toolkit` 1.11.0 and `@paypal/mcp` 1.8.1 depend on `@modelcontextprotocol/sdk` ^1.6.1 (npm registry).
- v2 reached 2.0.0 on 2026-07-27, after the June 2026 training cutoff of the model that runs the Ralph loop. v2 serves 2025-era clients only through a per-request stateless legacy shim: https://ts.sdk.modelcontextprotocol.io/v2/migration/support-2026-07-28. Parts of the v2 docs still label it beta.
Consequences:
- Gate schemas use zod 4 (4.6.7). SDK 1.32 accepts `zod` ^3.25 || ^4.0.
- Stateless mode keeps no session state in memory, so restarts and Render deploys never strand an agent. Step-up returns `pending_approval` at once instead of holding a stream open.
- Use `registerTool`, not the `.tool()` shorthand, which v2 removed.
- If v2 is ever needed, this stateless setup maps directly onto v2's default `createMcpHandler` entry.
