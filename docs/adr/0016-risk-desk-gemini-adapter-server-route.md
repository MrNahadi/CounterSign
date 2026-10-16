# 0016. The Risk desk analyst runs on Gemini through a `directLlmRunner` adapter that calls a console server route

Status: accepted
Decided-by: answerer (researched)
Question: Gemini migration, G8 (16 Oct 2026). Confirm AG Studio's `directLlmRunner` adapter interface, and that a Gemini adapter can run server-side so the API key never reaches the browser. What must spike S9 now prove?
Decision:
- Keep AG Studio's built-in harness (`createAiHarness(api, { adapter })`) with `directLlmRunner`. The agent loop and Studio's tools run in the page, as AG Studio designs it.
- **The adapter is a thin client proxy.** It replaces the boilerplate's `app/dashboard/studio/openai-adapter.ts`. Its `executeTurn(request, { signal })`:
  - POSTs the `AgLlmRequest` as is to a console route handler (Node runtime), for example `app/api/risk-desk/turn/route.ts`, passing `signal` to `fetch`;
  - returns `{ stream, complete }`, where `stream` yields the route's AG-UI events and `complete` resolves to the route's final `AgLlmResponse`.
- **The route does the Gemini work, server-side.** It uses `@google/genai` with `GEMINI_API_KEY` from a server-only module (no `NEXT_PUBLIC_` variable, `import "server-only"`). It translates:
  - `instructions` → `systemInstruction`;
  - `input` items (messages, `function_call`, `function_call_output`) → `contents` (`functionCall` / `functionResponse` with matching `id` and `name`);
  - `tools[].parameters` → `parametersJsonSchema` through the same sanitizer as ADR 0014, plus removing Studio's `{ not: {} }` sentinel;
  - `toolChoice` `auto` / `none` / `required` / named → `VALIDATED` / `NONE` / `ANY` / `ANY` with `allowedFunctionNames`;
  - `responseFormat` JSON → `responseMimeType: "application/json"` + `responseJsonSchema`;
  - `model.effort` → `thinkingLevel` (default `LOW`, ADR 0013).
- **Streaming.** The route streams Gemini text as `TEXT_MESSAGE_*` events. It buffers tool calls and emits `TOOL_CALL_START` / `TOOL_CALL_ARGS` / `TOOL_CALL_END` (with `toolCallId` = the Gemini call `id`) only after the final chunk passes the ADR 0015 check. On any failure, the turn's `complete` has `status: "failed"` and an `error`, with no tool calls.
- **Thought signatures survive Studio's history.** Studio's conversation items have no field for them. The route keeps each step's original Gemini model `Content` in a short-lived server-side store keyed by call ID, and substitutes it when that call reappears in `input`. If the entry is gone (restart), it uses Google's documented validator-skip signature for that part.
- **Limits.** The route enforces the console session, the per-session rate limit, the shared daily AI budget, a model allowlist and an output-token cap. The boilerplate's route has none of these.
Basis:
- AG Studio docs (v3.0.0): `AgLlmAdapter` has one required method, `executeTurn(request, options)`, which returns `AgLlmResponseHandler { stream, complete }`. `AgLlmRequest` has `input`, `instructions`, `tools` (`AgAiToolSchema` with JSON Schema `parameters`), `toolChoice`, `responseFormat` and `model`. Adapters emit the content half of the AG-UI events. Errors go on `complete` (`status: "failed"`). "`executeTurn` runs in the browser". For production, point it at your own backend that calls the provider with your secret key: https://www.ag-grid.com/studio/react/ai-direct-llm-runner/ and https://www.ag-grid.com/studio/react/ai-agents/
- The hackathon boilerplate already uses this split for OpenAI: a client adapter posts to `app/api/ai/responses/route.ts`, "The key never reaches the browser", and the route has no auth or rate limiting: https://github.com/paypaldev/hackathon-paypal-ag-grid-boilerplate
- Gemini's OpenAI-compatible endpoint has no Responses API, so the boilerplate's route can't be repointed by changing its URL: https://ai.google.dev/gemini-api/docs/openai
- Validator-skip signatures for history that didn't come from the model: https://ai.google.dev/gemini-api/docs/generate-content/thought-signatures
- Brief §5 item 11; §8 ("The public demo can't run up unbounded AI cost"; "No secrets in the repo").
Consequences:
- Spike S9 passes when, on Next 16.4.2 and React 19.3.1 with the licence key set:
  1. The boilerplate runs, one custom widget and the Graphite theme render, and no watermark shows.
  2. The analyst agent, through this adapter and route on `gemini-3.8-flash`, builds a widget from a typed question ("denied refunds by reason this week") across at least three model turns with tool calls, with no 400 from thought signatures.
  3. Every Studio built-in tool schema is accepted by Gemini after sanitizing.
  4. A `responseFormat` JSON turn with tools works, or the route is shown never to receive one.
  5. A forced failure surfaces as `status: "failed"` with no tool calls.
  6. The production build's client bundle contains no Gemini key (search `.next/static` for the key's prefix).
  7. The model calls per question are counted, to size quota and cost.
- `apps/console` depends on `@google/genai` 2.27.0, which runs only in route handlers.
- If Studio's `callId` can't round-trip, or the store proves unreliable, the fallback is the validator-skip signature for every replayed call. Google calls that discouraged, so S9 records whether quality holds.
