# Progress: phase 8, Resolve, protected and baseline (specs/features/08-resolve-protected-and-baseline)

## T-001 (done)
- `@countersign/db` gains `tickets.thread_id` and `ticket_attachments` (migration `0003_striped_ikaris.sql`, hand-edited to add the column nullable, backfill `thread_id = id`, then set NOT NULL), plus `readThread`, `listThreads`, `writeAttachment`, `readAttachment` and the `ThreadTicket`, `ThreadSummary`, `Attachment`, `StoredAttachment` types.
- Gotcha: `readTicket` still returns the old `Ticket` shape (no `threadId`) so existing `toEqual` tests hold; use `readThread`/`listThreads` to get the thread. `writeTicket` stores `threadId ?? id` and refuses a rewrite with another thread.
- Gotcha: received times are text with any offset; thread order uses `received_at::timestamptz`. `listThreads` reports `latestActivityAt` as the latest ticket's stored text (T-002 may want run times too).
- Gotcha: drizzle-kit writes `ADD COLUMN ... NOT NULL` with no backfill; hand-edit any NOT NULL column added to a table with rows. Migration tests that slice the journal should count `journal.entries.length - N`, not a constant.
- bytea is a `customType` in `schema.ts` (Buffer to the driver, Uint8Array back).

### For the human
- `packages/db/test/tickets.test.ts`'s phase 6 migration test expected exactly 1 migration to apply; it now expects every migration after phase 6 (`journal.entries.length - 2`). Same strictness, but it's an edit to an existing test.

## T-002 (done)
- `@countersign/db` gains `agent_runs` (migration `0004_stale_beyonder.sql`) and `createRun`, `startRun`, `finishRun`, `readRun`, `readRunsByThread`, `countRunsOnDate(db, "YYYY-MM-DD")`, `markUnfinishedRunsInterrupted(db, finishedAt)`, with `AgentRun`, `NewRun`, `RunResult` types and `RUN_MODES`/`RUN_STATUSES`.
- Gotcha: `finishRun` accepts a `queued` or `running` run (so `not_run` needs no start) and throws `AgentRunConflictError` on a final one, `AgentRunNotFoundError` on an unknown ID. `createRun` is always `queued`; `trace` is any JSON value (null when none). A `seq` bigserial column keeps creation order. The daily count uses the queued time as a UTC date.

## T-003 (done)
- `apps/resolve-agent/src/model.ts`: `SYSTEM_INSTRUCTION`, `parseModelEnv`, `geminiClientOptions`, `createGenerateContent(apiKey)`, `buildModelRequest({ model, contents, declarations })` (sorts by name), `checkResponse` and `callModel({ generateContent, request, sleep? })` returning `{ ok, response, content }` or `{ ok: false, outcome, response? }`.
- Gotcha: stop reasons are the block or finish reason as given (if it matches `^[A-Z][A-Z0-9_]{0,63}$`, else `UNKNOWN`), plus `NO_CANDIDATE`, `FINISH_REASON_MISSING` and `NO_PARTS`. The console (T-012) needs words for those three.
- Gotcha: a 429 retry delay is read from the `ApiError` message JSON (`error.details[]` RetryInfo `retryDelay: "Ns"`); no readable delay means `model_unavailable`. A non-API error (e.g. `fetch failed`) is `model_error`; DOMException `TimeoutError`/`AbortError` is `model_unavailable`. `callModel` does not time calls; T-005 measures latency.
- zod resolves from the root `package.json` (4.6.7); resolve-agent does not list it, same as the other workspaces.

## T-004 (done)
- `apps/resolve-agent/src/sanitize.ts`: `sanitizeSchema(inputSchema)` returns `{ schema, rewrites }`; each rewrite is `{ rule, path, detail }` (rules in `SCHEMA_REWRITE_RULES`, `path` a JSON Pointer into the output). Pure; output shares no objects with the input. `$defs`/`definitions` are dropped (refs are inlined from the original root); a non-object root becomes `{ type: "object" }`.
- `apps/gate/test/fixtures/tools-list.json` is the gate's exact `tools/list` answer (`{ tools }`, all pages); `apps/gate/test/tools-list.test.ts` fails on drift. Resolve's test reads it via `createRequire(...).resolve("@countersign/gate/test/fixtures/tools-list.json")`.
- Gotcha: `z.toJSONSchema` emits `$schema` at each tool's root, which the sanitizer must remove. The gate's `mcp.ts` now strips it (`advertised()`), so the sanitizer makes no rewrite on gate tools. Re-record the fixture when a gate schema changes on purpose.
- Gotcha: `erasableSyntaxOnly` forbids constructor parameter properties (`constructor(private x)`).

### For the human
- The gate's advertised input schemas no longer carry `$schema` (ADR 0014's "Gemini-safe by construction"). Validation is unchanged.

## T-005 (done)
- `apps/resolve-agent/src/harness.ts`: `runHarness({ db, client, generateContent, model, ticketId, threadId, now?, sleep? })` returns `{ status, outcome, reply, modelVersions, toolCallCount, trace }` (`trace` is `{ tools, rewrites, steps }`, steps `kind: "model" | "tool"`). Also exports `findOrder(db, args)`, `FIND_ORDER`, `NO_ORDER`, `MAX_MODEL_CALLS`, `MAX_TOOL_CALLS`, `TicketNotInThreadError`.
- Gotcha: the harness does not write `agent_runs`; T-006 maps the result to `finishRun`. `toolCallCount` is there for T-010's "rerun only if no tool call ran". A listTools failure ends `tool_transport_failed`; T-006 must check `gate_unavailable` before calling the harness.
- Gotcha: limits are "at most": a 9th model call or a batch that would take tool calls past 12 ends `step_cap`, and the whole over-limit batch is refused (no partial batch). An undeclared name anywhere in a response refuses the whole response. A server tool named `find_order` is shadowed by the local one.
- Gotcha: `find_order` not-found and malformed args both go back as `isError` results (`{ error }` to the model). Amounts use `toPayPalDisplayAmount` from `@countersign/rail-paypal`. A call with no ID gets `local_<step>_<n>`.
- Gotcha: the request's `contents` array is the live history, so tests snapshot it (`structuredClone`) to assert what a call saw.

## T-006 (done)
- `apps/resolve-agent/src/intake.ts`: `newId("tkt"|"att"|"run")` (prefix plus 128 random bits) and `storeMessage(db, message, { mode, model, clock })`, which writes attachments, then the simulated ticket, then a queued run, and returns `{ ticketId, threadId, runId }`. It does no thread or attachment validation; T-009's API must check the thread (exists, same channel and sender) and the attachments first.
- `apps/resolve-agent/src/protected.ts`: `parseProtectedEnv(env)` (`{ gateUrl, key }`, key null under 32 chars, URL null unless http(s)), `connectGate(env)` (MCP `Client` or null on any failure), `runProtected({ db, runId, env, generateContent, clock, now?, sleep?, log? })` returning the finished `AgentRun`. Stored trace is `RunTrace` = harness trace plus `mode`. `RunOutcome` adds `gate_unavailable`.
- Gotcha: `runProtected` throws `RunNotQueuedError` unless the run is queued and protected. An unexpected harness exception leaves the run `running` (T-010's interrupted sweep catches it). T-008 should reuse `RunTrace` and the same finish shape for baseline.
- Gotcha: the e2e test imports `@countersign/gate/src/app`, `@countersign/gate/test/fake-sandbox` and `@countersign/gate/proposals/beat-3-attack-email.json` by package subpath (the gate has no `exports` field), and `@countersign/carrier-mock` and `@countersign/ledger`, which resolve-agent doesn't list (hoisted workspace links).

### For the human
- `apps/resolve-agent/test/protected.test.ts` imports `@countersign/carrier-mock` and `@countersign/ledger`, which aren't in resolve-agent's `devDependencies` (they resolve through the workspace root). Adding them needs a lockfile update, which the loop doesn't do.

## T-007 (done)
- `createPayPalClient(...).issueAccessToken()` returns `{ accessToken, expiresAt }` (epoch ms from the client clock + `expires_in`). It makes its own OAuth call via the shared `requestToken()`, never reads or replaces the cached token, and the token joins the client's scrub list. The sandbox-only rule holds because the client cannot be built for another base URL.
