# Round A: Design Critic review of phase 13 (the hosted judge path)

*   **Reviewer:** Design Critic Goldfish (fresh session, no history)
*   **Mode:** REVIEW
*   **Target:** `specs/features/13-hosted-judge-path/design.md`, lines 1-177 (above `## Detailed Implementation Plan`)
*   **Standard:** `.ralph/egm/standards/feature-spec-standard.md`
*   **Read:** the target range; its links (`requirements.md`, `validation.md`, `CONTEXT.md`, ADRs 0041-0043, the Render Blueprint spec, `docs/spikes.md` S4 and S7); brief §8 and §10; the ADRs the range names (0022, 0023, 0030, 0031, 0032, 0035, 0038, 0039).
*   **Verified externally:** the Render Blueprint spec (25 Oct 2026) confirms the plan IDs `0.5c-512mb` and `0.1c-256mb`, `postgresMajorVersion: "18"`, `ipAllowList: []` meaning internal-only, `generateValue` giving a base64 256-bit value (44 characters), and that `sync: false` is ignored inside environment groups. It says nothing on whether cron jobs reach private services, so that Open Question stands.

**Totals: 0 blockers, 9 majors, 7 nits.**

The design meets most of the standard. It states the problem, has measurable goals and non-goals, and gives an architecture with data flows. It also has six alternatives with reasons. The majors cluster in three places. Several safety claims rest on the gate and Resolve each being one process. The reset leaves a window, and partial states, after its transaction commits. And one shared approver key opens everything.

---

## Findings

### 1. In-process single-flight and in-flight counts don't survive Render's deploy overlap

*   **Severity:** Major
*   **Affected Scope:** design.md lines 40 (Non-Goals, "More than one instance"), 87-102 (the reset flow), 174 (Future Improvements); ADR 0041 "One instance of each service"; ADR 0042 checks; ADR 0030 startup sweep.
*   **Discrepancy & Rationale:** G-4 ("never while … an execution is mid-flight") assumes the gate is one process at all times. Render web and private services deploy with zero downtime: the new instance starts and passes its health check before the old one is stopped. During that overlap there are two gates. A reset on the new instance can't see an execution in flight on the old one, and the single-flight lock doesn't cover the old one either. An approval answered with the `cli` channel from the gate's Render Shell (ADR 0032) also executes outside the web process's counter. Resolve has the same problem in a worse form. ADR 0030 marks every `queued` or `running` run as `failed`/`interrupted` at startup. A new Resolve instance would mark runs the old one is still executing, which in baseline mode may be moving money. The blueprint description sets no `autoDeploy`, so every push to `main` before the freeze would redeploy all four services.
*   **Recommendation:** Detect in-flight executions inside the reset's locked transaction from the database: an `execution.requested` with no `execution.result` that is newer than a bound, such as the 6-hour replay window. That works across processes and needs no in-process counter, so offer it as an alternative to the counter. If the counter stays, state the deploy-overlap window and why it's acceptable. Decide `autoDeploy` explicitly in ADR 0041. Then either make Resolve's startup sweep tolerate an overlapping instance (for example, only runs older than the longest possible run) or say why it doesn't need to.

### 2. Replacing orders after the commit leaves a window and partial states

*   **Severity:** Major
*   **Affected Scope:** design.md lines 89-102 (the reset flow), 58-60 (CUJ 2), G-3 and G-4 (lines 27-28); ADR 0042 "Partial is reported, not hidden".
*   **Discrepancy & Rationale:** The log and Resolve's tables are cleared first, and only after the commit are captures read and replacement orders created (up to 60 seconds and more on the first seed). Nothing stops a launch or message in that window. `POST /scenarios/:id` resolves the sender from `seed_orders` rows that still name the old, refunded captures, and those rows may be replaced while the run is in progress. If replacement fails because of a PayPal sandbox error or rate limit, the demo is left with an empty log and stale seed rows. The next judge's stalled-parcel run then targets a capture that is already refunded, and the cleared log has no history for `ledger.not_duplicate`. That breaks beat 4 against trade-off 3. "Partial is reported" tells the presser, but not the next judge.
*   **Recommendation:** Consider and document the alternative ordering. Read the captures and create the replacement orders first (side effects only in the sandbox, with new rows not yet bound). Then, in one transaction, swap the `seed_orders` rows and clear the tables, so the demo is either fully old or fully new. Failing that, hold a "reset in progress" state that Resolve's `POST /messages` and `POST /scenarios/:id` refuse with 409 until the report is written. Have the launcher refuse while the last reset is incomplete.

### 3. G-4's "never weakens a guarantee" is overclaimed: a reset restores the mandate's daily limits and erases duplicate history

*   **Severity:** Major
*   **Affected Scope:** design.md line 28 (G-4), 107 (Data), 153 (Security); CONTEXT.md "Today's usage", "Limit", "Replay".
*   **Discrepancy & Rationale:** Today's usage, which the mandate's limits check, is computed from execution entries in the audit log. So is the replay and `DUPLICATE_REFUND` history. Truncating the log sets every principal's usage to zero, which gives the agent fresh auto-allow headroom. The design carries the run cap across resets through `cleared_run_counts` but says nothing about limits. Restoring limits may well be needed: without it, a second judge's stalled-parcel refund could escalate to step-up and break beat 4. But that is a trade-off against trade-off 1, and it needs to be stated, not hidden behind "never weakens a guarantee". The keep rule also trusts the capture's `COMPLETED` status alone. A capture can read `COMPLETED` while a refund is still pending or an execution ended `unknown`. Such an order is kept and its history cleared, so a later run can propose against it with no duplicate history. PayPal's own over-refund check is then the only guard.
*   **Recommendation:** Reword G-4 to list exactly what a reset restores (limits, replay history) and what it keeps (the run cap). Record why restoring limits is acceptable: sandbox only, and the approver can approve over-limit refunds anyway. Bound how often it can happen (see finding 5). For the keep rule, also replace any order whose capture has a refund that isn't `COMPLETED`, or whose cleared log held an `unknown` or unfinished execution on its capture.

### 4. The dispute beat isn't restored by a reset, and the assumptions behind keeping it are unverified

*   **Severity:** Major
*   **Affected Scope:** design.md lines 36 (Non-Goals, dispute beat), 58-60 (CUJ 2 "any open dispute is recorded again"), 99 (`syncDisputes`), 120-122 (Alternative B); ADR 0042 "Open disputes come back"; validation.md manual check 7.
*   **Discrepancy & Rationale:** `syncDisputes` re-records only disputes that are waiting for the seller. Once one judge approves the evidence pack and it's submitted (beat 7), the dispute moves on, and no later reset brings it back. The next judge's Disputes page is empty, against G2 ("the full PayPal demo path works end to end"). Opening a new dispute needs the owner's sandbox buyer login. The design also assumes that a disputed capture keeps reading `COMPLETED`, so `KIK-1032` is kept. That is unverified. If the dispute is adjudicated for the buyer, or PayPal reports another status, `KIK-1032` is replaced and the dispute is orphaned every time. Every reset also nudges Resolve to draft every lingering open dispute again, including ones on captures from earlier runs. Each draft costs a run against the cap.
*   **Recommendation:** State plainly that beat 7 is single-use per pre-opened dispute, or say how many disputes the owner pre-opens and how that stock is checked. Add a live check that reads a disputed capture's status. Limit the reset's sync to disputes on current seed captures, or skip drafting where a non-template draft already existed before the reset.

### 5. One shared approver key opens everything, with no bound on how often

*   **Severity:** Major
*   **Affected Scope:** design.md lines 125-128 (Alternative C), 153 (Security risk "accepted for the judging window"), 155 (generated keys go to judges); ADRs 0041 and 0043 answers.
*   **Discrepancy & Rationale:** Alternative C is rejected because anyone could "spend the day's 200 runs in minutes and lock judges out". But every judge, and anyone they pass the Devpost text to, holds the same key, and it opens the launcher, chat, approvals and reset. One holder can still exhaust the cap, which carries across resets by design, so the lockout lasts the rest of the UTC day. They can also reset in a loop. Single-flight bounds how many resets run at once, not how often. Each loop is 30 capture reads plus seeding against the one sandbox app whose credentials also carry the judges' refunds, so PayPal rate limits could hit the real path. Nothing says how the owner rotates the key if it leaks, or what that does to judges holding the old one.
*   **Recommendation:** Add a cheap bound now rather than in phase 15: a reset cooldown (for example, refuse within 2 minutes of the last one) and a per-day reset count. Add a line in `docs/hosting.md` on rotating the generated approver key and updating the Devpost text. Restate the accepted risk to cover cap exhaustion as well as mid-session resets.

### 6. Resolve, the agent's host, holds the PayPal client secret beside the vulnerable toolkit

*   **Severity:** Major
*   **Affected Scope:** design.md lines 84 (Hosting), 156 ("The toolkit's child process still gets only a per-run sandbox token"); ADR 0041 Secrets (`PAYPAL_CLIENT_ID`/`SECRET` on Resolve); brief §8 ("The agent never holds PayPal or Daraja credentials; only Countersign does"), §10 trade-off 1.
*   **Discrepancy & Rationale:** On the host, the blueprint puts the long-lived PayPal client secret and the Gemini key on `countersign-resolve-agent`. That is also where the toolkit's dependency tree (11 known vulnerabilities, 6 high, spike S4) runs as a child process. The mitigation offered is that the child gets only a per-run token. But a child process under the same Unix user can normally read its parent's environment through `/proc/<ppid>/environ`, so the client secret isn't isolated from it. ADR 0031 set up minting in Resolve for local use. Phase 13 is the first time that secret sits on an internet-adjacent host, and the range doesn't weigh it against §8, which is absolute.
*   **Recommendation:** Consider an alternative where Countersign (the gate) mints the per-run baseline token over the private network, so Resolve holds no PayPal client credentials at all. If the current choice stays, say how it squares with §8. Also run the child as a separate user, or with a scrubbed environment and no access to `/proc`, or drop the claim that the token is all it can reach.

### 7. Signing in on the phone with a generated 44-character key threatens the 5-minute judge path

*   **Severity:** Major
*   **Affected Scope:** design.md lines 51-53 (CUJ 1, "scans the start page's code with a phone to approve"), 155 (generated keys); ADR 0041 Goldfish argument and answer; brief §3, §10 trade-offs 3 and 4.
*   **Discrepancy & Rationale:** The QR code opens `/approvals` on the phone, which asks for the approver key (ADR 0032). The key is now a random 44-character base64 string. Typing it on a phone is slow and error-prone, and copying it means opening the Devpost testing instructions on the phone. ADR 0041's counter-argument covers hand-copying into the CLI and Devpost, not the phone step. Nothing in CUJ 1 or the manual checks times it against the brief's 5 minutes.
*   **Recommendation:** Weigh a short-lived, single-use pairing code in the QR URL, minted by the gate for the signed-in desktop session and exchanged for the cookie. Or weigh a generated key in an easier-to-type form. At minimum, add the phone sign-in to manual check 5 and time it.

### 8. Capacity with several judges and memory on the smallest plans aren't analysed

*   **Severity:** Major
*   **Affected Scope:** design.md line 158 (Performance & Latency: "the run itself is as in phase 8"), G-2, G-3; ADR 0030 (one run at a time per process); ADR 0041 plans; spike S8 (12-22 seconds per call on the free tier).
*   **Discrepancy & Rationale:** Resolve runs one agent run at a time per process. A run can make up to 8 model calls at 12-22 seconds each, so a few judges launching four scenarios each could queue for many minutes. The reset also refuses while any run is queued, so a busy queue blocks every judge's reset too. Nothing states the expected number of judges at once or which Gemini tier the host uses. Every service runs from source with tsx on `0.5c-512mb`. On Resolve, a baseline run also spawns a second Node process that loads the toolkit's langchain tree. Memory hasn't been measured (S7 hasn't started), and an out-of-memory restart turns every in-progress run into `interrupted`.
*   **Recommendation:** Add a capacity statement: expected concurrent judges, worst-case queue wait, and the Gemini tier on the host. Add a live or manual check of Resolve's peak memory during a baseline run on `0.5c-512mb`. Say what a judge sees when their run is queued behind another judge's.

### 9. The standard's Risks & Limits section is missing; risks are scattered and several failure modes are absent

*   **Severity:** Major
*   **Affected Scope:** design.md lines 150-160 (Non-Functional Requirements), 41-45 (Open Questions); standard "Risks & Limits".
*   **Discrepancy & Rationale:** The standard requires the spec to call out its own failure modes, security implications, scalability limits and mitigations. Risks here are spread across NFR bullets and Open Questions, with one stated risk and mitigation. The range doesn't address:
    *   a PayPal sandbox outage or rate limit during a reset, after the clear has committed;
    *   a revoked or invalid seed vault token, which makes every reset partial;
    *   brief §8 and §5 item 18's "tokens refreshing automatically" on the host (item 18 is cited in the Overview but no goal covers it);
    *   the Gemini quota on the host;
    *   rotating a leaked key;
    *   Postgres disk sizing (see nit 4).
*   **Recommendation:** Add a "Risks & Mitigations" section that lists each risk with its likelihood, its effect on the judge path and its mitigation, or names the phase that owns it. Cross-reference findings 1-8.

### Nit 1. CUJ 2's sentence doesn't match requirements.md

*   **Severity:** Nit
*   **Affected Scope:** design.md line 60 (CUJ 2 Then); requirements.md line 101.
*   **Discrepancy & Rationale:** CUJ 2 says an open dispute is recorded again, but its sentence ("Reset in 14s. Replaced 4 orders and kept 26.") leaves out "Recorded 1 dispute again.", which requirements.md says appears whenever disputes are recorded. CUJ 1 can also touch up to 7 orders (beat 3 baseline on `KIK-1038` to `KIK-1042`, plus `KIK-1035` and `KIK-1037`), so "4" is unexplained.
*   **Recommendation:** Use the exact sentence from requirements.md, with a count CUJ 1 can produce.

### Nit 2. "The one behaviour change everywhere" isn't the only one

*   **Severity:** Nit
*   **Affected Scope:** design.md line 160 (Rollout & Rollback).
*   **Discrepancy & Rationale:** `/` no longer redirects to `/decisions` (requirements.md line 104). That also changes behaviour everywhere, locally included.
*   **Recommendation:** List both changes.

### Nit 3. G-5 has an AI path that needs no key

*   **Severity:** Nit
*   **Affected Scope:** design.md line 29 (G-5), 157-159; ADR 0035 nudge.
*   **Discrepancy & Rationale:** A signed `CUSTOMER.DISPUTE.CREATED` webhook, which anyone holding the sandbox buyer login from the Devpost text can cause, and the cron's dispute sync both make Resolve start a Gemini draft without the approver key. The daily cap bounds it, but "Nothing public spends AI … without the approver key" is literally false.
*   **Recommendation:** Narrow G-5 to the console routes and name the webhook and cron draft path as capped.

### Nit 4. Storage growth between resets is unbounded, and the disk size isn't stated

*   **Severity:** Nit
*   **Affected Scope:** design.md lines 107 (Data), 158; ADR 0030 (messages past the cap are still stored; attachments up to 3 × 2 MB); ADR 0041 Postgres plan.
*   **Discrepancy & Rationale:** The run cap bounds runs, not stored messages. A key holder can store messages with photos indefinitely between resets, and `carrier_shipments` grows on every reset. The blueprint description gives a compute plan but no `diskSizeGB`. A full disk takes the demo down before 22 Dec (§8).
*   **Recommendation:** State the disk size and a worst-case growth figure, or cap stored messages per day.

### Nit 5. ADRs 0041-0043 say "accepted" while the design is a Draft under review

*   **Severity:** Nit
*   **Affected Scope:** design.md lines 4, 15, 43 (Open Questions); ADR 0041-0043 `Status` lines.
*   **Discrepancy & Rationale:** The Open Questions ask round A to treat all three decisions as contested, but each ADR already reads `Status: accepted`.
*   **Recommendation:** Mark them proposed until round A closes, or note that acceptance depends on this review.

### Nit 6. The cost of the per-request key check isn't stated

*   **Severity:** Nit
*   **Affected Scope:** design.md lines 105, 154, 158; ADR 0038 (key checked by `GET /approvals`); ADR 0032 (approval states derived from the log).
*   **Discrepancy & Rationale:** Every signed-in Resolve route now costs a `GET /approvals`, inbox polling included, and that call works out open step-ups from the log. The performance section counts the check only for a launch.
*   **Recommendation:** State the polling rate and the check's cost on a judging-day log, or use a lighter key-check endpoint.

### Nit 7. Webhook dedup state is cleared with the log

*   **Severity:** Nit
*   **Affected Scope:** design.md lines 94-96 (truncation); ADR 0035 ("One entry per webhook event ID").
*   **Discrepancy & Rationale:** Event-ID dedup lives in the truncated log. PayPal's retries of events from before a reset, and refund webhooks for captures that were just replaced, land in the new log as fresh entries or unmatched refunds. The next judge's first audit view then shows activity they didn't cause.
*   **Recommendation:** Mention it in CUJ 2, or skip events whose capture isn't a current seed capture and is older than the reset.
