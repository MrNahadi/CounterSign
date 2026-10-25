# Planning with the Elephant-Goldfish Model

From phase 13 on, the autopilot plans each feature with the Elephant-Goldfish Model (EGM), and the Ralph loop builds it as before. EGM is Google's spec-review method: an Elephant session that holds the design context drafts a design doc, and fresh Goldfish sessions with no history try to break it before any code is written. Source: https://github.com/google/elephant-goldfish-model (Apache-2.0). The reviewer personas and standards in `agents/` and `standards/` are copied from it unchanged; see `NOTICE.md`.

The plugin's own `/egm-review` and `/egm-resolve` are human-only and stop for a person at every stage, so the autopilot runs the same pipeline itself, without stopping. Nobody waits on the owner (brief §14).

## Roles

- **Elephant**: one planner sub-agent per feature. The conductor resumes the same agent (SendMessage) for drafting, resolving and ticketing, so it keeps its reasoning. It never writes product code.
- **Goldfish**: a fresh `general-purpose` sub-agent per reviewer, with no conversation history. Each reads its persona file and standard, reviews the design doc, writes one report file and changes nothing else.
- **Conductor**: spawns them, passes findings between them, and keeps its own context small (it reads the counts each Goldfish replies with, not whole reports).

The Elephant, the Goldfish and the build iterations run at effort `high`. Only questions run at `xhigh`: the `answerer` agent pins it in `.claude/agents/answerer.md`.

## The pipeline

All files live in the feature folder, `specs/features/NN-slug/`.

### 1. Draft (Elephant)

The planner does Phase 6 (replan) as before, then writes `design.md` from `design-template.md`, plus `requirements.md` and `validation.md`. No tickets yet. `design.md` must have a `## Detailed Implementation Plan` heading. Everything above it is the feature range and everything below it is the detailed range. Commit `docs(NN): design draft`.

### 2. Review round A: is the design right? (Goldfish, in parallel)

| Reviewer | Persona | Standard | Range |
|---|---|---|---|
| Zoom Out | `agents/zoom_out.md` | `standards/zoom-out-standard.md` | whole doc |
| Comprehension | `agents/comprehension.md` | `standards/re-implementation-standard.md` | whole doc |
| Design Critic | `agents/design_critic.md` | `standards/feature-spec-standard.md` | feature range |
| Structural | `agents/structural.md` | `standards/feature-spec-standard.md` | feature range |
| Style | `agents/style.md` | none | feature range |

### 3. Resolve round A (Elephant)

The Elephant reads the round A reports and, for each finding, decides **PROPOSE FIX** (valid: edit `design.md`) or **CONTEST** (wrong: cite the brief, an ADR, the code or the doc). It applies every PROPOSE FIX itself; that is the autonomous stand-in for the plugin's human gate. It logs each finding, its call, why, and the edit in `reviews/resolution.md`. Commit `docs(NN): design review round A`.

### 4. Review round B: can a fresh session build it first time? (Goldfish, in parallel)

| Reviewer | Persona | Standard | Range |
|---|---|---|---|
| Zoom Out (again) | `agents/zoom_out.md` | `standards/zoom-out-standard.md` | whole doc, checking round A's changes |
| Implementation Readiness | `agents/implementation_readiness.md` | `standards/implementation-readiness-standard.md` | detailed range |
| Codebase Details | `agents/codebase_details.md` | `standards/implementation-readiness-standard.md` | detailed range |

The readiness reviewer ends its report with `GO` or `NO-GO`.

### 5. Resolve round B (Elephant)

The same as step 3. Commit `docs(NN): design review round B`.

**Re-audit cap.** After each round, rerun once only the reviewers that raised a Blocker the Elephant fixed, to confirm it holds. Anything still open after that is written into `reviews/resolution.md` as an accepted trade-off with its reason. The cap is EGM's own (one re-audit per stage).

### 6. Tickets (Elephant)

The Elephant turns the Detailed Implementation Plan into `tickets.md` (`.claude/skills/spec-ralph/references/ticket-format.md`). Each ticket names the files it touches, taken from the design, and is small enough for one iteration under about $3. It installs pinned dependencies, writes `.ralph/current-feature` and the `.ralph/progress.md` header, runs the four Feedback commands, and commits `docs(NN): feature spec`. The Ralph loop starts from there.

## Critical decisions

The Elephant decides alone, using brief §10's ranked trade-offs. A decision is **critical** when it touches §8's non-negotiables, moves money or changes what can move it, handles secrets or authentication, fixes an external contract (PayPal, Render, Daraja, Gemini), or changes what a judge or user sees, and the brief doesn't settle it. For a critical decision, the Elephant also:

1. Asks the `answerer` agent first.
2. Asks one fresh Goldfish (Design Critic persona) to argue against its chosen option, and records the counter-argument and its answer.
3. Picks the option that fails closed when the two are close.
4. Records an ADR with `Decided-by: autopilot (delegated)` and adds one line to `.ralph/human.md` under `## Decided for you`, so the owner can overturn it later.

It never edits the brief or §8.

## Prompts the conductor sends

**Goldfish** (one per reviewer; fill the angle brackets):

> You are a Goldfish reviewer for Countersign. You have no history with this project. Read `.ralph/egm/agents/<persona>.md` and follow it with `Mode: REVIEW`. Apply `.ralph/egm/standards/<standard>.md` <if any>. Target: `specs/features/<NN-slug>/design.md`, <range>. Read only what the document links, plus `specs/brief.md` §8 and §10, `CONTEXT.md` and any ADR it names. The persona's read-only rule stands, with one exception: write your findings to `specs/features/<NN-slug>/reviews/<round>-<reviewer>.md`, each with Severity (Blocker, Major or Nit), Affected Scope and Discrepancy & Rationale. <Readiness only: end with a line `GO` or `NO-GO`.> Don't commit. Reply with one line only: `<reviewer>: <b> blockers, <m> majors, <n> nits` <readiness: `, GO|NO-GO`>.

**Elephant, resolving**:

> Round <A|B> reports are in `specs/features/<NN-slug>/reviews/<round>-*.md`. Resolve them as `.ralph/egm/PROCESS.md` steps 3 and 5 say: PROPOSE FIX or CONTEST for each finding, apply every fix to `design.md` (and `requirements.md` or `validation.md` where they follow), log everything in `reviews/resolution.md`, and treat critical decisions as the Critical decisions section says. Commit `docs(NN): design review round <A|B>`. Don't push. Reply with one line: fixes, contests, and the reviewers whose Blockers you fixed.
