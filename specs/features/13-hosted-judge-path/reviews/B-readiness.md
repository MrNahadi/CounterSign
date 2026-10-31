# Review B: implementation readiness

*   **Target:** `specs/features/13-hosted-judge-path/design.md`, `## Detailed Implementation Plan` (line 280) to the end, with the feature range above it for context.
*   **Mode:** REVIEW. Personas: Implementation Readiness (can I code this without making design choices?) and Codebase Details (does everything the plan names exist, or is it marked new?).
*   **Read:** `requirements.md`, the code paths the plan names (`apps/gate`, `apps/resolve-agent`, `apps/console`, `packages/db`, `packages/ledger`, `packages/rail-paypal`, `apps/storefront/src/seed-run.ts`), `packages/ledger/test/chain.test.ts`, and the existing package manifests.

Symbols checked and found as the plan says: `withAuditLog`, `AuditLogWriter`, `appendPrepared`, `readExecutionHistory`, `executionRequestedEntry`, `executionResultEntry`, `parsePayPalEnv`, `NudgeFetch`, `approverOnly`, `EXIT_NEGATIVE`, `runSeed`, `SeedReport`, `SEED_CONCURRENCY`, `callGate` (takes `timeoutMs` through `deps`), `refusalOf`, `checkKey`, `withKey`, `callResolve`, `CONTROL_CLASSES`, `approvalsUrl`, `requestOrigin`, `qrView`, `formatDuration`, `POLL_INTERVAL_MS`, `countRunsOnDate`, `countDraftsOnDate`, `paypalTokenIssuer`, and the three scenario files. `StoredRowSchema` is real but not exported, and the plan says to export it. `readLimited` is real but private in both `approval-routes.ts` and `resolve-routes.ts`, and the plan says to export it. `render.yaml`, `docs/hosting.md`, `docs/judge-guide.md` and `packages/seed/` are absent, as the plan expects. No table has a foreign key, so the six-table `TRUNCATE` is valid.

--------------------------------------------------------------------------------

## Findings

### 1. Pairing routes collide with the approvals routes

*   **Severity:** Blocker
*   **Affected Scope:** Item 12b (`apps/gate/src/pairing.ts`, `app.ts`); `apps/gate/src/approvals-api.ts:136,150`.
*   **Discrepancy & Rationale:** `mountApprovals` registers `GET /approvals/:id` and `POST /approvals/:id`, both behind `authenticate` (`approverOnly`). Item 12b adds `POST /approvals/pairing-codes` and the keyless `POST /approvals/pair`, and says only "`app.ts` (Modify)". It gives no mount order. Express matches in registration order. If the implementer follows the pattern of item 10 and mounts "after `mountAudit`", `POST /approvals/pair` matches `/approvals/:id`, `authenticate` answers 401 because the phone has no key, and the pairing never works. `POST /approvals/pairing-codes` reaches the `:id` handler, which answers 404 `notFound`. The per-module `test/pairing.test.ts` mounts `mountPairing` alone, so it passes while the real app is broken. The QR sign-in (G-2, CUJ 1, check 12) fails.
*   **Needed:** State that `mountPairing` goes before `mountApprovals` in `createApp`. Add an `app.ts`-level test, through `createApp`, that `POST /approvals/pair` with no key answers 200 for a valid code.

### 2. The start page sends the pairing-code request as a GET

*   **Severity:** Major
*   **Affected Scope:** Item 21 (`app/page.tsx`); `callGate` in `apps/console/src/approval-routes.ts:125`.
*   **Discrepancy & Rationale:** Item 21 says `callGate(deps, key, "/approvals/pairing-codes")` "answers 201". `callGate` sends GET unless it is given a `post` argument. The gate route is POST. The call returns 404, and the page then silently falls back to the plain URL. No test fails, and the phone is never signed in by the QR.
*   **Needed:** Write the call as `callGate(deps, key, "/approvals/pairing-codes", { json: "{}" })` and say the page must treat a 201 as the only success.

### 3. `RAIL_WORST_CALL_MS` is undefined, and the assertion can't hold with the stated constants

*   **Severity:** Major
*   **Affected Scope:** Item 8 (`packages/rail-paypal/src/client.ts`); item 9 (`EXECUTION_WINDOW_MS = 600_000`); design line 139; `validation.md:17`.
*   **Discrepancy & Rationale:**
    *   The plan says a timeout is "handled as the network failure it already handles (retried as today…)". Today `reach` converts a fetch failure into a `PayPalError` of kind `network`, and `send` never retries it. Only 429 and 5xx are retried, up to `MAX_RETRIES = 2`.
    *   The plan says "export `RAIL_WORST_CALL_MS`, the worst case of one call with its retries and waits" and asserts `EXECUTION_WINDOW_MS > 4 × RAIL_WORST_CALL_MS`, but gives no formula. A real worst case is 3 attempts plus 1 re-authorisation (4 × 30 s), plus two waits of up to 10 s, plus up to 2 token fetches at 30 s. That is about 200 s, and 4 × 200 s = 800 s, which exceeds the 600 s window. The "4" has no stated source (calls per execution).
    *   The table's claim "no execution can outlast that window" therefore isn't established.
    *   `FetchLike`'s `init` type has no `signal`, so the type, and every test fake that builds a `FetchLike`, must change. The plan doesn't list this.
    *   `read()` (body reading) sits outside `reach`'s try. A timeout while reading the body surfaces as a raw `DOMException`, not a `network` `PayPalError`. The executors map that to `unknown` as well, so it's safe, but the plan says it "is handled as the network failure".
*   **Needed:** Give the `RAIL_WORST_CALL_MS` formula in terms of `RAIL_REQUEST_TIMEOUT_MS`, `MAX_RETRIES`, `MAX_RETRY_WAIT_MS` and the token fetches. Name the source of the "4" (the most rail calls one execution makes). Pick `EXECUTION_WINDOW_MS` so the check holds, or change the check. Add `signal?: AbortSignal` to `FetchLike`. Decide whether network failures are retried, and correct the "retried as today" wording.

### 4. How a supplied baseline token reaches the queue is unspecified

*   **Severity:** Major
*   **Affected Scope:** Item 14 (`queue.ts`, `app.ts`); item 15 (`accept(..., token)`); `apps/resolve-agent/src/queue.ts:25`.
*   **Discrepancy & Rationale:** `RunQueue` is `{ enqueue(runId: string); idle() }`. `createApp` only sees `deps.queue`. The plan says `accept` "passes it to the queue with the new run" and that `queue.ts` holds the tokens in a `Map` keyed by run ID. It gives no signature: `enqueue(runId, token?)`, a separate `hold(runId, token)`, or something else. It doesn't say where the map lives (inside `createRunQueue` or `createModeRunner`), and the two are separate factories. It doesn't say how `createModeRunner` uses the token (an `issueToken` override for that run's `runBaseline` call, presumably). Existing tests that construct `RunQueue` fakes are affected by a type change. These are interface choices the standard says must be pre-made.
*   **Needed:** Give the `RunQueue` signature change, the owner of the map, and the exact override in `createModeRunner`. Include deletion in every exit path: the early returns for a non-`queued` run, a thrown error, and the capped path where `accept` never enqueues.

### 5. A baseline run that falls back to a rerun loses its token

*   **Severity:** Major
*   **Affected Scope:** Item 14 (`queue.ts`); `createModeRunner` lines 137-159 (the `model_unavailable` rerun).
*   **Discrepancy & Rationale:** After a baseline run ends `model_unavailable` before any tool ran, `createModeRunner` creates a new run with a new ID (`rerunId`) in the same mode and queues it. The plan deletes the token "when the run ends however it ends". The rerun has no token, so on Render (where the issuer always throws) it fails `baseline_unavailable` before any model call. The plan doesn't say whether to carry the token to the rerun, skip the rerun for supplied-token runs, or accept the failure. The first choice puts the token in memory longer, and the owner should decide.
*   **Needed:** State the behaviour, and add a test.

### 6. Resolve has no way to know that it "has no PayPal variables"

*   **Severity:** Major
*   **Affected Scope:** Item 15 (`app.ts`, `POST /scenarios/:id`: "`baseline` with no `paypal_token` when Resolve has no PayPal variables → 400 `noToken`").
*   **Discrepancy & Rationale:** `AppDeps` (`apps/resolve-agent/src/app.ts:33`) holds `db`, `model`, `queue`, `dailyCap`, `clock` and `log`. Item 14 adds only `baseline`. `createApp` never sees the environment, and the `issueToken` that decides this sits in `serve.ts`. The plan doesn't add a dep (for example `canIssueToken: boolean`) or say where it is set (`parsePayPalEnv(env).ok` in `serve.ts`).
*   **Needed:** Add the `AppDeps` field and its source. Add a test for each value.

### 7. A dispute-sync throw after the clear loses the report

*   **Severity:** Major
*   **Affected Scope:** Item 9 step 8 (`syncDisputes`), item 7 (`dispute-sync.ts`), item 10 (the handler).
*   **Discrepancy & Rationale:** In the CLI, `runDisputes` wraps `sync` in a try/catch that turns a database error into `cantRun`. Item 7 moves the body of `sync()` into `syncDisputes` and keeps the `ok: false` shape for only three named cases. `readDisputeState` and `withAuditLog` still throw on a database error. Step 8 runs after the commit, where nothing can be undone. A throw there leaves the log cleared. Nothing in item 9 or item 10 catches it, so the handler answers a generic 500, and the judge gets neither the report nor `complete: false`. Express 5 handles the rejection, but the body isn't the plan's schema.
*   **Needed:** Say that step 8 catches any throw from `syncDisputes` and reports `disputes: { error: <fixed sentence> }`. Add a test with a failing `syncDisputes`.

### 8. The gate's `package.json` doesn't gain `@countersign/seed`

*   **Severity:** Major
*   **Affected Scope:** Item 1, item 2 (lists the storefront's `package.json` only), item 9 (`apps/gate/src/demo-reset.ts` imports `@countersign/seed`).
*   **Discrepancy & Rationale:** `apps/gate/package.json` lists `carrier-mock`, `db`, `ledger`, `mandate`, `rail-paypal` and `verifiers`, but not `seed`. Hoisting would let the import resolve at runtime, but the workspace graph, `npm ci` on Render and the `no-ai` test's view of the dependency all rely on the manifest. The plan also never says to add `@countersign/seed` to the root `tsconfig` paths, if the repo uses them (`apps/console/tsconfig.json` and the root `tsconfig.json` weren't listed in the plan, so I can't tell).
*   **Needed:** Add `"@countersign/seed": "0.0.0"` to `apps/gate/package.json` in item 9 or item 1, and re-run `npm install`.

### 9. Composing `limitSession` with `withSignIn` is undefined, and 429 is not a `Refusal` status

*   **Severity:** Major
*   **Affected Scope:** Items 16, 17, 19, 19a (`session-limits.ts`, `scenarioRoute`, `messagesRoute`).
*   **Discrepancy & Rationale:** `withSignIn(request, deps, run, render?)` takes `run: (key) => Promise<Answer<T>>`. `Refusal["status"]` becomes `400 | 401 | 404 | 409 | 502 | 503`. `limitSession` returns `Response | null` (401, 429). A `Response` can't be returned from `run`, and a 429 can't be expressed as a `Refusal`. Item 19 says "`withSignIn`, then `limitSession(...)`" without saying how the two connect: a 429 added to `Refusal`, a `limitSession` call inside `run` that returns a `Refusal`, or a check before `withSignIn`. Each choice changes whether a stranger's request spends a limiter slot, and whether the 401 for a missing session cookie clears the approver cookie. Item 17's `messagesRoute` has the same gap. `attachmentRoute` and `GET` routes shouldn't be limited, and the plan doesn't say so.
*   **Needed:** Pick one composition, add `429` to `Refusal["status"]` if that is it, and give the order of the checks (cookie present, then sign-in with the gate, then limiter). State that GET routes are unlimited.

### 10. Baseline launch refuses when `RESOLVE_AGENT_URL` is unset, but the codebase defaults it

*   **Severity:** Major
*   **Affected Scope:** Item 12a (`baseline-launch.ts`: "no `RESOLVE_AGENT_URL` → 503").
*   **Discrepancy & Rationale:** `apps/gate/src/nudge.ts` exports `resolveAgentUrl(env)`, which treats an unset or blank value as `http://127.0.0.1:8788` and returns null only for a non-http(s) value. The console's `resolveAgentUrl` does the same. The plan's handler would refuse when the variable is unset. A local developer who runs the gate and Resolve without setting it can't use the console's baseline button, which breaks the "locally unchanged" claim in Rollout. The plan's existing-symbols table omits `resolveAgentUrl`. Two meanings of "unset" would be a design conflict.
*   **Needed:** Say the handler uses `resolveAgentUrl(env)` from `nudge.ts`, and that the 503 applies only when it returns null.

--------------------------------------------------------------------------------

## Nits

### 11. The ledger test pins the entry-type list

*   **Severity:** Nit
*   **Affected Scope:** Item 5; `packages/ledger/test/chain.test.ts:71`.
*   **Discrepancy & Rationale:** The existing test has `expect(ENTRY_TYPES).toEqual([...])`. Adding `demo.reset` makes it fail unless it is updated. Item 5 names the file but only for the new verify case.
*   **Needed:** Say to add `"demo.reset"` to that expected list.

### 12. Two `Set-Cookie` headers need a change to `json()`

*   **Severity:** Nit
*   **Affected Scope:** Item 19a (`signInRoute`, `pairRoute`); `approval-routes.ts:265`.
*   **Discrepancy & Rationale:** The helper `json(status, body, setCookieHeader?)` takes one string and uses `headers.set`. Sign-in by key or by pairing now sets the approver cookie and the session cookie. This needs `headers.append`, or an array parameter. The plan doesn't say so, and `signOutRoute` clears both.
*   **Needed:** Name the change.

### 13. The always-throwing issuer in `serve.ts` is redundant

*   **Severity:** Nit
*   **Affected Scope:** Item 14 (`serve.ts`).
*   **Discrepancy & Rationale:** `paypalTokenIssuer(env)` already returns `() => createPayPalClient({ env }).issueAccessToken()`, which throws `PayPalConfigError` when the variables are missing. `connectBaseline` already catches it and returns null. The behaviour the plan asks for already exists, so the change risks an unnecessary edit.
*   **Needed:** Drop the change, or say what is different.

### 14. The reset mounts a new rail client on every request

*   **Severity:** Nit
*   **Affected Scope:** Item 10 (`app.ts`: `rail: factory ?? …`).
*   **Discrepancy & Rationale:** The other mounts use `railOnce`, which caches the client and its access token. The reset passing the raw `factory` builds a client, and fetches a token, on each press. That adds a call to the 60-second budget. Item 12a's `rail` should also say which one it gets.
*   **Needed:** Use `railOnce` in both, with the same "no rail" fallback.

### 15. `Reader` is not exported

*   **Severity:** Nit
*   **Affected Scope:** Item 8, item 9 (`busyRefusal(reader, now)`).
*   **Discrepancy & Rationale:** `type Reader = Database | Transaction` is private in `execution-log.ts`. `busyRefusal` lives in `demo-reset.ts` and is called with `db` and `log.tx`. The implementer must export it or re-declare it.
*   **Needed:** Say to export `Reader` from `execution-log.ts`.

### 16. `runsQueuedSince` has no home and its comparison isn't specified

*   **Severity:** Nit
*   **Affected Scope:** Item 9 step 7; item 4.
*   **Discrepancy & Rationale:** The db helper list in item 4 doesn't include it, and item 9 describes it only inline. `queued_at` is `text`. `resetAt` comes from the gate's clock and `queued_at` from Resolve's, so a plain string comparison depends on both being the same ISO form, and on the machines' clocks agreeing to the millisecond. `countRunsOnDate` casts to `timestamptz` for exactly this reason.
*   **Needed:** Put it in `packages/db/src/demo-reset.ts`, with the `::timestamptz` cast, and note the accepted skew.

### 17. The baseline-launch body mapping and the app wiring are implicit

*   **Severity:** Nit
*   **Affected Scope:** Item 12a.
*   **Discrepancy & Rationale:** `issueAccessToken()` returns `{ accessToken, expiresAt }` and Resolve's body wants `{ access_token, expires_at }`. The mapping is implied. The plan doesn't show the `mountBaselineLaunch(app, …)` call in `app.ts`, including which `fetch` it receives. `AppDeps.fetch` is a `NudgeFetch`, which returns only `{ ok }` and can't pass Resolve's body through, so the handler needs the global `fetch`.
*   **Needed:** Write both lines.

--------------------------------------------------------------------------------

## Summary

1 blocker, 9 majors, 7 nits.

The phasing, file lists, SQL and test cases are otherwise specific enough to execute. The blocker (route order) breaks the QR sign-in outright, and the majors are interface or constant choices the plan leaves to the implementer.

NO-GO
