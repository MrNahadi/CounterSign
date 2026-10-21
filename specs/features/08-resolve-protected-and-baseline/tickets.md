# Phase 8 tickets: Resolve, protected and baseline

## T-001: Threads and attachments in the ticket store

Status: done
Blocked by:
Tier: standard
Slice: A two-message thread with a photo is written to the store and read back in order, with the photo's bytes, while the gate's CLIs keep writing tickets as before.
Test seam: the ticket, thread and attachment writers and readers exported by `@countersign/db`, over PGlite
Acceptance:
- [x] A migration adds `tickets.thread_id` (not null; existing rows take their own ID) and the write-once `ticket_attachments` table (ID, ticket ID, content type, size, bytes); `npm run db:migrate` applies it on a fresh and on a phase 7 database
- [x] `writeTicket` takes an optional `threadId`, defaulting to the ticket's ID, and compares it like any other field; every existing db and gate test passes unchanged
- [x] An attachment writes and reads back byte for byte with its content type; rewriting the same ID with other bytes is refused with a typed error
- [x] A thread reader returns a thread's tickets oldest first; a thread list returns each thread's first ticket and its latest activity time, newest first; an unknown thread reads as none
Notes:

## T-002: Agent runs in the store

Status: done
Blocked by: T-001
Tier: simple
Slice: A run is queued for a ticket, moves to running and then replied, and reads back with its reply, outcome, models and trace.
Test seam: the run writer and readers exported by `@countersign/db`, over PGlite
Acceptance:
- [x] The migration (or a second one) adds `agent_runs` with ADR 0030's columns; status and mode are checked by constraint
- [x] Runs can be created `queued`, started, and finished with a status, outcome, reply, model versions and trace; a finished run can't be finished again
- [x] Runs read back by ID and by thread, in creation order; the runs created on a given UTC date can be counted
- [x] Every `queued` or `running` run can be marked `failed` `interrupted` in one call, which returns how many it changed
- [x] Inputs are validated with zod, and times pass the shared timestamp rule
Notes:

## T-003: The Gemini call and the response check

Status: done
Blocked by:
Tier: standard
Slice: One model step is sent with the exact request shape requirements.md fixes, and its answer is either a usable content or a typed stop, with nothing read before the check.
Test seam: the model module of `apps/resolve-agent/src/` (its env parser, request builder and checked call), with an injected `generateContent`
Acceptance:
- [x] The env parser reads `GEMINI_API_KEY`, `GEMINI_MODEL` and `GEMINI_FALLBACK_MODEL` with zod (exact `gemini-` IDs, never `-latest`; defaults per ADR 0017; empty fallback means none) and names a missing variable without showing any value
- [x] The client is built with `vertexai: false`, the 90 s timeout and the 408/5xx retry options; the config holds the system instruction, sorted declarations, `VALIDATED`, `MEDIUM`, the five safety categories at `OFF` and `maxOutputTokens` 8192, and no sampling or budget fields
- [x] A block reason, no candidate, each non-`STOP` finish reason (an unknown string and a missing one included) and empty parts each give `model_stopped:<reason>`
- [x] A 429 with a retry delay of 10 s or less waits once and retries; a longer delay, a second 429, or a 5xx or timeout after retries gives `model_unavailable`; any other API error gives `model_error`
- [x] The system instruction is the exact text in requirements.md, and a test pins it
Notes:

## T-004: The schema sanitizer, and the gate's tool list as a fixture

Status: done
Blocked by:
Tier: standard
Slice: Any MCP tool's input schema becomes a Gemini-safe declaration, and the gate's own schemas pass through untouched.
Test seam: the sanitizer exported from `apps/resolve-agent/src/`, and `apps/gate/test/fixtures/tools-list.json` with the gate test that checks it
Acceptance:
- [x] Each ADR 0014 rewrite has a case: `$schema`/`$id`/`$comment` removed, `true` and `false` subschemas, boolean exclusive bounds, tuple `items`, `required` filtered to declared properties, non-recursive `$ref`s inlined and recursive ones replaced with `{}`, `[T, "null"]` inside `items`, inferred `type`
- [x] It's pure (the input is never changed) and reports each rewrite it made
- [x] The gate gains a recorded `tools-list.json` and a test that fails when its live `tools/list` answer differs from it
- [x] The sanitizer makes no rewrite on any tool in that fixture
Notes:
- The gate's `tools/list` now leaves `$schema` out of each advertised schema (zod still validates arguments), so the sanitizer is a no-op on every gate tool.

## T-005: The harness loop, with find_order

Status: done
Blocked by: T-003, T-004
Tier: standard
Slice: A ticket runs through the function-calling loop against any MCP client: the model looks up an order, calls a tool, gets its result back, and replies; every step is in the trace.
Test seam: the harness's run function in `apps/resolve-agent/src/`, with a scripted model and an MCP SDK `Client` over `InMemoryTransport` to a small in-process `Server`, and a PGlite `seed_orders` row
Acceptance:
- [x] Tools are listed (all pages), joined by `find_order`, sorted and sanitized once per run; the user turn renders the thread, then the ticket's ID, channel, sender, subject, time, body and photos as inline image parts
- [x] Calls run in order and return as one user turn of `functionResponse` parts with matching IDs and names; `isError` results go back as `error`; the model's content is appended unchanged, thought signature included
- [x] An undeclared tool name, a transport failure, 8 model calls, 12 tool calls and an empty reply each end the run with requirements.md's outcome and no further tool call; a failed response check runs none of its calls
- [x] `find_order` answers a seeded order's numbers, IDs, amount and tracking number, never the payer's email, and "No order with that number." otherwise; a malformed order number goes back as an error
- [x] The trace holds every model call's step, model version, finish reason, token counts and latency, and every tool call's arguments, result and latency
Notes:

## T-006: Protected mode end to end against the real gate

Status: done
Blocked by: T-001, T-002, T-005
Tier: standard
Slice: Beat 4's message, stored as a ticket, runs in protected mode against a listening gate: the scripted agent finds the order, proposes the refund, the gate allows it and refunds once, and the run is stored as replied.
Test seam: the protected-mode runner in `apps/resolve-agent/src/` (store a message, run it, finish the run), with `createApp` from `@countersign/gate`, its fake sandbox and a shared PGlite handle
Acceptance:
- [x] Connects to `GATE_MCP_URL` with the principal key as a bearer token; lists the gate's 13 tools plus `find_order`
- [x] Beat 4 is allowed with exactly one refund in the fake sandbox; the audit log's decision entry names the ticket; the run is `replied` with the gate's agent response in its trace
- [x] Beat 3's scripted five `create_refund` calls get 4 denials and 1 step-up, as phase 7's file expects; `ledger verify` passes
- [x] No key, a short key, a wrong key and no gate each end `failed` `gate_unavailable` with no model call
- [x] No fake principal key, PayPal secret or token appears in the run row, the trace or any log line
Notes:

## T-007: A fresh sandbox token for baseline mode

Status: done
Blocked by:
Tier: simple
Slice: The PayPal rail client hands out a freshly minted sandbox access token and its expiry, for baseline mode's child process only.
Test seam: `createPayPalClient(...)`'s new `issueAccessToken()` in `@countersign/rail-paypal`, against the fake PayPal and recorded OAuth fixture
Acceptance:
- [x] Returns a token minted by its own OAuth call (not the client's cached one) with its expiry time from `expires_in`
- [x] Refuses any base URL but the sandbox's, as every other call does
- [x] A failed or unreadable OAuth answer is a `PayPalError` whose message holds neither the client secret nor any token
Notes:

## T-008: Baseline mode

Status: done
Blocked by: T-005, T-007
Tier: standard
Slice: The same ticket runs in baseline mode: the harness starts PayPal's own MCP server with a fresh token, the same agent works through PayPal's tools with no gate, and the child is closed afterwards.
Test seam: the baseline-mode runner in `apps/resolve-agent/src/`, with an injected token issuer and transport factory
Acceptance:
- [x] The child is started with `process.execPath`, `@paypal/mcp`'s entry point resolved from `apps/baseline-paypal-mcp`, and `--tools=all`; its env is the SDK's default environment plus `PAYPAL_ACCESS_TOKEN` and `PAYPAL_ENVIRONMENT=SANDBOX` only; stderr is ignored
- [x] The child is closed after a replied, a stopped and a failed run; a token or spawn failure ends `failed` `baseline_unavailable` with no model call
- [x] A protected and a baseline run of the same ticket send byte-identical system instructions, configs (declarations aside) and user turns, and both declare `find_order`
- [x] Baseline runs append nothing to the audit log, and are stored with mode `baseline`
- [x] Nothing outside `apps/baseline-paypal-mcp` imports `@paypal/mcp` or `@paypal/agent-toolkit`
Notes:

## T-009: Resolve's HTTP API and run queue

Status: done
Blocked by: T-006
Tier: standard
Slice: A message posted to Resolve is stored and answered 202; its run executes in the background; the thread then reads back with Resolve's reply.
Test seam: Resolve's app factory listening on `127.0.0.1` port 0, with PGlite, a scripted model and an injected mode runner
Acceptance:
- [x] `POST /messages` validates per requirements.md (channel, senders, subject, body, up to 3 JPEG/PNG/WebP photos of 2 MB checked by their first bytes, mode, thread match, no unknown keys) and answers 400 with one sentence and stores nothing on any failure
- [x] On success it stores attachments, ticket (`simulated: true`) and a `queued` run, and answers 202 with the ticket, thread and run IDs
- [x] Runs execute one at a time in the order queued; `GET /threads` and `GET /threads/:id` return threads, messages, runs, replies and traces; `GET /attachments/:id` returns the bytes with their content type
- [x] `server.ts` wires the database, model, gate URL, key and PayPal config from the environment, binds `0.0.0.0` and `PORT` (default 8788), and still answers `/health` with none of them set
Notes:

## T-010: Daily cap, interrupted runs and the fallback rerun

Status: done
Blocked by: T-009
Tier: simple
Slice: A runaway or broken day can't spend unbounded AI calls or rerun a run that may have moved money, and a quota failure falls back to the second model once.
Test seam: Resolve's app factory and run queue, with PGlite, a scripted model and an injected clock
Acceptance:
- [x] Past `RESOLVE_DAILY_RUN_CAP` (default 200, positive integer, counted per UTC date), a message is stored and its run is `not_run` `daily_cap` with no model call; a bad cap value is refused at startup, naming the variable
- [x] At startup, `queued` and `running` runs become `failed` `interrupted`, and none is rerun
- [x] A `model_unavailable` run with no tool call is followed by one new run on `GEMINI_FALLBACK_MODEL` (when set and different); a run with any tool call isn't rerun
- [x] With no `GEMINI_API_KEY`, runs end `not_run` `not_configured`
Notes:

## T-011: The resolve CLI and scenario files

Status: done
Blocked by: T-006
Tier: standard
Slice: `npm run resolve -- <message file>` stores a scenario's simulated messages, runs each through Resolve in-process, and prints every tool call, the gate's decisions and the reply.
Test seam: the CLI's exported run function with a scripted model, a listening gate and a PGlite directory, plus one child-process run of the real entry point
Acceptance:
- [x] Message files are read with zod (channel, sender as `buyer:A`, `buyer:B`, `payer:<order number>` or an email, subject, body, attachment paths, `follow_up_of`); senders resolve from `seed_orders`
- [x] `beat-3-attack-email.json`, `beat-4-stalled-parcel.json` and `beat-5-damaged.json` (with a small illustrative photo) exist, each saying its people are illustrative and its messages simulated
- [x] Output shows mode, model, one line per tool call with decision words and reason codes, the outcome and the reply; `--json` prints the runs; `--mode baseline` uses baseline mode
- [x] Exit 0 when every run replied, 1 when one stopped or failed, 2 when it can't run; missing variables are named, never shown; the root `package.json` has the `resolve` script
Notes:

## T-012: The console inbox

Status: done
Blocked by: T-009
Tier: standard
Slice: The merchant opens `/inbox`, picks a thread, and reads the customer's messages, Resolve's reply and "What Resolve did", with the gate's decision and reasons as words beside their codes.
Test seam: the inbox view-model functions and the console's Resolve route handlers in `apps/console/src/`, with an injected `fetch`, plus the Graphite design check
Acceptance:
- [x] The console gains a sidebar nav (Inbox, theme control) and `@countersign/mandate` in `transpilePackages`; the inbox lists threads with channel icon, sender, subject or first line, time and status badge
- [x] The thread view shows messages, photos, replies and, per run, mode, model version, duration and one row per tool call; guarded calls show the decision and every reason as words with its code in inline code; an allowed refund shows its refund ID; baseline money calls are marked "No checks: straight to PayPal"; non-replied outcomes are one plain sentence each
- [x] While a run is queued or running the thread shows a working state and polls every 2 s until it ends
- [x] The routes validate input and Resolve's answers with zod and answer 502 with "Resolve isn't reachable. Start it, then try again." when Resolve is down or answers junk
- [x] Every new file passes the design check (semantic tokens only, Lucide icons, no emojis), and the view works in light and dark
Notes:
- Resolve's `GET /threads/:id` now adds `executions` to each run (the latest `execution.result` per allowed intent, read from the audit log), so the inbox can show an allowed refund's PayPal refund ID. The inbox renders on the server and polls with `router.refresh()`.

## T-013: Simulate a message, and the mode switch

Status: open
Blocked by: T-012
Tier: standard
Slice: From the inbox header the merchant (or a judge) switches between Protected and Baseline and sends a simulated email or chat message with a photo; the new thread opens and Resolve's run appears in it.
Test seam: the composer's form-to-request function and the messages route handler in `apps/console/src/`, with an injected `fetch`, plus the design check
Acceptance:
- [ ] A Protected | Baseline segmented control, default Protected, sets the next message's mode; Baseline shows requirements.md's one-line explanation
- [ ] The dialog takes channel, sender email (and phone for chat), subject for email, body and up to 3 photos, checks type and 2 MB in the browser, and says "Simulated: no email is sent or received."
- [ ] Sending posts through `POST /api/resolve/messages` as base64 and selects the new thread; a 400 from Resolve shows its sentence in the dialog
- [ ] The design check passes, and the dialog works in light and dark and at phone width
Notes:

## T-014: The customer's simulated chat

Status: open
Blocked by: T-012
Tier: standard
Slice: A customer opens `/chat` on a phone, gives an email address, sends a message with a photo, and sees Resolve's reply arrive in the same thread.
Test seam: the chat view-model functions in `apps/console/src/` and the existing Resolve routes, with an injected `fetch`, plus the design check
Acceptance:
- [ ] The page is laid out for a phone and says "Simulated chat. Kikapu Studio is an illustrative shop."
- [ ] The first message starts a chat thread; later ones are sent as follow-ups in it; replies appear in order, with a working state while a run is in progress
- [ ] It shows messages and replies only, never the trace, tool calls or decisions; a stopped or failed run shows "Resolve couldn't answer this one. The shop will reply soon."
- [ ] The design check passes, with hit targets of at least 24px and a 40px send button, in light and dark
Notes:

## T-015: Live checks for Gemini and PayPal's server

Status: open
Blocked by: T-008
Tier: simple
Slice: Under `LIVE=1`, the real model accepts both modes' tool lists in `VALIDATED` mode and runs one short ticket to a reply, and PayPal's server starts with a fresh token and lists its tools.
Test seam: `apps/resolve-agent/test/live.test.ts` (runs only with `LIVE=1` and the variables it needs set)
Acceptance:
- [ ] With `GEMINI_API_KEY`: one request with the gate's fixture tool list plus `find_order` answers 200 and passes the response check; a short ticket against an in-process stand-in MCP server runs the real loop to a reply, recording `modelVersion`
- [ ] With the PayPal variables too: `@paypal/mcp` spawns with a fresh token and lists its tools, and one `VALIDATED` request with them plus `find_order` answers 200; no PayPal tool is called
- [ ] Without `LIVE=1` every check is skipped and `npm test` stays green with no credentials
Notes:

## T-016: README and glossary

Status: open
Blocked by: T-011, T-013
Tier: simple
Slice: A developer reading the README can start Resolve, the gate and the console, send a simulated message in each mode, and knows what's simulated and what moves sandbox money.
Test seam: the README and `CONTEXT.md`, plus the existing suite staying green
Acceptance:
- [ ] A README section covers starting the three services, `/inbox` and `/chat`, the mode switch, `npm run resolve` on the scenario files, the env variables by name only, that every message is simulated and every person illustrative, and that baseline mode moves real sandbox money with no checks
- [ ] It names the Gemini model variable, the daily run cap and the AI roles in this phase (Resolve's agent only), and the project status section lists phase 8
- [ ] `CONTEXT.md` terms used match the glossary (thread, agent run, run outcome, baseline mode, protected mode)
Notes:
