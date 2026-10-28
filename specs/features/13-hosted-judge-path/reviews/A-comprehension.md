# Round A: comprehension review

*   **Reviewer:** Comprehension Goldfish (`.ralph/egm/agents/comprehension.md`, Mode: REVIEW)
*   **Standard:** `.ralph/egm/standards/re-implementation-standard.md`
*   **Target:** `specs/features/13-hosted-judge-path/design.md`, the whole document (lines 1-529)
*   **Read:** the target; the files it links (`requirements.md`, `validation.md`, `CONTEXT.md`, ADRs 0041, 0042, 0043); the ADRs it names (0022, 0023, 0030, 0031, 0032, 0035, 0038, 0039); brief §8 and §10. Nothing else.

Totals: 1 blocker, 11 majors, 14 nits.

## Blocker

### B-1. What a reset does to everything else the audit log holds is unstated, so G-4 can't be checked

*   **Severity:** Blocker
*   **Affected Scope:** Goals G-4 ("Reset never weakens a guarantee"); Technical Plan, "The reset (ADR 0042)"; item 4 `clearDemoTables`; item 9 step 4; NFR Security.
*   **Discrepancy & Rationale:** The design treats the AI run cap as the only state a reset must carry forward. But the named ADRs say the audit log feeds other guarantees. ADR 0022 says executions are read back from the log "for `ledger.not_duplicate` and today's usage". CONTEXT.md says a **Limit** is checked against **Today's usage**, and that a **Replay** and `DUPLICATE_REFUND` depend on earlier execution entries. ADR 0032 says an open **Step-up** exists only as a `decision` entry. ADR 0039 says a payout's bill is "paid at most once" because its intent is already logged. After `TRUNCATE audit_log`, a reader can't tell:
    *   whether today's usage and the mandate's daily limits start again from zero after each reset. If they do, a key holder can reset to get past a refund or payout limit, which weakens a §10 trade-off 1 guarantee, not just the run cap;
    *   what happens to an open step-up card, for example one a judge's phone is showing at that moment;
    *   whether an ops-agent payout intent that executed before the reset can execute again after it;
    *   what `npm run reconcile` and the cron do with refunds and payouts whose `execution.requested` and `execution.result` entries are gone.

    G-4 says the reset "never weakens a guarantee" but measures only the run cap. An implementer would have to decide each of these alone. The design needs to name every guarantee that reads the log, and say for each one whether the reset carries it forward (as `cleared_run_counts` does for the run cap), accepts losing it, or refuses to run.

## Majors

### M-1. Whether the new log really restarts at `seq` 1 from genesis depends on ledger behaviour the design doesn't state

*   **Severity:** Major
*   **Affected Scope:** item 9 step 4 (`withAuditLog`, `log.append`); item 4 `clearDemoTables` (the `TRUNCATE` statement); CUJ 2 ("empty except entry 1"); validation check 4.
*   **Discrepancy & Rationale:** The design says the `demo.reset` entry is entry 1 with the genesis previous hash, appended in the same transaction right after the TRUNCATE. That holds only if (a) `seq` isn't a serial or identity column, because `TRUNCATE` without `RESTART IDENTITY` keeps the sequence's counter, and (b) `withAuditLog` and `log.append` read the head when they append, not when the callback starts. The design doesn't link or describe the contract of `withAuditLog` or `log.append`: their arguments, whether `at` comes from the caller, and how `seq` and `prevHash` are worked out. ADR 0022 says only that `seq` is a "bigint, primary key, from 1". The design needs to state how `seq` is assigned, and either add `RESTART IDENTITY` or say why it isn't needed.

### M-2. `npm run reset` skips the in-flight check and the single-flight guard

*   **Severity:** Major
*   **Affected Scope:** item 11 (`inFlight: () => 0`, "a CLI process has no executions"); item 9 step 2 (module-level `running`); G-4; requirements "Same checks and order"; `docs/hosting.md` (Render Shell use).
*   **Discrepancy & Rationale:** The CLI picks its database "as every CLI" (`DATABASE_URL` when set, per ADR 0022). Run from the gate's Render Shell, which hosting.md already sends the owner to, it would reset the hosted database. The gate process could be mid-execution at that moment, and the CLI's `inFlight: () => 0` can't see that. A CLI reset and an HTTP reset could also run at the same time, because the `running` flag lives in each process, and both could then reseed the same orders. G-4 ("never while … an execution is mid-flight") and "one reset at a time" then don't hold. The design should either restrict the CLI to local or PGlite databases, or say why this is acceptable.

### M-3. The in-flight execution check runs before the lock is taken, and the design doesn't say why that gap is safe

*   **Severity:** Major
*   **Affected Scope:** item 9 step 3 (`inFlight() > 0` → 409) followed by step 4 (`withAuditLog`); item 8; the reset diagram (checks above "withAuditLog").
*   **Discrepancy & Rationale:** The in-flight count is read outside the ledger lock. Suppose an allow or approval commits its `execution.requested` entry and enters `execute()` after the check but before `withAuditLog` takes the lock. The reset would then truncate that request, and the rail call's `execution.result` would be appended to the new chain with no request before it. The design doesn't say whether this ordering is safe, whether the count should be read again inside the lock, or whether the window between the request's commit and `execute()`'s increment exists at all. A reader can't confirm the guarantee CUJ 4 states.

### M-4. The `runSeed` contract the reset depends on isn't stated, and the files move "contents unchanged"

*   **Severity:** Major
*   **Affected Scope:** item 1 ("contents unchanged except … `StoredRowSchema`"); item 9 step 6 (`runSeed({ paypal, db, orders, runId, vaultTokens, clock })`, `report.failures`, `report.problem`); Technical Plan ("`seed_orders` rows are replaced per order").
*   **Discrepancy & Rationale:** The reset calls `runSeed` with an `orders` subset and expects it to replace those orders' `seed_orders` rows while leaving the others alone. The design doesn't say whether today's `runSeed` takes an `orders` argument, whether it upserts or replaces the whole table, or what `SeedReport` contains (`failures[]` items with `orderNumber`, `call` and `reason`, and `problem`). It also says the move leaves the file contents unchanged. If today's `runSeed` always seeds the whole catalog or clears the table first, the per-order replacement in ADR 0042 is wrong, and nothing in the design would show it. The design should state the `runSeed` and `SeedReport` signatures, and its row-writing behaviour, that the reset relies on.

### M-5. Approver key: the glossary says "nothing else", and the design gives it four more powers

*   **Severity:** Major
*   **Affected Scope:** CONTEXT.md **Approver key** ("It lets its holder answer step-ups and nothing else"); G-5; CUJ 2 and CUJ 3; items 10, 16, 17, 19; item 24 (the docs to update).
*   **Discrepancy & Rationale:** In this design the approver key also resets the demo, launches scenarios, reads the inbox and threads, and sends chat messages. A fresh reader trusts the glossary, so this reads as a contradiction. Item 24 updates `specs/tech-stack.md` but not `CONTEXT.md`. The **Approver key** entry should be updated, or the design should say why it stays as written.

### M-6. "Seed state" in the glossary includes tickets and receipts; the reset clears tickets and restores neither

*   **Severity:** Major
*   **Affected Scope:** CONTEXT.md **Seed state** ("orders, trackers, receipts, tickets") and **Demo reset**; G-3 ("Reset restores the seed state"); CUJ 2.
*   **Discrepancy & Rationale:** G-3's measure is "restores the seed state". The reset truncates `tickets` and seeds none, and receipts (M-Pesa) never come up. A reader can't tell whether the seed state includes seeded tickets or receipts, which would make the reset incomplete, or whether the glossary entry is out of date. The design should say which, and item 24 should fix CONTEXT.md if needed.

### M-7. Brief §8 requires per-session rate limits on the public demo, and the design hosts the demo without them

*   **Severity:** Major
*   **Affected Scope:** Non-Goals ("Attack it yourself", phase 15); Alternative C; NFR "AI cost"; G-5; brief §8 ("each session is rate-limited, and AI spend has a daily cap").
*   **Discrepancy & Rationale:** §8 is a non-negotiable and puts rate limits and the daily cap together. This phase makes the demo public with the daily cap and the shared approver key, and defers rate limiting to phase 15. A risk line says "phase 15 adds rate limits" for resets only. The design never says why the sign-in meets §8 in the meantime, or whether the shared key counts as a "session". The reader is left to infer that the gap is deliberate and allowed.

### M-8. The phone approval step leaves out signing in on the phone

*   **Severity:** Major
*   **Affected Scope:** CUJ 1 ("scans the start page's code with a phone to approve the $240 refund"); requirements step 4 of the start page; G-2; `docs/judge-guide.md` (item 24).
*   **Discrepancy & Rationale:** ADR 0032 keeps the key in an HttpOnly cookie on each browser and never sends it to page JavaScript. So the QR code can't carry the sign-in, and the phone must sign in on its own by typing a 44-character generated key (ADR 0041). Neither the CUJ, the five steps nor the judge guide mentions this. This is an assumed prerequisite in the main judge journey, which is gate G2's path. The design should state the step, or how the phone gets signed in.

### M-9. `CONSOLE_PUBLIC_URL` is used for the phone code but isn't defined or set in the blueprint

*   **Severity:** Major
*   **Affected Scope:** item 21 (`approvalsUrl({ publicUrl: process.env.CONSOLE_PUBLIC_URL, origin: requestOrigin(headers) })`); item 22 (`countersign-console` envVars); item 23 ("each service's exact set of `envVars` keys"); requirements "Technical needs" (new env).
*   **Discrepancy & Rationale:** The start page's QR code depends on `CONSOLE_PUBLIC_URL`. The variable isn't defined anywhere the design links, isn't in the console's blueprint entries (which the test pins exactly), and isn't in hosting.md's list of values to type. The reader can't tell whether it should be unset on Render and, if so, whether `requestOrigin(headers)` gives the public `onrender.com` origin rather than an internal one behind Render's proxy. If it doesn't, the phone code points somewhere unreachable.

### M-10. Whether the cleared-run count matches `countRunsOnDate` is undefined

*   **Severity:** Major
*   **Affected Scope:** item 4 (the `INSERT … SELECT … count(*)` over every `agent_runs` and `dispute_drafts` row); item 6 (`overDailyCap` adds `countClearedRunsOnDate`); requirements "The daily cap".
*   **Discrepancy & Rationale:** The clear counts every row by `queued_at`, of any status. The design doesn't say what `countRunsOnDate` and today's draft count actually count. ADR 0030 says a capped run is stored with status `not_run`, and ADR 0037 is cited for failed drafts counting. If the live count leaves out `not_run` rows, or counts by another column or day boundary, a reset changes the cap: it tightens if more rows are carried forward than the live count would have used, and loosens if fewer are. The design should state that both counts use the same definition, and what that definition is.

### M-11. The start page's behaviour when the gate can't be reached is unspecified

*   **Severity:** Major
*   **Affected Scope:** item 21 (`app/page.tsx`: "signed in when `checkKey` is ok"); requirements "The start page".
*   **Discrepancy & Rationale:** The inbox has a defined answer for a 502 from `checkKey` (the existing `Notice`, item 18). The start page has none. A reader must decide whether a 502 shows the sign-in form, which would tell a signed-in judge their key is wrong, shows a notice, or hides the launcher. This is the judge's landing page, and the re-implementation standard asks for error states to be explicit.

## Nits

### N-1. Process jargon and references the design names but doesn't link

*   **Severity:** Nit
*   **Affected Scope:** Header ("autopilot planner (Elephant)"); Open Questions ("`answerer` agent", "Goldfish sub-agent", "Round A's Design Critic"); Overview ("roadmap item 13 and gate G2"); Detailed Implementation Plan ("the four Feedback commands"); Non-Goals and item 24 (`.ralph/human.md`); item 11 (`specs/tech-stack.md` CLI conventions); "beat 3/4/5/7" throughout.
*   **Discrepancy & Rationale:** None of these is defined or linked. The beats are in brief §6, the process roles in `.ralph/egm/PROCESS.md` (which the ADRs name), and the Feedback commands only become clear from validation check 1. Each needs a link or a short gloss the first time it appears.

### N-2. Existing code symbols are used with no file pointer or contract

*   **Severity:** Nit
*   **Affected Scope:** Items 9 to 21: `parsePayPalEnv`, `NudgeFetch`, `Environment`, `approverOnly`, `Approver`, `webhookDeps`, `factory`, `parseEntry`, `SEED_CONCURRENCY`, `EXIT_NEGATIVE`, `callGate` (and whether it takes `timeoutMs`), `callResolve`, `refusalOf`, `Answer<T>`, `ApprovalDeps`/`ResolveDeps` ("which have the same fields"), `CONTROL_CLASSES`, `approvalsUrl`, `requestOrigin`, `qrView`, `Sender`.
*   **Discrepancy & Rationale:** Most of these can be found by searching the code, but a few carry behaviour. Two examples: whether `callGate` already supports a per-call timeout, and what decides whether `unseeded` is "Order …" or "Buyer A". A short table of the existing symbols the plan uses, with their files, would remove the guesswork.

### N-3. "Live check 9" doesn't exist

*   **Severity:** Nit
*   **Affected Scope:** Open Questions, "Render's private network from a cron job".
*   **Discrepancy & Rationale:** validation.md has one live check. The cron's private-network check is manual check 9.

### N-4. The service count is four in some places and five in others

*   **Severity:** Nit
*   **Affected Scope:** Overview and Problem ("four services"), G-1, item 23 ("the five services' `type`").
*   **Discrepancy & Rationale:** `render.yaml` lists five entries under `services`: four web or private services and the cron job. The design should say which count it means and use it throughout.

### N-5. CUJ 2's example sentence contradicts its own dispute step

*   **Severity:** Nit
*   **Affected Scope:** CUJ 2, "Then".
*   **Discrepancy & Rationale:** The CUJ says an open dispute is recorded again, but its example sentence ("Reset in 14s. Replaced 4 orders and kept 26.") leaves out "Recorded 1 dispute again." Requirements drop that sentence only when no dispute was recorded.

### N-6. `took_ms` starts at different points in the design and in requirements

*   **Severity:** Nit
*   **Affected Scope:** item 9 steps 1 and 8; requirements "Report" ("wall time from the request to the report").
*   **Discrepancy & Rationale:** The design starts the clock inside `resetDemo`, after routing and the key check. Requirements start it at the request.

### N-7. `durationWords` is defined twice, and its rounding isn't stated

*   **Severity:** Nit
*   **Affected Scope:** item 11 (`apps/gate/src/words.ts`, called "shared"); item 20 (`start-view.ts` also lists `durationWords(ms)`).
*   **Discrepancy & Rationale:** The design doesn't say whether the console imports the gate's function or has its own copy. Neither says whether 14.6 seconds becomes "14s" or "15s".

### N-8. The scenario routes' sentences and statuses differ between the design and requirements

*   **Severity:** Nit
*   **Affected Scope:** item 19 (console 400 "Send JSON with scenario_id and mode."); item 15 (Resolve's `POST /scenarios/:id`).
*   **Discrepancy & Rationale:** The design says copy is "exactly as in requirements.md". But the console's 400 sentence isn't in requirements, and Resolve's 503 when there's no database (which requirements lists) is missing from item 15.

### N-9. The design uses words the glossary says to avoid

*   **Severity:** Nit
*   **Affected Scope:** Alternative A ("The wipe"); CUJ 1 ("protected shows denials and a hold").
*   **Discrepancy & Rationale:** CONTEXT.md lists "wipe" as a word to avoid for **Demo reset**, and "hold" for **Step-up**.

### N-10. The cron command's `;` hides failures of the reconcile step

*   **Severity:** Nit
*   **Affected Scope:** item 22, `countersign-reconcile` `startCommand`; manual check 9 ("the cron job's runs succeed").
*   **Discrepancy & Rationale:** With `;`, the job's exit status comes from `disputes -- sync` alone, so a failed `npm run reconcile` still reads as a successful run. The design should say whether that's intended.

### N-11. The lock timeouts and what happens after the 120-second console timeout are vague

*   **Severity:** Nit
*   **Affected Scope:** reset diagram and item 9 step 4 (the ledger advisory lock is taken before `SET LOCAL lock_timeout`); item 19 (`timeoutMs: 120_000` → 502).
*   **Discrepancy & Rationale:** The wait for the advisory lock has no stated limit, so it isn't covered by the "5 seconds" in the `locksBusy` sentence. Separately, a reset that outlasts the console's 120 seconds shows "unreachable" while it carries on in the gate. The judge's natural retry would then get 409 "A reset is already running." Neither behaviour is described.

### N-12. How the "not complete" reset sentences combine isn't specified

*   **Severity:** Nit
*   **Affected Scope:** item 20 `resetSentence`; requirements ("and/or").
*   **Discrepancy & Rationale:** When orders fail and the dispute sync also fails, the order and separator of the two sentences aren't given, and neither is the tone.

### N-13. CUJ 3 leaves out the gate's public reset route

*   **Severity:** Nit
*   **Affected Scope:** CUJ 3 (it lists console routes, and says Resolve and the database are unreachable).
*   **Discrepancy & Rationale:** `countersign-gate` is a public web service, and `POST /demo/reset` is on it behind the approver key. A stranger can call it directly, so the CUJ should say so and give the 401.

### N-14. G-3's measure is local, but the goal is about the hosted demo

*   **Severity:** Nit
*   **Affected Scope:** G-3 ("Measured: `reset-live.test.ts`'s `took_ms`").
*   **Discrepancy & Rationale:** That test runs on local PGlite against the sandbox, not on Render's database or network. The hosted measure is manual checks 4 and 6, and G-3 should name them too.
