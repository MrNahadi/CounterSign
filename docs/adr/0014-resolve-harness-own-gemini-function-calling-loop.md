# 0014. Resolve's harness is our own Gemini function-calling loop over the MCP v1 client, in both modes

Status: accepted
Supersedes: 0011 (harness part). The rest of 0011 still stands: one harness for both modes, protected mode over Streamable HTTP to the gate, baseline mode over stdio to `@paypal/mcp` in the isolated `apps/baseline-paypal-mcp` workspace, and only the transport differs between modes.
Decided-by: answerer (researched)
Question: Gemini migration, G2 (16 Oct 2026). Replace 0011's `beta.messages.toolRunner` with one Gemini harness for both modes, taking tools from the `@modelcontextprotocol/sdk` v1 `Client`. Use the experimental `mcpToTool` with automatic function calling (AFC), or a function-calling loop we own? Every tool call and result must be in the trace. How do MCP `inputSchema`s map to Gemini function declarations?
Decision:
- **We own the loop.** Don't use `mcpToTool`, AFC, `ai.chats`, the Interactions API, or Gemini's server-side `mcpServers` tool. Pass plain `FunctionDeclaration`s only; that never triggers AFC.
- **Tools.** At session start, page through `client.listTools()` until there's no `nextCursor`. Sort by name, convert each tool to `{ name, description, parametersJsonSchema: sanitize(inputSchema) }`, and reuse that one array for every call in the session.
- **Loop.** For each ticket:
  1. `contents = [user turn: rendered ticket text + inline image parts]`.
  2. Call `ai.models.generateContent({ model, contents, config })`. The config carries `systemInstruction`, `tools: [{ functionDeclarations }]`, `toolConfig.functionCallingConfig.mode = VALIDATED`, `thinkingConfig` and `safetySettings` (ADRs 0013, 0015). The same config is sent on every step.
  3. Run the ADR 0015 response check. If it fails, stop: no tool from that response runs.
  4. Append `candidates[0].content` to `contents` unchanged. That keeps thought signatures in the parts where they arrived, which Gemini 3 requires for function calling (a missing signature returns 400).
  5. If there are no `functionCall` parts, the text is the final reply.
  6. Otherwise run every call **sequentially in the order given** with `client.callTool({ name, arguments: args ?? {} })`. Append **one** user turn holding a `functionResponse` per call, `{ id, name, response }`, in the same order (FC1, FC2 → FR1, FR2).
  7. Repeat up to a fixed step cap. Hitting the cap ends the run with no further tool calls.
- **Mapping results.** `CallToolResult` becomes `response: { output: structuredContent ?? joinedText }`. If `isError` is set, it becomes `response: { error: joinedText }` and the model sees it. A transport failure on the MCP client ends the run (fail closed) instead of being reported to the model. A call to a name that isn't in the declared set is never forwarded, and the run ends.
- **Schema sanitizer.** A pure, unit-tested function, applied identically in both modes. It rewrites what the model sees, never what the server validates. The gate (zod 4) and PayPal's server (zod 3) stay the authority on arguments. It:
  - removes `$schema`, `$id` and `$comment`;
  - turns boolean subschemas `true` into `{}` and drops `false` properties;
  - turns draft-04 boolean `exclusiveMinimum` / `exclusiveMaximum` into numeric bounds;
  - turns tuple `items: [...]` into `prefixItems`;
  - filters `required` down to declared `properties`;
  - inlines non-recursive `$ref`s (`#/$defs/…`, `#/definitions/…` and zod-to-json-schema's `#/properties/…` pointers) and replaces recursive ones with `{}`;
  - collapses `type: [T, "null"]` inside array `items` to `T`;
  - adds a missing `type` where it can be inferred.
  Each rewrite is logged once per session in the trace.
- **Gate schemas are Gemini-safe by construction.** No tuples, no unions inside array items, no recursion, no typed records. A unit test asserts the sanitizer is a no-op on every gate tool's advertised schema, so protected mode shows the model exactly what the gate declares.
- **Trace.** For every model call, record:
  - step, `model`, `response.modelVersion` and `responseId`;
  - `finishReason` and `promptFeedback`;
  - `usageMetadata`: prompt, candidates, thoughts and `cachedContentTokenCount`;
  - latency.
  For every function call, record `{ id, name, args }`, the full `CallToolResult` and its latency. This is the record that claims-vs-records and the bench read. Generate a local call ID if the API omits `functionCall.id`.
Basis:
- js-genai README: built-in MCP support is "an experimental feature"; "We are changing AFC behavior in the next major version"; "users will not be able to invoke AFC from direct calls to `Models.generateContent`": https://github.com/googleapis/js-genai. Docs: "Breaking changes might occur in future releases": https://ai.google.dev/gemini-api/docs/generate-content/function-calling
- Thought signatures: "If you omit a `thought_signature` for the first `functionCall` part in any step of the current turn, the request will fail with a 400 error"; the SDK handles them when you "append the full model response object directly to history"; parallel order FC1+signature, FC2, FR1, FR2: https://ai.google.dev/gemini-api/docs/generate-content/thought-signatures
- "A `FunctionResponse` turn must strictly match the `id`, `name`, and execution count of the preceding `FunctionCall`": https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/guides/gemini-3-8-flash. `FunctionResponse.response`: "Use "output" key to specify function output and "error" key to specify error details": js-genai v2.27.0 `src/types.ts`.
- `parametersJsonSchema` is JSON Schema and mutually exclusive with `parameters` (the OpenAPI 3.0 subset): https://ai.google.dev/api/generate-content. Gemini's server-side `mcpServers` tool works only with Streamable HTTP servers: https://ai.google.dev/gemini-api/docs/function-calling. It has the same objections as Anthropic's connector in 0011: no stdio baseline, and tool execution off our side.
- Schema shapes that return 400 from Gemini even through `parametersJsonSchema` (orphan `required`, boolean exclusive bounds, tuple `items`, `$ref` loops), tested on `gemini-3.5-flash-lite`, Sep 2026: https://github.com/NousResearch/hermes-agent/pull/122060. `items` with `type: ["object","null"]` and boolean `true` schemas returned 400 on `gemini-3.7-flash`, Aug 2026: https://github.com/github/copilot-cli/issues/4623. `$schema` and exclusive bounds rejected through `parameters`: https://github.com/QwenLM/qwen-code/issues/1186, https://github.com/modelcontextprotocol/servers/issues/1624. `$defs` references failing: https://github.com/google-gemini/gemini-cli/issues/13326
- Brief §5 item 6 ("the same agent wired straight to PayPal's tools"), §8 (fail closed; "The baseline isn't tuned to fail"), §10 trade-off 2 (honest evidence).
Consequences:
- Spike S4 now passes when this Gemini harness calls `create_refund` on PayPal's MCP server. S4 and S8 also send the full tool lists of both servers in one VALIDATED request and get a 200 (a `LIVE=1` test).
- If VALIDATED rejects the full tool list (Google warns that constrained modes may reject very large or deeply nested schemas), both modes switch to `AUTO` together. Money safety doesn't depend on the mode, because servers validate arguments.
- Google advises keeping 10–20 active tools. PayPal's `--tools=all` exposes more. Any allowlist must be identical in both modes and is decided from bench measurements, not assumed.
- The harness never retries a tool call. Model calls can be retried (ADR 0015) because they have no side effects. Gate idempotency (intent hash) covers any repeat proposal.
- `@modelcontextprotocol/sdk` stays at 1.32.1, which satisfies `@google/genai`'s optional peer range.
