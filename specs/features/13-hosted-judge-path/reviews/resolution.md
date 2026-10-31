# Round A resolution

Elephant, 31 Oct 2026, per `.ralph/egm/PROCESS.md` step 3 as slimmed by `.ralph/HANDOVER.md`. Zoom Out, Comprehension and Design Critic are resolved in full. Structural and Style (written before the slimming) are resolved for Blockers and Majors only. Critical decisions are recorded in ADR 0044 and in `.ralph/human.md` under "Decided for you". The answerer was asked first. It answered six of seven parts; the Elephant followed it on all six, including two where it asked for more than the Elephant had proposed (the pairing code and session limits now). It escalated custody of the PayPal secret, and the Elephant chose the fail-closed option. The Elephant wrote the counter-argument in the Design Critic's voice.

Totals: 60 PROPOSE FIX, 2 CONTEST, 25 nits not resolved. Blockers fixed: Comprehension B-1, so Comprehension is the one re-audit.

## Zoom Out

| Finding | Call | Why, and the edit |
|---|---|---|
| Z-1 CLI unused, bypasses in-flight guard (Major) | FIX | Dropped `npm run reset`; item 11 now holds `durationWords`; Non-Goals, requirements and validation check 5 follow. |
| Z-2 `durationWords` duplicated (Major) | FIX | One `durationWords` extracted from `formatDuration` in `inbox-view.ts` (item 11); `start-view.ts` imports it. |
| Z-3 Detail duplicated, already drifted (Major) | FIX | Overview now says requirements.md wins on copy, statuses and answers, and design.md on names and order; CUJ 2's sentence fixed. Code-level detail below the Detailed Implementation Plan heading stays, since round B and Ralph build from it. |
| Z-4 Blueprint test is a change-detector (Nit) | FIX | Item 23 checks invariants, adding that each start-command prefix sets the URL the code reads from the right hostport. |
| Z-5 Dispute routes keep their own key check (Nit) | FIX | Item 16 moves `loadDisputes` and `draftAgain` onto `withSignIn`. |
| Z-6 `RESOLVE_BASELINE=off` has no consumer (Nit) | CONTEST | `off` is the fail-closed reading of an unreadable value (§10 trade-off 1, ADR 0043); it costs one sentence and one test. |
| Z-7 Scenario list in three places (Nit) | FIX | Console accepts any slug and passes Resolve's answer through; the card/Resolve cross-check test stays, since the cards must match. |
| Z-8 Alternative F misses `fromService` references (Nit) | FIX | Added to Alternative F; the Blueprint spec doesn't document referencing `sync: false` values (checked 31 Oct), so per-service values stay. |
| Z-9 Diagram leaves out private edges; service count (Nit) | FIX | Diagram redrawn with `/mcp`, nudge, database and PayPal edges; "four services, a cron job and the database; five `services` entries". |

## Comprehension

| Finding | Call | Why, and the edit |
|---|---|---|
| B-1 Reset's effect on log-derived guarantees unstated (Blocker) | FIX | New "What a reset keeps and restarts" table. The order check now replaces any capture that an `execution.requested` names (`requestedCaptureIds`, item 8). Today's usage restarts by decision (ADR 0044, critical). G-4 reworded. |
| M-1 `seq` from genesis depends on unstated ledger behaviour | FIX | Technical Plan states `appendPrepared` assigns `seq`/`prev_hash` from the newest row and `seq` has no sequence, so no `RESTART IDENTITY`. |
| M-2 CLI skips in-flight and single-flight | FIX | CLI dropped; busy checks read the database (see Z-1, M-3). |
| M-3 In-flight check runs before the lock | FIX | Counter replaced by `countUnansweredRequests` (item 8), checked before the order check and again inside the lock. Rail calls get a 30 s timeout, so no execution outlasts the 10-minute window (answerer). |
| M-4 `runSeed` contract unstated | FIX | Technical Plan states its input, per-order upsert, resume, `failures`/`problem` and throws. |
| M-5 Approver key glossary says "nothing else" | FIX | Technical Plan lists its new powers; item 24 updates CONTEXT.md's entry. |
| M-6 Seed state includes tickets and receipts | FIX | Seed state reading decided (ADR 0044, critical): scenario files are the tickets, receipts with phase 18 (Non-Goals); CONTEXT.md in item 24. |
| M-7 §8 per-session rate limit missing | FIX | Added now (answerer: stated, §8 and §14): a session cookie, 12 runs and 3 resets per 10 minutes, 429 past that (item 19a, Alternative L, ADR 0044). |
| M-8 Phone sign-in left out | FIX | The QR code now carries a single-use pairing code that signs the phone in (items 12b, 19a, 21). CUJ 1, guide step 4, the judge guide and manual check 5 (timed) say so (ADR 0044). |
| M-9 `CONSOLE_PUBLIC_URL` not set | FIX | Added to the console as `sync: false`; hosting.md and manual check 1 set it; the request-origin fallback stays. |
| M-10 Cleared count vs `countRunsOnDate` | FIX | Stated: both count every status by the UTC date of `queued_at` (design table, requirements). |
| M-11 Start page on a gate 502 | FIX | Item 21 and requirements: the guide, then the unreachable `Notice` in place of the signed-in parts. |
| N-1 Unlinked jargon | FIX | Glossed or linked: Elephant (PROCESS.md), beats (§6), roadmap gate G2 (§13), Feedback commands, `.ralph/human.md`. |
| N-2 Symbols with no file | FIX | Symbol table at the top of the Detailed Implementation Plan, plus how `unseeded` is chosen. |
| N-3 "Live check 9" | FIX | Now manual check 9. |
| N-4 Four vs five services | FIX | One wording throughout (see Z-9). |
| N-5 CUJ 2 sentence omits the dispute | FIX | CUJ 2 uses the full sentence. |
| N-6 `took_ms` start point | FIX | Requirements: from the start of the reset in the gate, after the key check. |
| N-7 `durationWords` twice, rounding | FIX | One function, `Math.round` to whole seconds (item 11). |
| N-8 Route sentences differ | FIX | Console 400 sentence added to requirements; Resolve's 503 added to item 15. |
| N-9 Avoided words | FIX | "wipe" and "hold" replaced. |
| N-10 Cron `;` hides reconcile failures | FIX | The cron exits non-zero when either command fails. |
| N-11 Lock wait and 120 s timeout vague | FIX | NFR Performance states both behaviours. |
| N-12 Not-complete sentences combine | FIX | Sentences and tones defined; order failures now mean nothing cleared, so the two no longer combine. |
| N-13 CUJ 3 leaves out the gate's route | FIX | CUJ 3 and manual check 3 include `POST /demo/reset` → 401. |
| N-14 G-3 measured only locally | FIX | G-3 names manual checks 4 and 6. |

## Design Critic

| Finding | Call | Why, and the edit |
|---|---|---|
| 1 In-process guards vs deploy overlap (Major) | FIX | Execution and cooldown checks read the database; `autoDeployTrigger: off` on every service; Resolve's startup sweep marking an old instance's runs interrupted fails closed, stated in Risks (ADR 0044). |
| 2 Replacing after the commit leaves a window (Major) | FIX | The reset now replaces first and clears only if every replacement exists. Inside the lock it re-checks, and refuses if any run was queued since it began, which catches a baseline run that leaves no log entry (Alternative G, CUJ 5, ADR 0044, critical). |
| 3 G-4 overclaims; keep rule trusts `COMPLETED` (Major) | FIX | G-4 reworded; usage restart stated and decided (ADR 0044); captures named by any execution request are replaced; the pending-baseline-refund gap is named. |
| 4 Dispute beat not restored; assumptions unverified (Major) | FIX | Single-use stated (Risks, hosting.md: one dispute per judge); Open Question and manual check 7 read the disputed capture's status; per-reset drafting accepted as bounded by the cap. |
| 5 One shared key, no bound on resets (Major) | FIX | One-minute cooldown in the log, plus 3 resets per session in 10 minutes; key rotation in hosting.md; cap exhaustion added to Risks. No per-day reset count: those two already bound it. |
| 6 Resolve holds the PayPal secret beside the toolkit (Major) | FIX | The answerer escalated this. The Elephant chose the fail-closed option: on Render the gate mints one token per approver-key baseline launch and hands it to Resolve, so Resolve holds no PayPal credential (item 12a, Alternative J, ADR 0044, critical). A support-key token route was rejected. The Risks row names what a compromised child could still read. |
| 7 Phone sign-in with a 44-character key (Major) | FIX | Added a single-use pairing code in the QR URL fragment, as the answerer advised (items 12b, 19a, 21, Alternative K, ADR 0044, critical). Pasting the key and approving on the desktop stay as fallbacks; manual check 5 times it. |
| 8 Capacity and memory not analysed (Major) | FIX | Risks rows for queueing (worst case about 3 minutes a run) and memory; manual check 10 reads Resolve's peak memory. |
| 9 No Risks & Limits section (Major) | FIX | New "Risks & Mitigations" section, including outage, vault token, token refresh, Gemini tier, key rotation and disk. |
| Nit 1 CUJ 2 sentence and count | FIX | Uses the requirements sentence with 7 orders, which CUJ 1 can produce. |
| Nit 2 "The one behaviour change" | FIX | Rollout lists both changes. |
| Nit 3 G-5 webhook draft path | FIX | G-5 narrowed to console routes and names the capped webhook and cron drafts. |
| Nit 4 Disk size | FIX | `diskSizeGB: 5` and a growth figure in Risks. |
| Nit 5 ADRs say accepted while design is a draft | CONTEST | Autopilot ADRs record decisions as made, overturnable by the owner (brief §14); round A's changes are a new ADR 0044, and 0041 to 0043 now say they're amended by it. |
| Nit 6 Cost of the per-request key check | FIX | NFR Performance states it (2 s inbox refresh while working, beside the 3 s approvals poll). |
| Nit 7 Webhook dedup cleared | FIX | CUJ 2 and the keep/restart table say late webhooks land as refunds nobody requested. |

## Structural (Blockers and Majors only)

| Finding | Call | Why, and the edit |
|---|---|---|
| 1 No Risks & Mitigations section (Major) | FIX | Added (see Design Critic 9). |
| 2 Additional Resources and Future Improvements nest under NFR (Major) | FIX | Both are now H2. |
| 3 Diagram omits flows, misplaces the gate (Major) | FIX | Redrawn in public and private columns; the phone goes to `/approvals`; the cron runs in its own process. |
| Nits 4 to 11 | not resolved: reviewer dropped by the slimmed review | |

## Style (Blockers and Majors only)

| Finding | Call | Why, and the edit |
|---|---|---|
| M1 Rollout contradicts itself (Major) | FIX | Reworded as suggested, with both everywhere-changes. |
| M2 "Typed once" vs Alternative F (Major) | FIX | Hosting says once per service that reads the PayPal values (three, now that Resolve has none). |
| M3 Alternative F's heading (Major) | FIX | "One shared environment group for secrets, or references to the gate's values". |
| M4 G-3 isn't the goal committed to (Major) | FIX | G-3 is now "every reset after the first ≤ 60 s", first recorded with the same target. |
| M5 Measures don't cover the clauses (Major) | FIX | G-2, G-4 and G-5 list every validation check that proves them. |
| M6 "A database flagged as a demo" (Major) | FIX | Stated as the gate's `COUNTERSIGN_DEMO_RESET=on`, set only for a demo database. |
| M7 Quoted CUJ copy doesn't match (Major) | FIX | CUJ 2 quotes the exact sentence; CUJ 3 describes the prompts and points to requirements. |
| M8 Avoided terms (Major) | FIX | "step-up", "step-up card", "the reset"; the judge approves on the card. |
| Nits N1 to N17 | not resolved: reviewer dropped by the slimmed review | |
