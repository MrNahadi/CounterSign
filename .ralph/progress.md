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

## T-008 (done)
- `apps/resolve-agent/src/baseline.ts`: `runBaseline({ ...ModeRunInput, issueToken, createTransport? })`, `connectBaseline`, `baselineServer(token)`, `paypalMcpEntry()` (resolved via `@countersign/baseline-paypal-mcp/package.json`, then `@paypal/mcp/package.json`'s `bin`), `stdioTransport`, `paypalTokenIssuer(env)`. Shared start/connect/harness/finish moved to `src/runs.ts` (`executeRun`, `RunTrace`, `RunOutcome` now includes `baseline_unavailable`, `RunNotQueuedError`, `ModeRunInput`); `protected.ts` re-exports the types.
- Gotcha: T-007 left `apps/gate/test/fake-sandbox.ts` without `issueAccessToken`, so `npm run typecheck` failed; it now throws "isn't in the fake sandbox".
- Gotcha: InMemoryTransport's close re-enters the client side, so count child closes with the server's `onclose`, not by wrapping `close`.
- `test/baseline.test.ts` scans every code file outside `apps/baseline-paypal-mcp` for imports of `@paypal/mcp` or `@paypal/agent-toolkit`; build sample strings from parts in tests so the scan doesn't flag them.

## T-009 (done)
- `apps/resolve-agent/src/app.ts`: `createApp({ db?, model, queue, clock?, log? })` (Express 5): `POST /messages` (202 `{ ticket_id, thread_id, run_id }`, 400 `{ message }`), `GET /threads` (`{ threads: [{ thread_id, channel, sender_email, sender_phone, subject, preview, latest_activity_at, latest_run: { run_id, mode, status, outcome } | null }] }`), `GET /threads/:id` (`{ thread_id, messages: [{ ticket_id, channel, sender_email, sender_phone, subject, body, attachments: [{ id, content_type }], received_at, simulated }], runs: [{ run_id, ticket_id, mode, model, model_versions, status, outcome, reply, queued_at, started_at, finished_at, trace }] }`, 404), `GET /attachments/:id` (bytes, 404). No db: everything but /health answers 503. All answers are snake_case; T-012's zod schemas should mirror these.
- `src/messages.ts`: `checkMessage(db, body)` (zod, image sniffing, thread match by exact channel/email/phone) and `sniffImageType`. `src/queue.ts`: `createRunQueue(runner, log)` (`enqueue`, `idle`) and `createModeRunner({ db, generateContent | null, protectedEnv, issueToken, createTransport?, clock, log? })`; a null model already ends runs `not_run` `not_configured` (T-010 only needs to confirm it). `src/serve.ts`: `serve(env, { pgliteDir?, host?, log? })` and `parsePort`; `server.ts` just calls `serve(process.env)`.
- Gotcha: the queue swallows a runner's throw (logs the error name only), so a thrown run stays `running` until T-010's startup sweep. Queued runs from an earlier process aren't re-enqueued at startup (T-010 marks them interrupted).
- Gotcha: a body over 10 MB or unreadable JSON answers 400 (not 413) with one sentence, from the app's error handler.

## T-010 (done)
- `src/limits.ts`: `parseDailyCap(env)` (default 200, throws naming `RESOLVE_DAILY_RUN_CAP`), `utcDate`. `createApp({ dailyCap })` counts runs on the arrival's UTC date before storing; a capped message is stored and its run finished `not_run` `daily_cap`, never enqueued. `serve` parses the cap before opening the database and sweeps `queued`/`running` runs to `failed` `interrupted` before listening.
- Fallback: `ModeRunner` may now return a follow-up run ID, which the queue enqueues next; `createModeRunner({ fallbackModel })` creates that run (same ticket, thread and mode) after a `model_unavailable` run whose trace has no `tool` step. `queue.idle()` now waits until the tail stops moving.
- Gotcha: `createApp` reads the clock once per message and passes it to `storeMessage`, so test clocks that tick aren't advanced twice. Tests for model behaviour must use baseline mode unless a gate key is set (protected without a key ends `gate_unavailable` before any model call).

## T-011 (done)
- `apps/resolve-agent/src/resolve-cli.ts`: `runResolve(args, env, { db?, generateContent?, issueToken?, createTransport?, clock? })`, `MessageFileSchema`, `RESOLVE_USAGE`, exit codes; `resolve-main.ts` entry; root `resolve` script. Each message is built into a `POST /messages` body and goes through `checkMessage`, then `storeMessage`, then the server's `createModeRunner` (so fallback reruns and `not_configured` behave the same); the daily cap applies too. Scenarios in `apps/resolve-agent/scenarios/` (beat 5's photo is `beat-5-damaged-basket.jpg`, a drawn 320x240 JPEG).
- Gotcha: the CLI refuses to start (exit 2) without `GEMINI_API_KEY`, and in protected mode without `COUNTERSIGN_SUPPORT_AGENT_KEY`; in baseline mode without the PayPal variables unless `issueToken` is injected. Exit is decided by each message's last run (a fallback rerun that replied counts as replied).
- Gotcha: the guarded agent response has no PayPal refund ID (only `intent_id`), so the CLI prints the intent for an allowed call. T-012's "allowed refund shows its PayPal refund ID" will need it from the audit log's `execution.result`, not the tool result.
- Test scripts find the ticket being answered from the user turn's `Ticket ID: tkt_...` line.

### For the human
- requirements.md says resolve-agent's `dev` and `start` scripts load env with `--env-file-if-exists=.env.local`; they still run plain `tsx` (not part of T-011's acceptance).
- `npm run lint` has one pre-existing warning (`void` in a union in `apps/resolve-agent/src/queue.ts`, from T-010).

## T-012 (done)
- Console inbox: `apps/console/src/resolve-schemas.ts` (zod for every Resolve answer, plus the MCP result and agent-response shapes), `src/resolve-routes.ts` (`resolveAgentUrl`, `loadThreads`, `loadThread`, `threadsRoute`, `threadRoute`, `attachmentRoute`, `RESOLVE_UNREACHABLE`; injected `fetch`), `src/inbox-view.ts` (`threadListItems`, `threadView`, `runView`, `toolRow`, `outcomeSentence`, `statusBadge`, `POLL_INTERVAL_MS`, `MONEY_TOOLS`). Routes under `app/api/resolve/` (threads, threads/[id], attachments/[id]). `/inbox` is a server page (`?thread=<id>` selects); `RefreshWhileWorking` calls `router.refresh()` every 2 s while any run is queued or running. Sidebar is `app/console-shell.tsx` + `app/console-nav.tsx`.
- Resolve's `GET /threads/:id` adds `executions: [{ intent_id, outcome, refund_id, refund_status }]` per run (`src/executions.ts`, latest `execution.result` per allowed intent, read-only from `audit_log`).
- Gotcha: never import `src/inbox-view.ts` (or `@countersign/mandate`) from a client component: mandate pulls in `node:crypto`. Build views on the server and pass plain props down.
- Gotcha: `POST /api/resolve/messages` isn't built yet (T-013). The inbox header is where T-013's mode switch and "Simulate a message" go.
- Gotcha: the daily-cap sentence is "Resolve didn't run: today's run limit is reached." with no number, since the console doesn't know `RESOLVE_DAILY_RUN_CAP`.

### For the human
- requirements.md's example "today's limit of 200 runs is reached" would need Resolve to report its cap; the inbox says "today's run limit is reached" instead.

## T-013 (done)
- Composer: `apps/console/src/composer.ts` (`messageRequest(form, mode)` returns the `POST /messages` body or `{ field, problem }`; `checkPhoto`, `toBase64`, `sendMessage(request, { fetch })`, `BASELINE_NOTE`, `SIMULATED_NOTE`, `MODE_OPTIONS`, `CHANNEL_OPTIONS`, `parseMode`, `MODE_STORAGE_KEY`). Route: `messagesRoute(request, deps)` and `sendToResolve(input, deps)` in `src/resolve-routes.ts` (10 MB read limit, strict `MessageRequestSchema`, Resolve's 400 sentence passed on, 202 `{ ticket_id, thread_id, run_id }`), wired at `app/api/resolve/messages/route.ts`. UI: `app/inbox/inbox-header.tsx` (client: mode switch, Baseline note, native `<dialog>` that becomes a bottom sheet under 640px).
- Gotcha: `composer.ts` is imported by a client component, so it and `resolve-routes.ts`/`resolve-schemas.ts` must stay browser-safe (no `Buffer`, no mandate, no `server-only`). T-014's chat page can reuse `messageRequest`/`sendMessage` with `channel: "chat"`.
- Gotcha: Tailwind v4 preflight zeroes `<dialog>` margins, so the dialog needs `sm:m-auto` (desktop) and `mt-auto mb-0` (sheet) explicitly. Field errors use `aria-invalid:inset-ring-danger-border-default`.
