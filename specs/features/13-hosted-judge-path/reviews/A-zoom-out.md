# Round A: Zoom Out review of `design.md`

Reviewer: Skeptical Architect (Zoom Out Goldfish), Mode: REVIEW, against `.ralph/egm/standards/zoom-out-standard.md`.
Read: `design.md` (whole), its links (`requirements.md`, `validation.md`, ADRs 0041 to 0043, `CONTEXT.md`, the Render Blueprint spec), brief §8 and §10. Code searched to check what can be reused.

Prerequisite (context sufficiency): **passes.** The Overview and The Problem say what the phase delivers (a judge path on the hosted URL with no terminal, a reset, and bounded AI cost) and why (brief §3, §5 items 8 and 18, §8, gate G2). Root problem focus: **passes.** The design fixes the causes: there's no hosting config, no reset, and the routes that spend money are open. It doesn't patch symptoms.

Totals: 0 blockers, 3 majors, 6 nits.

---

## Z-1. The `npm run reset` CLI is unused in the hosted flow, and it bypasses the in-flight guard

*   **Severity**: Major
*   **Affected Scope**: Technical Plan, "The reset (ADR 0042)" ("and `npm run reset`"); Detailed Implementation Plan item 11 (`reset-cli.ts`, `reset-main.ts`, root script, `durationWords` in `apps/gate/src/words.ts`, `test/reset-cli.test.ts`); Goal G-4; validation check 5 (CLI cases).
*   **Discrepancy & Rationale**: Nobody in this phase needs the CLI. Judges reset from the start page. The owner's first hosted seed is also "sign in on the console and press Reset once" (item 24, `docs/hosting.md`), and the original brief §15 says to rehearse "with the demo reset button". So a CLI entry point, its own output format, a gate-side duration formatter and a child-process test are all YAGNI. The CLI is also less safe than the route. Item 11 runs it with `inFlight: () => 0` because "a CLI process has no executions", but the gate's executions happen in a different process. The module-level `running` flag doesn't cover it either. Run the CLI against any database a gate server also uses, such as local dev or the gate's Render Shell (ADR 0041 names the Render Shell as the place for hosted checks), and it skips the "never while an execution is mid-flight" refusal and the one-at-a-time rule. G-4 promises the opposite. Recommendation: drop the CLI. If an operator path is really wanted, make it a thin client that POSTs to the running gate's `/demo/reset`, so every guard lives in one process.

## Z-2. `durationWords` is written twice, but the console already has the same formatter

*   **Severity**: Major
*   **Affected Scope**: Detailed Implementation Plan item 11 (`durationWords(ms)` in `apps/gate/src/words.ts`) and item 20 (`durationWords(ms)` in `apps/console/src/start-view.ts`).
*   **Discrepancy & Rationale**: `apps/console/src/inbox-view.ts:146` already exports `formatDuration`. It implements the same brand-book rule ("12s", "1m 08s", seconds padded to two digits) and is tested in `apps/console/test/inbox-view.test.ts`. The plan says "names below are binding", so as written it creates two more copies of that rule, three in all, for judge-facing copy that has to stay identical. Recommendation: pull the milliseconds-to-words core out of `formatDuration` and have `start-view.ts` reuse it. If Z-1 is accepted, the gate copy goes away. If it isn't, the gate copy should still be the one shared helper, not a new spelling of it.

## Z-3. Code-level detail is duplicated across three documents, and they have already drifted

*   **Severity**: Major
*   **Affected Scope**: Technical Plan (the reset flow block); Detailed Implementation Plan items 1, 4, 8, 9, 19, 21 ("names below are binding").
*   **Discrepancy & Rationale**: The design document carries text that belongs in code. Examples: the raw `INSERT … SELECT … UNION ALL … ON CONFLICT` and `LOCK TABLE` statements (item 4), the literal `withAuditLog` lambda body (item 9 step 4), zod declarations (items 9 and 19), `package.json` fields (item 1), `let inFlight = 0` (item 8), and Tailwind class strings for every element of the start page (item 21). Much of it is repeated in `requirements.md` and ADR 0042; the lock statement, for one, appears in all three. Nothing says whether design or requirements wins on these specifics, so there are three sources of truth. They already disagree. CUJ 2's sentence "Reset in 14s. Replaced 4 orders and kept 26." leaves out "Recorded 1 dispute again." even though the same CUJ says the open dispute is recorded again, and `requirements.md` includes the dispute clause whenever one is recorded. Recommendation: keep the design at modules, interfaces (route contracts, `resetDemo`'s inputs and result, `syncDisputes`'s result), data flow and ordering guarantees. Point to `requirements.md` for copy and status codes. Leave SQL text, lambda bodies and class strings to the code and its tests.

## Z-4. The blueprint test restates the whole file instead of checking invariants

*   **Severity**: Nit
*   **Affected Scope**: Goal G-1; Detailed Implementation Plan items 22 and 23; validation check 11.
*   **Discrepancy & Rationale**: Item 23 checks `render.yaml` against "a fixed expected table in the test (the file above)", meaning every command, plan, health check and variable key. That makes it a change-detector: every blueprint edit has to be made twice, and G-1's measure ("the test passes") largely confirms that the copy matches itself. The invariant checks in the same item are the valuable part and should stay: references resolve, every used `*_HOSTPORT` is declared, no `free` plan, `NODE_VERSION`, where secrets live, and no value that looks like a secret. Add the one invariant that Alternative E's rejection depends on: each start-command prefix sets exactly the URL variable the code reads (`GATE_URL`, `GATE_MCP_URL`, `RESOLVE_AGENT_URL`). Right now only the verbatim `startCommand` pin covers that.

## Z-5. `withSignIn` is added as "one helper", but the dispute routes keep their own copy

*   **Severity**: Nit
*   **Affected Scope**: Detailed Implementation Plan items 16 and 17.
*   **Discrepancy & Rationale**: ADR 0038 says to put the check-the-key-with-the-gate pattern in one helper, and item 16 adds `withSignIn` for that. But `apps/console/src/dispute-routes.ts:39` and `:53` (`loadDisputes`, `draftAgain`) keep calling `checkKey` inline, and item 17 converts only the Resolve routes. Moving the dispute routes onto `withSignIn` in the same item would leave one pattern, not two.

## Z-6. `RESOLVE_BASELINE=off` has no consumer

*   **Severity**: Nit
*   **Affected Scope**: Technical Plan, "The launcher and sign-in"; Detailed Implementation Plan item 14 (`BaselinePolicy`, `BASELINE_REFUSALS.off`); ADR 0043.
*   **Discrepancy & Rationale**: Local runs use `on` (the default) and the blueprint uses `scenarios`. Nothing in this phase or in the named later phases sets `off`, yet it brings a policy value, a refusal sentence, the rule that other values mean `off`, and its tests. Two values are enough: unrestricted, and scenarios only. An unreadable value can fall back to scenarios only, which still keeps visitor text out of the toolkit. Add `off` when something needs it.

## Z-7. The scenario list is kept in three places, plus a test-only dependency from console to Resolve

*   **Severity**: Nit
*   **Affected Scope**: Detailed Implementation Plan items 15 (`LAUNCHER_SCENARIOS`), 19 (`ScenarioRequestSchema`'s `scenario_id` enum) and 20 (`SCENARIO_CARDS`, plus the cross-check test and the new `@countersign/resolve-agent` devDependency on the console).
*   **Discrepancy & Rationale**: Resolve already decides which IDs exist and which modes each allows (404 for an unknown ID, 400 for a disallowed mode, item 15). The console's zod enum is a third copy of the IDs, and it's the reason for the cross-workspace check. Recommendation: have the console route accept any slug-shaped `scenario_id` and pass Resolve's answer through. Then Resolve is the only authority, and the console keeps only the card copy.

## Z-8. Alternative F misses the reference mechanism the blueprint already uses

*   **Severity**: Nit
*   **Affected Scope**: Alternatives Considered, Alternative F; item 22 (`PAYPAL_CLIENT_ID` and `PAYPAL_CLIENT_SECRET` set `sync: false` on four services).
*   **Discrepancy & Rationale**: Alternative F weighs only environment groups. The blueprint already shares the support key with `fromService … envVarKey`, and the Render spec ("Referencing service properties": "In addition to referencing other environment variables…") states no exclusion for `sync: false` variables. Declaring the two PayPal values `sync: false` once, on the gate, and referencing them from Resolve, the storefront and the cron job would mean the owner types each value once instead of four times. It would also remove a mismatched-credential failure on the judge path (brief §10 trade-off 3). Confirm on Render during the owner's first deploy, and keep the current layout if Render refuses.

## Z-9. The architecture diagram leaves out the private-network edges the blueprint wires

*   **Severity**: Nit
*   **Affected Scope**: Technical Plan, the diagram; the Overview and Proposal ("four services" against item 23's "five services").
*   **Discrepancy & Rationale**: The diagram shows console → gate and console → Resolve. It leaves out Resolve → gate `/mcp` (`GATE_MCP_URL`, the core protected-mode flow), gate → Resolve (the dispute nudge, `RESOLVE_AGENT_URL` on the gate) and each service → `countersign-db`. Those edges are why the `*_HOSTPORT` variables exist, and they're what live check 9 tests, so a hosting design should show them. The service count also differs between "four services … and the database" and "the five services" in item 23, which counts the cron job. Use one count.
