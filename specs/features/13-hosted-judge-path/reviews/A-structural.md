# Round A: structural review

*   **Reviewer:** Structural Goldfish (`.ralph/egm/agents/structural.md`, Mode: REVIEW)
*   **Standard:** `.ralph/egm/standards/feature-spec-standard.md`
*   **Target:** `specs/features/13-hosted-judge-path/design.md`, lines 1-177 (above `## Detailed Implementation Plan`)
*   **Read:** the target range, its linked files (ADRs 0041, 0042, 0043, `CONTEXT.md`), brief §8 and §10.

## Structure map

```text
H1  Phase 13: the hosted judge path                     (1)
    metadata list, rule                                 (3-7)
H2  Overview                                            (9)
H2  The Problem                                         (17)
H2  Goals                                               (23)
H2  Non-Goals                                           (31)
H2  Open Questions                                      (41)
H2  Critical User Journeys (CUJs)                       (47)
H3    CUJ 1 .. CUJ 4                                    (49, 55, 61, 67)
H2  Technical Plan (Architecture)                       (73)
H2  Alternatives Considered                             (110)
H3    Alternative A .. F                                (112-146)
    rule                                                (148)
H2  Non-Functional Requirements                         (150)
    rule                                                (162)
H3    Additional Resources   (nests under NFR)          (164)
H3    Future Improvements    (nests under NFR)          (171)
    rule                                                (176)
```

Standard blueprint against the map: Problem Statement (The Problem, present), Goals & Non-Goals (present), Proposed Architecture (Technical Plan, present), Alternatives Considered (present, six entries in a consistent Pros / Cons / Reason for Rejection form), Risks & Mitigations (no section).

## Findings

### 1. No Risks & Mitigations section

*   **Severity:** Major
*   **Affected Scope:** Whole range; risk material is scattered across Non-Goals (39), Open Questions (43-45), the reset diagram (90-99) and Non-Functional Requirements, Security & Privacy (153).
*   **Discrepancy & Rationale:** The standard names Risks & Mitigations as a required area and its Risks & Limits section requires failure modes, security implications, scalability limits and their mitigations to be called out explicitly. The document has no such heading. Only one bullet (153) uses an explicit "Risk: ... Mitigation: ..." form. Other risks are present but unlabelled and unmitigated in one place: the single-instance scalability limit (39, 174), a partial reset after commit (`complete: false`, 99), the cron job failing to reach the private Resolve service (44), a first full seed over 60 seconds (45), a PayPal sandbox outage mid-reset, the approver key spreading beyond judges (155), and a dispute left on a replaced order (ADR 0042 consequences, not mentioned here). A fresh reader can't confirm all major risks are addressed without assembling them from four sections and three ADRs. Add an H2 `## Risks & Mitigations` (before or after Non-Functional Requirements) listing each risk with its mitigation or acceptance.

### 2. Additional Resources and Future Improvements nest under Non-Functional Requirements

*   **Severity:** Major
*   **Affected Scope:** Lines 162-175.
*   **Discrepancy & Rationale:** `### Additional Resources` and `### Future Improvements` are H3s whose nearest H2 is `## Non-Functional Requirements` (150). The horizontal rule at 162 separates them visually but not in the heading tree, so any outline, table of contents or heading-scoped tool files them as subsections of NFR. Neither is a non-functional requirement. Every other main section in the range is an H2; these two should be H2 as well (or grouped under an explicit H2 such as `## Appendix`).

### 3. Architecture diagram omits core data flows and misplaces the public gate

*   **Severity:** Major
*   **Affected Scope:** Technical Plan (Architecture), diagram at lines 75-83.
*   **Discrepancy & Rationale:** The standard asks Proposed Architecture to show component layout and data flows. The diagram leaves out the flows the rest of the design depends on: Resolve to the gate's `/mcp` (`GATE_MCP_URL`, ADR 0041, the path every protected run takes), the gate's dispute nudge to Resolve (85, 100), every service's connection to `countersign-db`, and the gate's, Resolve's and storefront's calls to the PayPal sandbox API (baseline mode's direct path in CUJ 1 is the demo's key contrast). Its layout also contradicts the text: `countersign-gate (web)` sits under the "Render private network" header although it is a public web service that receives PayPal webhooks (79; ADR 0041 "web, public"), and the judge's phone arrow points at the console's `/ start page` (78) while CUJ 1 has the phone open Approvals. `countersign-reconcile ... ─▶ gate code` (81) is ambiguous: the cron runs gate code in its own process rather than calling the gate. Redraw with public and private columns that match each service's exposure and an arrow per flow named in the text.

### 4. Open Questions holds items that aren't questions, ahead of the design they refer to

*   **Severity:** Nit
*   **Affected Scope:** Open Questions, lines 41-45.
*   **Discrepancy & Rationale:** The first bullet (43) is a process caveat about the planner's session, not an open question about the design. The third (45) is a stated risk with its fallback already decided. Only the second (44) is open, and it is answered by live check 9. The section also sits before CUJs and the Technical Plan, so it refers to the cron job, `RESOLVE_AGENT_HOSTPORT` and the dispute nudge before they're introduced. Move the process note to the metadata block or Overview, move the timing item to Risks & Mitigations (finding 1), and place Open Questions after the Technical Plan.

### 5. References aren't linked consistently

*   **Severity:** Nit
*   **Affected Scope:** Lines 26-29, 37, 39, 44, 106, 120, 156, 166-169.
*   **Discrepancy & Rationale:** ADRs 0041-0043 are linked (15), but ADRs 0022, 0023, 0030, 0031, 0032, 0035 and 0038 appear only as bare numbers (169), and ADR 0039 (37) is cited in the body yet absent from Additional Resources, as are 0041-0043 themselves. Goals cite "manual check 5", "`validation.md` check 4" and Open Questions "live check 9" with no link or anchor into `validation.md`. Brief §14 is cited (13) but missing from the brief's section list at 166. Link each ADR on first mention and make Additional Resources the complete list.

### 6. "Gate G2" collides with goal "G-2"

*   **Severity:** Nit
*   **Affected Scope:** Overview line 11; Goals line 26.
*   **Discrepancy & Rationale:** The Overview names roadmap gate "G2" and the Goals section numbers its own goals "G-1" to "G-5". A fresh reader can easily read "gate G2" as goal G-2 (a different statement). Qualify the roadmap gate (for example "roadmap gate G2") or use a distinct goal prefix.

### 7. Alternative headings are asymmetric or mislabelled

*   **Severity:** Nit
*   **Affected Scope:** Alternative D (130-134), Alternative F (142-146).
*   **Discrepancy & Rationale:** Alternative D bundles two opposite options ("fully, or not at all") under one heading, so its Pros and Cons each mix both and need "Full ..." / "none ..." prefixes to parse; every other entry is one option. Split it into two entries. Alternative F's title, "A per-service environment group", contradicts its own point: an environment group is shared across services, and the per-service option is what the design chose. Rename it (for example "A shared environment group for secrets").

### 8. Alternatives don't cover three sub-decisions the design makes

*   **Severity:** Nit
*   **Affected Scope:** Alternatives Considered (110-146) against Technical Plan (104-108).
*   **Discrepancy & Rationale:** The Alternatives Rule asks that rejected designs be documented. Three choices have none: the launcher's transport (a new Resolve route `POST /scenarios/:id`, 106, versus the console sending the scenario's text through the existing messages route), the run-cap carry-over table `cleared_run_counts` (108, versus not truncating `agent_runs`), and an owner-only reset CLI, which ADR 0042's own steelman raises but this document doesn't list beside Alternative A. One line each would close the gap.

### 9. G-3's measure and the Open Question disagree on what passes

*   **Severity:** Nit
*   **Affected Scope:** Goals G-3 (27); Open Questions (45).
*   **Discrepancy & Rationale:** G-3 is measured by `reset-live.test.ts`'s `took_ms` for a full 30-order seed, but line 45 says G-3 "still holds" if that same measurement exceeds 60 seconds. The goal's stated measure is therefore not its pass criterion. State which reset (first or later) the ≤ 60-second bound applies to, and measure that one.

### 10. Document status and ADR status disagree

*   **Severity:** Nit
*   **Affected Scope:** Metadata (4); Open Questions (43); linked ADRs 0041-0043.
*   **Discrepancy & Rationale:** The design is `Draft` and asks round A to "treat all three decisions as contested", while each linked ADR is `Status: accepted`. A fresh reader can't tell which is authoritative. Mark the ADRs proposed until round A closes, or say in the design that "accepted" is provisional.

### 11. Bold-label punctuation varies by section

*   **Severity:** Nit
*   **Affected Scope:** Goals (25-29), CUJs (51-71), Technical Plan (85-108), Alternatives (114-146), NFR (152-160).
*   **Discrepancy & Rationale:** CUJs and Alternatives use `**Label**:` (colon outside the bold); Goals, Technical Plan and NFR use `**Label.**` (period inside). Pick one form per list type and apply it throughout.
