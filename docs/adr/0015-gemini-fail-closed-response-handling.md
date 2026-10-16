# 0015. A Gemini response is acted on only when it finished with `STOP`; safety filters are off; retries and fallback live in our code

Status: accepted
Decided-by: answerer (researched; the safety-filter setting is inferred from brief §5 Out of scope and §10 trade-off 2)
Question: Gemini migration, G5 (16 Oct 2026). What replaces Anthropic's "check `stop_reason: refusal` before reading content" and its server-side fallbacks? Which `safetySettings` suit a support inbox whose tickets deliberately contain prompt injections? Every failure must fail closed: no tool call means no money action.
Decision:
- **Response check, an allowlist that runs before any read.** A response is usable only if *all* of these hold:
  - `promptFeedback?.blockReason` is absent;
  - `candidates` has at least one entry;
  - `candidates[0].finishReason === "STOP"` (compared as a string);
  - `candidates[0].content.parts` is non-empty.

  Any other outcome ends the run, and no `functionCall` from that response is executed. That covers `SAFETY`, `PROHIBITED_CONTENT`, `BLOCKLIST`, `SPII`, `RECITATION`, `LANGUAGE`, `OTHER`, `MAX_TOKENS`, `MALFORMED_FUNCTION_CALL`, `UNEXPECTED_TOOL_CALL`, `TOO_MANY_TOOL_CALLS`, `MISSING_THOUGHT_SIGNATURE`, `MALFORMED_RESPONSE`, `ESCALATION`, `PUP_LIMITED_DISABLED`, `CONTINUATION`, an unknown value or a missing value. Don't use the SDK's `response.text` or `response.functionCalls` getters before the check. Never parse tool calls out of text.
- **Errors also end the run with no tool executed.** An `ApiError` (including HTTP 400 "Input blocked: …" for blocked input), a timeout or an abort ends the run the same way. The run ends in a typed outcome, `model_stopped:<reason>`. The ticket is left for the merchant, and no money action follows. In protected mode, only the gate can move money, and a stopped run proposes nothing more.
- **Safety settings.** Set all five adjustable categories to `HarmBlockThreshold.OFF` explicitly on every request: `HARM_CATEGORY_HARASSMENT`, `HARM_CATEGORY_HATE_SPEECH`, `HARM_CATEGORY_SEXUALLY_EXPLICIT`, `HARM_CATEGORY_DANGEROUS_CONTENT` and `HARM_CATEGORY_JAILBREAK`. That is already the default for Gemini 2.5 and later, but setting it explicitly keeps a default change from silently altering bench results. Google's built-in protections, such as child safety, can't be turned off, and they surface through the response check above.
- **Retries.** Use `httpOptions: { timeout, retryOptions: { attempts: 3, httpStatusCodes: [408, 500, 502, 503, 504] } }`. SDK retries are off unless `retryOptions` is set. 429 is left out on purpose so a daily-quota error isn't retried with backoff for minutes. Our code handles 429: wait once if the error's retry delay is short (per-minute quota); otherwise treat it as quota exhausted.
- **Fallback.** No server-side fallback exists, so the fallback is client-side: `gemini-3.6-flash` (stable, same price, its own per-model quota). Switch only between ticket runs, never mid-loop, because thought signatures from one model shouldn't be replayed to another. The bench runner disables fallback. A case whose model is unavailable is recorded as such and rerun, and every call's `modelVersion` goes in the results.
Basis:
- `FinishReason` and `BlockReason` values: https://ai.google.dev/api/generate-content. `promptFeedback` is "sent only in the first stream chunk and only happens when no candidates were generated due to content violations": js-genai v2.27.0 `src/types.ts`.
- Adjustable categories include `jailbreak` ("Prompts designed to bypass safety filters"); unset categories default to off "for Gemini 2.5 and later models"; core harms "are always blocked and cannot be adjusted"; blocked requests return HTTP 400 with codes `safety`, `jailbreak`, `prohibited_content` and `blocklist`: https://ai.google.dev/gemini-api/docs/safety-settings (updated 2026-10-15). `HARM_CATEGORY_JAILBREAK` and `HarmBlockThreshold.OFF` are in the v2.27.0 enums.
- SDK retry: off without `retryOptions`; default retryable codes 408, 429, 500, 502, 503, 504; 5 attempts by default; no default timeout: https://github.com/googleapis/js-genai/blob/v2.27.0/src/_api_client.ts
- Brief §5, Out of scope: "Classifiers that try to detect lies or injections. That's the opposite of the approach." Brief §8: "Fail closed." Brief §10 trade-off 2: honest evidence. A jailbreak filter in front of the agent would make the bench measure Google's classifier instead of Countersign.
Consequences:
- Results JSON reports `model_stopped` outcomes separately, by reason and by mode. A stopped attack case moved no money, but it isn't counted as Countersign stopping it.
- Spike S8 checks the response check against a forced `MAX_TOKENS` (a tiny `maxOutputTokens`) and records a real 429 body, so the quota branch parses real errors.
- Set `maxOutputTokens` generously, because thinking tokens count toward it and `MAX_TOKENS` ends the run.
- The same check wraps the mandate compiler (no draft on failure) and the Risk desk route (turn status `failed`).
