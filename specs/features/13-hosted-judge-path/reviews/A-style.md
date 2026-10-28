# Round A review: style (Goldfish, Mode: REVIEW)

Target: `specs/features/13-hosted-judge-path/design.md`, lines 1-177 (Overview to Future Improvements).
Read: the target, `requirements.md`, `validation.md`, ADRs 0041-0043, `CONTEXT.md`, `specs/brief.md` §3, §5, §8, §10, §11.
Terminology standard: `CONTEXT.md` (its _Avoid_ lists).

Totals: 0 blockers, 8 majors, 17 nits.

---

## Majors

### M1. Rollout bullet contradicts itself

*   **Severity:** Major
*   **Affected Scope:** Non-Functional Requirements, Rollout & Rollback (line 160)
*   **Discrepancy & Rationale:** "Everything ships off by default locally" is followed by "`RESOLVE_BASELINE` defaults to `on`" and "The one behaviour change everywhere is the sign-in on routes to Resolve." Neither of those is off by default, so the opening claim is false as written. Suggested wording: "Locally, the reset is off unless `COUNTERSIGN_DEMO_RESET=on`, and `RESOLVE_BASELINE` defaults to `on` (phase 8 behaviour). The sign-in on console routes to Resolve applies everywhere." That keeps the facts and drops the absolute claim.

### M2. "Types ... values once" conflicts with Alternative F

*   **Severity:** Major
*   **Affected Scope:** Technical Plan, Hosting (line 85); Alternative F (lines 142-146)
*   **Discrepancy & Rationale:** Line 85 says "the owner types PayPal, Gemini, webhook and vault values once." Alternative F's only Pro is "Each secret typed once", and the chosen design rejects it. ADR 0041 also has `PAYPAL_CLIENT_ID` and `PAYPAL_CLIENT_SECRET` entered on four services. So in the chosen design, PayPal values are typed once per service, not once. Either say "once per service that reads them (see `docs/hosting.md`)" or drop "once".

### M3. Alternative F's heading names the wrong thing

*   **Severity:** Major
*   **Affected Scope:** Alternative F heading (line 142)
*   **Discrepancy & Rationale:** "A per-service environment group for shared secrets" mixes up the two options. A Render environment group is shared across services. The per-service setting (`sync: false` on each service) is the option that was chosen, not the one rejected. A reader skimming headings would take away the opposite of the decision. Suggested heading: "Alternative F: One shared environment group for secrets".

### M4. G-3 as stated isn't the goal the document commits to

*   **Severity:** Major
*   **Affected Scope:** Goals G-3 (line 27); Open Questions, Full-seed timing (line 45); CUJ 2 (line 59)
*   **Discrepancy & Rationale:** G-3 says "Reset restores the seed state in ≤ 60 seconds" with no qualifier. Its first measurement is the full 30-order seed. Open Questions then says that if the first reset takes over 60 seconds, "G-3 still holds for every later reset." That redefines the goal after the fact. Also, the second measurement ("only touched orders replaced on later resets (unit tests)") checks which orders are replaced, not how long the reset takes. The goal needs one testable statement, for example: "Every reset after the first finishes in ≤ 60 seconds (live check 1, second and third runs); the first (full) seed's time is recorded, target ≤ 60 seconds." Then the Open Question can point to that statement instead of changing it.

### M5. Goal measurements cite checks that don't cover the goal's clauses

*   **Severity:** Major
*   **Affected Scope:** Goals G-2 (line 26), G-4 (line 28)
*   **Discrepancy & Rationale:** G-2 cites "manual check 5 on Render", but the "and resets" clause is manual check 6. G-4 cites only "`validation.md` check 4", but its clauses are spread across checks. "Only for the approver key" is check 5 (HTTP 401 for a principal key). "Never raises the day's run cap" is check 8. "Only on a database flagged as a demo" (the 404 when the flag is off) is check 5. A goal's "Measured:" line should list every check that proves it, so a reviewer can tick each clause off.

### M6. "A database flagged as a demo" describes a mechanism that doesn't exist

*   **Severity:** Major
*   **Affected Scope:** G-4 (line 28); Security & Privacy, first bullet (line 153)
*   **Discrepancy & Rationale:** The flag is `COUNTERSIGN_DEMO_RESET=on`, an environment variable on the gate service and the `npm run reset` process (requirements.md, "Enabled only when..."). It isn't a property of the database. Line 153's "exist only on a database flagged `COUNTERSIGN_DEMO_RESET=on`" reads as if the database stores a marker, which a new reader could try to implement or audit. State the mechanism directly: "exist only when the gate (or the CLI) runs with `COUNTERSIGN_DEMO_RESET=on`, which the owner sets only for a demo database."

### M7. Quoted UI copy in the CUJs doesn't match requirements.md

*   **Severity:** Major
*   **Affected Scope:** CUJ 2 Then (line 59); CUJ 3 Then (line 65)
*   **Discrepancy & Rationale:** Line 15 says exact copy is in requirements.md, but the CUJs quote strings that are presented as copy and differ from it.
    *   CUJ 2 quotes "Reset in 14s. Replaced 4 orders and kept 26." In the same sentence it says an open dispute is recorded again. Under requirements.md, a recorded dispute adds "Recorded 1 dispute again." to that line, so the quote contradicts its own scenario.
    *   CUJ 3 says everything else "answers or shows 'Sign in with the approver key.'" requirements.md gives different sentences: on the inbox, "...to see the inbox."; on chat, "...on the start page, then come back."; on the start page, "...to run the scenarios and reset the demo."
    
    Quoted strings in a design get copied into tests. Either quote the exact sentences or describe them without quotation marks ("a sign-in prompt").

### M8. Terms on CONTEXT.md's _Avoid_ lists

*   **Severity:** Major
*   **Affected Scope:** Overview (line 11); CUJ 1 Then (line 53); Alternative A Pros (line 114)
*   **Discrepancy & Rationale:** CONTEXT.md is the project's terminology standard, and this section uses several terms it says to avoid:
    *   "a hold with reason codes" and "the held refund" (line 53). For **Step-up**, CONTEXT.md lists "hold" under _Avoid_. Use "a step-up" and "the stepped-up refund" (or "the refund waiting for approval").
    *   "The wipe isn't on a public service" (line 114). For **Demo reset**, CONTEXT.md lists "wipe" under _Avoid_. Use "The reset".
    *   "step-ups go to a phone card" (line 11) and "The phone card approves" (line 53). The defined term is **Step-up card**. Line 53 also makes the card the actor; the judge approves on the card.

---

## Nits

### N1. Undefined shorthand and jargon

*   **Severity:** Nit
*   **Affected Scope:** Lines 11, 25, 36, 39, 85, 95, 140
*   **Discrepancy & Rationale:** Several terms appear without definition in this document or in CONTEXT.md:
    *   "beat", in "every PayPal beat of the demo" and "the dispute beat". It comes from the brief's video structure.
    *   "the three Countersign keys" and "the support key". CONTEXT.md's term is **Principal key**, and the three keys are named only in ADR 0041.
    *   "single-flight".
    *   "head", in "clearDemoTables (head, ...)". CONTEXT.md's term is **Chain head**.
    *   "carry run counts".
    *   "pins" or "pinned", for what a test does.
    
    For a fresh reader, either name the thing once (for example, "the support-agent, ops-agent and approver keys") or use the CONTEXT.md term.

### N2. The Overview's opening sentence is overloaded

*   **Severity:** Nit
*   **Affected Scope:** Overview (line 11)
*   **Discrepancy & Rationale:** One sentence lists five phases, each with a parenthetical number, and then two more sentences each quote the brief. Splitting it would help: one sentence on the current state ("Phases 7 to 12 work locally"), then a short list or sentence on what this phase adds.

### N3. Open Questions holds a process note, and one bullet isn't a question

*   **Severity:** Nit
*   **Affected Scope:** Open Questions (lines 43-44)
*   **Discrepancy & Rationale:**
    *   "No fresh sessions were available to the planner..." is a note about how the document was produced and an instruction to reviewers. It isn't a design question. It belongs in the header (Status) or a reviewer note.
    *   "Render's private network from a cron job." is a fragment. Phrase it as a question: "Can a Render cron job reach a private service?"
    *   "the sync line says so" refers to output that isn't described anywhere in the target.

### N4. Vague or figurative phrasing in The Problem

*   **Severity:** Nit
*   **Affected Scope:** The Problem (lines 19, 21)
*   **Discrepancy & Rationale:**
    *   "the second judge finds the first judge's refunds already spent". The captures are already refunded; refunds aren't "spent". Say "finds the seeded captures already refunded".
    *   "a start page that tells the story in a minute" is figurative. Say "a start page with a five-step guide that takes about a minute to read" (ADR 0043's wording).
    *   "against §8's ..." means "contrary to"; "which §8 forbids" is clearer.

### N5. Subjective and figurative wording in Alternative B

*   **Severity:** Nit
*   **Affected Scope:** Alternative B (lines 120-121)
*   **Discrepancy & Rationale:**
    *   "simplest to describe" is a subjective claim with no measure behind it. "One rule: every reset is a fresh seed run" says the same thing as a fact.
    *   "it orphans the pre-opened dispute" is figurative. Say "the pre-opened dispute is left on an order that's no longer in `seed_orders`".

### N6. Alternative D's option labels drift

*   **Severity:** Nit
*   **Affected Scope:** Alternative D (lines 130-134)
*   **Discrepancy & Rationale:** The two options are called "fully" and "not at all" in the heading, "Fully offered" and "not offered" in Pros, and "Full" and "none" in Cons. "none cuts brief §5 item 6" reads as "neither option cuts it", which is the opposite of what's meant. Pick one pair of labels, for example "Full" and "None", and write "None would cut brief §5 item 6".

### N7. CUJ 4 points to a sentence without giving it

*   **Severity:** Nit
*   **Affected Scope:** CUJ 4 Then (line 71)
*   **Discrepancy & Rationale:** "(or the execution sentence)" makes the reader look it up. Quote it ("Countersign is carrying out an approved action. Try again in a minute.") or say "or the matching sentence for an execution in flight".

### N8. Performance figures are unmeasured estimates stated as facts

*   **Severity:** Nit
*   **Affected Scope:** Performance & Latency (line 158)
*   **Discrepancy & Rationale:**
    *   "milliseconds on a demo-sized log" and "a few seconds" have no source. Mark them as estimates ("expected") and point to live check 1, which records `took_ms`.
    *   The bullet never states the 60-second bound.
    *   The 120-second console wait isn't explained against that bound. Add a clause such as "twice the 60-second target, so a slow first seed still reports".

### N9. AI cost bullet repeats Security & Privacy

*   **Severity:** Nit
*   **Affected Scope:** AI cost (line 159) versus lines 154 and 157
*   **Discrepancy & Rationale:** "the launcher and chat need the key" and "the console holds no Gemini key" are already stated two bullets earlier. Keep each fact in one place, for example: "AI cost. Unchanged per run; the day's cap carries across resets (see Security & Privacy for the sign-in and the console's key)."

### N10. The stated mitigation doesn't address the stated risk

*   **Severity:** Nit
*   **Affected Scope:** Security & Privacy, first bullet (line 153)
*   **Discrepancy & Rationale:** The risk is "a key holder can reset during another judge's session". "One reset at a time" stops two resets overlapping, but it doesn't stop a reset during someone else's session. Present it as what it is: "Bounded now by one reset at a time; phase 15's rate limits reduce it. Accepted for the judging window."

### N11. Imprecise labels in the two diagrams

*   **Severity:** Nit
*   **Affected Scope:** Architecture diagram (lines 77-81); reset flow (line 90)
*   **Discrepancy & Rationale:**
    *   The "judge's phone" arrow sits on the "/  start page" row, which suggests the phone opens `/`. The phone opens `/approvals`.
    *   "gate code, Resolve nudge" doesn't say what the cron runs. Say "`npm run reconcile`, `disputes -- sync`".
    *   In the reset flow, "not running" means "no other reset running". Say so.

### N12. Grammar and informal verbs in G-4 and G-5

*   **Severity:** Nit
*   **Affected Scope:** G-4 (line 28), G-5 (line 29)
*   **Discrepancy & Rationale:**
    *   In G-4, "leaves a chain `ledger verify` passes" is missing "that".
    *   G-5's "Nothing public spends AI or touches baseline" uses informal verbs. Say "No public route starts an agent run or a baseline run without the approver key".

### N13. Modes used as grammatical subjects

*   **Severity:** Nit
*   **Affected Scope:** CUJ 1 Then (line 53)
*   **Discrepancy & Rationale:** "Baseline refunds through PayPal's tools directly; protected shows denials" makes the modes the actors. Say "In baseline mode the agent refunds through PayPal's tools directly; in protected mode the thread shows denials and a step-up with reason codes."

### N14. Additional Resources is incomplete

*   **Severity:** Nit
*   **Affected Scope:** Additional Resources (line 169)
*   **Discrepancy & Rationale:**
    *   The ADR list leaves out ADR 0039, which the Non-Goals cite (line 37).
    *   It gives bare numbers, while lines 15 and 166-168 link their sources. Link them, or say where they live (`docs/adr/`).

### N15. "The seed catalog and run move" is ambiguous

*   **Severity:** Nit
*   **Affected Scope:** Technical Plan (line 104)
*   **Discrepancy & Rationale:** A **Seed run** (CONTEXT.md) is one execution of the script, and an execution can't move. What moves is the code. Say "The seed catalog and the seed-run code move to `@countersign/seed`".

### N16. "Decisions and audit log" is redundant

*   **Severity:** Nit
*   **Affected Scope:** CUJ 2 Then (line 59)
*   **Discrepancy & Rationale:** Decisions are audit-log entries. "the inbox, decisions and audit log are empty except entry 1" lists the same store twice. Say "the inbox is empty and the audit log holds only entry 1, a `demo.reset` ...". Or, if the Decisions page is meant, say "the Decisions page".

### N17. An unverifiable claim in the Non-Goals

*   **Severity:** Nit
*   **Affected Scope:** Non-Goals, smoke test and uptime monitor (line 35)
*   **Discrepancy & Rationale:** "The blueprint leaves room for them" gives the reader nothing to check. ADR 0041 says what it means: "Phase 19 adds the smoke-test cron and the uptime monitor to the same file." Use that sentence.
