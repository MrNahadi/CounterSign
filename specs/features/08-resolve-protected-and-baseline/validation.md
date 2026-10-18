# Phase 8 validation: Resolve, protected and baseline

## Automated checks

All run from the repo root and are part of the Feedback commands, except the live checks.

1. `npm run typecheck`, `npm run lint`, `npm test` and `npm run build` pass.
2. **Store:** over PGlite, a migration from a phase 7 database adds `tickets.thread_id` (old rows take their own ID), `ticket_attachments` and `agent_runs`; an attachment and a two-message thread write and read back; attachments and tickets stay write-once; a run moves through its statuses and reads back with its trace. The gate's propose and agent CLI tests pass unchanged.
3. **Response check:** a block reason, no candidate, every non-`STOP` finish reason (including an unknown string and a missing one) and empty parts each end the run `model_stopped:<reason>`, and no function call in that response reaches the MCP client.
4. **Request shape:** every model call in a run sends the same config (system instruction, declarations sorted by name, `VALIDATED`, `MEDIUM`, five safety categories `OFF`, `maxOutputTokens` 8192) and none of `temperature`, `topP`, `topK` or `thinkingBudget`; the client is built with `vertexai: false` and the retry options; the second call's history holds the first response's content unchanged, thought signature included.
5. **Sanitizer:** each ADR 0014 rewrite has a case; it changes nothing in `apps/gate/test/fixtures/tools-list.json`; the gate's own test proves that fixture equals its live `tools/list`.
6. **Loop:** calls run in order and come back as one turn of matching function responses; `isError` results reach the model as `error`; an undeclared tool name, a transport failure, the 8-call and 12-tool caps and an empty reply each end the run with the right outcome and no further tool call; `find_order` answers seeded orders and "No order with that number." and never returns a payer email.
7. **Same agent:** a protected and a baseline run of the same ticket send byte-identical system instructions, configs (declarations aside) and user turns, and both declare `find_order`.
8. **Protected end to end:** with the real gate on `127.0.0.1` and its fake sandbox, a scripted run of beat 4 gets `allowed` and exactly one refund, with a decision entry naming the ticket; a scripted beat 3 run's five `create_refund` calls get 4 denials and 1 step-up as phase 7's file expects; no principal key, a wrong key and no gate each end `gate_unavailable` before any model call; `ledger verify` passes afterwards.
9. **Baseline wiring:** with an injected transport factory and token issuer, the child is started with `process.execPath`, PayPal's entry point and `--tools=all`, its environment holds only the default variables plus `PAYPAL_ACCESS_TOKEN` and `PAYPAL_ENVIRONMENT=SANDBOX`, it's closed after a replied, a stopped and a failed run, and nothing is appended to the audit log. A failed token or spawn ends `baseline_unavailable` before any model call.
10. **API:** over a real listening server, `POST /messages` stores attachments, ticket and run and answers 202; bad channels, missing senders, an over-long body, a fourth photo, a 3 MB photo, a PNG labelled JPEG, an unknown key and a mismatched thread each answer 400 and store nothing; `GET /threads` and `GET /threads/:id` return the stored threads, runs and replies; runs execute one at a time in order.
11. **Run limits:** past `RESOLVE_DAILY_RUN_CAP`, a message is stored and its run is `not_run` `daily_cap` with no model call; at startup, `queued` and `running` runs become `failed` `interrupted` and aren't rerun; a `model_unavailable` run with no tool call is rerun once on the fallback model, and one with a tool call isn't.
12. **CLI:** `runResolve` on the three scenario files with a scripted model and a listening gate prints each tool call and decision and exits 0; a stopped run exits 1; a missing `GEMINI_API_KEY` or principal key is named, never shown, and exits 2. One child-process run of the entry point.
13. **Console:** the inbox and chat view models turn recorded thread answers into rows with words and codes for every reason; the routes refuse bad input, pass Resolve's answers through zod, and answer 502 with the fixed sentence when Resolve is down or answers junk; the design check passes on every new file.
14. **No secrets:** across the trace, run rows, API answers, CLI output and console route answers in these tests, no fake API key, principal key or access token appears.
15. The no-AI test still passes.

## Live checks (`LIVE=1`, not in the Feedback commands)

1. `LIVE=1 npm test -- apps/resolve-agent`, with `GEMINI_API_KEY` set:
   - one request with the gate's full tool list plus `find_order` in `VALIDATED` mode answers 200 and passes the response check;
   - a short ticket against an in-process stand-in MCP server runs the real loop to a reply, recording `modelVersion` and token counts;
   - with the PayPal variables also set: `@paypal/mcp` spawns with a fresh token, lists its tools (28 in spike S4), and one `VALIDATED` request with PayPal's tools plus `find_order` answers 200. No PayPal tool is called.
2. Once `COUNTERSIGN_SUPPORT_AGENT_KEY` is set and the seed has run: start the gate, then `npm run resolve -- apps/resolve-agent/scenarios/beat-4-stalled-parcel.json`. Resolve should find KIK-1035, the gate should allow the refund, and the reply should say the refund is done. Then beats 3 and 5, then `npm run ledger -- verify`.
3. Baseline, once the seed has run: `npm run resolve -- apps/resolve-agent/scenarios/beat-3-attack-email.json --mode baseline`, and note whether the agent refunds anything (beat 1 to 2's cold open). It moves real sandbox money on seeded captures; re-seed afterwards.

## Manual checks for the human

1. Start the gate, resolve-agent and the console (`npm run dev` in each workspace), open `/inbox`, simulate beat 4's email as the payer of KIK-1035, and watch Resolve reply with the refund ID. Check the "What Resolve did" rows read clearly to a stranger, with reason words and codes side by side (G8's spirit).
2. Switch to Baseline and send beat 3's email. Compare the two threads: can someone new tell which agent moved money, and why the protected one didn't?
3. Open `/chat` on a phone (or at phone width), send a message with a photo, and check the layout, the simulated notice and the working state, in light and dark.
4. Read the system instruction, every outcome sentence and the simulated notices against the brand book.
5. Record the project's real free-tier limits from the AI Studio rate-limit page (still open from spike S8), and note how many runs a day they allow.
