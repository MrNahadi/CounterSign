# 0002. The gate's HTTP framework is Express 5

Status: accepted
Decided-by: answerer (researched)
Question: Phase 1 constitution, Q2. Which HTTP framework should the gate use for the MCP endpoint, approval API, PayPal webhooks and Daraja callbacks: Express 5.3 or Hono 4.13 on Node?
Decision: Pin Express 5.3.0. One Express app serves `POST /mcp`, the approval API, PayPal webhooks and Daraja callbacks. Build it with plain `express()`, not the SDK's `createMcpExpressApp()`, because that helper applies `express.json()` to every route. Install one global `express.json({ verify })` that also keeps the raw body bytes on the request, so the PayPal webhook route can verify signatures. On Render, bind to `0.0.0.0`; `/mcp` is authenticated by principal API keys. The SDK's `hostHeaderValidation([...])` middleware can additionally guard `/mcp`.
Basis:
- Brief §9, Framework, No opinion: "Which small HTTP framework".
- SDK v1's canonical stateless server example (`src/examples/server/simpleStatelessStreamableHttp.ts`) is an Express app. v1 ships `server/express.js` (`createMcpExpressApp`) and `server/middleware/hostHeaderValidation.js`: https://github.com/modelcontextprotocol/typescript-sdk/blob/v1.x/docs/server.md
- `@modelcontextprotocol/sdk` 1.32.1 depends on `express` ^5.2.1, so Express is already in the dependency tree (npm registry).
- Hono would need v1's `webStandardStreamableHttp` transport, which has far fewer examples than the Node/Express path.
Consequences:
- Express 5 forwards rejected promises from async handlers to the error middleware. Handlers don't need try/catch wrappers.
- Hono is not used. It's still installed transitively by the SDK.
