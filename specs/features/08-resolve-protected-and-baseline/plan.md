# Phase 8 plan: Resolve, protected and baseline

Roadmap item 8, brief §5 item 6. A customer writes to Kikapu Studio by simulated email or simulated chat. Resolve's Gemini agent investigates, replies, and proposes money actions only through the gate. A switch runs the same agent in baseline mode, wired straight to PayPal's own MCP server. The merchant's inbox in the console shows each thread, Resolve's reply and every step the agent took, with the gate's decision and reasons on each guarded call.

## Approach

```text
console (Next.js)                         resolve-agent (Express 5, port 8788)
  /inbox  thread list, thread detail,       POST /messages ─▶ attachments ─▶ ticket (ADR 0029)
          mode switch, "simulate a            │                              ─▶ agent run (queued)
          message"                            ▼
  /chat   customer's simulated chat       run queue, one at a time
     │                                        │
     └─ server routes ─ RESOLVE_AGENT_URL ─▶  harness (ADR 0014 loop, ADR 0031)
        (zod on every answer)                   system instruction, config, sanitizer, find_order
                                                │
                     protected ─────────────────┼──────────── baseline
                     MCP over HTTP              │             MCP over stdio
                     bearer principal key       │             @paypal/mcp --tools=all,
                     ▼                          │             fresh sandbox token per run
                     gate /mcp (phase 7)        │             ▼
                     decides, records,          │             PayPal sandbox, no checks
                     refunds once               │
                                                ▼
                                   run: reply, outcome, trace ─▶ agent_runs
```

Decisions behind it: ADR 0030 (intake, threads, attachments, runs, simulated channels, the console's route to Resolve) and ADR 0031 (what the two modes share, `find_order`, baseline's token and child process, run limits and retries). Earlier ADRs still hold: 0011 and 0014 (one harness, our own loop), 0013, 0015 and 0017 (Gemini call shape, fail-closed check, model from env), 0018 (reason codes as words with the code beside them), 0028 and 0029 (the gate's MCP surface and ticket store).

## Modules touched

| Module | What it gains |
|---|---|
| `packages/db` | `tickets.thread_id`; the `ticket_attachments` and `agent_runs` tables and their migration; writers and readers for attachments, threads and runs |
| `packages/rail-paypal` | `issueAccessToken()`, a fresh sandbox token for baseline mode's child process |
| `apps/resolve-agent` | Env parsing; the Gemini call and response check; the schema sanitizer; the harness loop with `find_order`; protected and baseline connections; the run queue; the HTTP API; the `resolve` CLI and scenario message files; live checks |
| `apps/gate` | A recorded fixture of its own `tools/list`, kept in step by a gate test, so Resolve's sanitizer test reads it |
| `apps/console` | Sidebar nav; the inbox (`/inbox`); the simulated chat (`/chat`); server routes to Resolve |
| root | A `resolve` script. README section |

`packages/mandate`, `packages/verifiers`, `packages/ledger` and `packages/carrier-mock` stay untouched. The gate's behaviour doesn't change.

## Order of work

1. In any order, since they share nothing: the db tables (T-001, then T-002), the model call (T-003), the sanitizer with the gate's tool fixture (T-004), the access token (T-007).
2. The harness loop (T-005), after T-003 and T-004.
3. Protected mode end to end (T-006), after T-001, T-002 and T-005. Baseline mode (T-008), after T-005 and T-007.
4. The HTTP API and run queue (T-009), after T-006. The daily cap, interrupted runs and the fallback rerun (T-010), after T-009. The CLI (T-011), after T-006.
5. The console: inbox (T-012) after T-009, then the composer (T-013) and the chat page (T-014).
6. Live checks (T-015) any time after T-008. README and glossary (T-016) last.

## New dependencies

No new npm packages. Workspace links and reused pins, installed by the planner on 18 Oct:

- `@countersign/resolve-agent` depends on `@countersign/db`, `@countersign/mandate` and `@countersign/rail-paypal`, and on `express` 5.3.0, the gate's existing pin (ADR 0002), so the workspace keeps one copy. Dev: `@types/express` 5.0.6 (the gate's pin) and `@countersign/gate`, for end-to-end tests against a real gate only. Nothing outside `test/` imports the gate.
- `@countersign/console` depends on `@countersign/mandate`, for the reason-code catalog's words. Add it to `transpilePackages`.

`@google/genai` 2.27.0 and `@modelcontextprotocol/sdk` 1.32.1 are already Resolve dependencies. `@paypal/mcp` 1.8.1 stays in `apps/baseline-paypal-mcp`, and nothing imports it.

## Notes for the loop

- The loop can't reach Gemini, PayPal or read `.env.*`. Every test injects the model call (a scripted fake returning recorded response shapes), uses PGlite, and passes env explicitly. Never read `process.env` in tests.
- Fake model responses follow `@google/genai` 2.27.0's `GenerateContentResponse`: `candidates[0].content.parts` with `functionCall { id, name, args }` or `text`, `finishReason`, `modelVersion`, `usageMetadata`. Include a `thoughtSignature` on the first function-call part so the history test can check it's kept.
- Protected-mode end-to-end tests run the real gate (`createApp` from `@countersign/gate`, its fake sandbox and the carrier mock) on `127.0.0.1` port 0, sharing one PGlite handle with Resolve, as the gate's agent CLI tests do. Close servers with `closeAllConnections()` before `close()`. Use `trackedTempDirs()`-style cleanup for every temp folder.
- Harness-level tests that don't need the gate use the MCP SDK's `InMemoryTransport` with a small in-process `Server`.
- Baseline tests inject the transport factory and the token issuer. Only `LIVE=1` tests spawn `@paypal/mcp`.
- UI tests follow the storefront's pattern: test the view-model and route-handler functions in `apps/console/src/`, plus the Graphite design check. Read `Graphite Design/DESIGN.md`, the component READMEs you use, and `brand-book.md` before any screen.
- Scenario message files in `apps/resolve-agent/scenarios/` mirror the gate's beat 3, 4 and 5 proposal files, with the same orders and senders. Beat 5's photo is a small illustrative image committed under `apps/resolve-agent/scenarios/`.

## Risks

- **Model behaviour can't be unit-tested.** Tests prove the loop, limits and fail-closed paths with scripted responses; whether Flash-Lite investigates well is measured by the live check and the bench (phase 14), never asserted in `npm test`.
- **Free-tier limits.** Calls take 12 to 22 seconds and daily quota is small. The run queue keeps one run at a time, the inbox shows a working state, and the daily cap stops a runaway loop. Gemini tier for the bench is still the owner's call (`.ralph/human.md`).
- **Baseline mode moves real sandbox money** on seeded captures, which can spoil later protected demos on the same orders. The README says so; phase 13's reset re-seeds.
- **The toolkit's known vulnerabilities** (spike S4) run only in baseline's child process. Phase 13 decides whether baseline is on the hosted URL.
- **No principal key or seeded orders in the cloud yet.** Protected mode's live run waits for `COUNTERSIGN_SUPPORT_AGENT_KEY` and the seed buyers (`.ralph/human.md`). The Gemini key is set, so the model-only live check can run.
- **Thought signatures across turns of a thread.** Each run starts a fresh history and renders earlier replies as text, so no signature is replayed across runs or models.
