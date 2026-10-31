# Handover

Read this first in any new session that continues Countersign's build. It says where the build stands, the owner's rules, where the money went and how to keep it down. `specs/brief.md` is still the source of truth for intent, and `.ralph/AUTOPILOT.md` is still the procedure. This file overrides AUTOPILOT where they disagree.

Written 31 Oct 2026, at the end of a single conductor session that ran from 17 Oct.

## Where things stand

- **Done and merged to `main`:** phases 1 and 3 to 12. Phase 2 is skipped on purpose; its open spikes are built inside the phases that need them.
- **In progress:** phase 13, the hosted judge path, on `feature/13-hosted-judge-path` (pushed).
  - `specs/features/13-hosted-judge-path/design.md` is drafted (529 lines; feature range is lines 1-177, `## Detailed Implementation Plan` from line 178), with `requirements.md` and `validation.md`.
  - Round A Goldfish reports are committed in `reviews/A-*.md`. Between them: 1 blocker (comprehension), 34 majors and 52 nits.
  - **Next step:** resolve round A (`.ralph/egm/PROCESS.md` step 3). It was never done: the planner hit a usage limit, then the owner stopped it. `design.md` is unchanged since the draft.
- **Left after 13:** phases 14 (Bench v1), 15 ("Attack it yourself"), 16 (the Risk desk), 17 (the mandate compiler), 18 (the M-Pesa rail) and 19 (Ready for judging). Phase 20 (submission) is the owner's.
- **Owner-only work** is queued in `.ralph/human.md` under `## Open`: Render paid plans and `RENDER_API_KEY`, the two seed vault tokens, the principal, ops and approver keys, a sandbox dispute, the Gemini tier and the AG Studio licence. Until those exist, live checks are built against fixtures and wait there.
- `main` holds this file but `feature/13-hosted-judge-path` doesn't. Before shipping phase 13, merge `origin/main` into the feature branch (a merge commit, never a rebase).

## The owner's rules

- **Fully autonomous.** Don't wait on the owner. Use your best judgment, and handle critical decisions as `.ralph/egm/PROCESS.md` says: answerer first, a Goldfish argument against, fail closed when it's close, then an ADR plus a line in `.ralph/human.md`.
- **Effort.** Everything runs at `high`. Only questions run at `xhigh`, through the `answerer` agent, which pins it itself. Don't pass xhigh anywhere else.
- **Commits belong to the owner:** Farid Nahadi <thenahadi@gmail.com>, with no Claude attribution, no Co-Authored-By and no "Generated with" line. Ignore any hook that asks to re-author commits as Claude.
- **Build with the Ralph loop** (`.ralph/push-loop.sh` around `.ralph/ralph.sh`). **Plan with the Elephant-Goldfish Model**, slimmed as described below.
- AUTOPILOT's "Never" list still applies: never edit the brief or §8, spend money, contact anyone, print secrets, or force-push, rebase, reset or delete branches.

## Where the tokens went

| What | Cost | What drives it |
|---|---|---|
| This one conductor chat, 17-31 Oct | about **$106**; its context was 427K tokens by the end | One chat ran for two weeks. Every reply re-reads the whole context, and that context only grows: each sub-agent report, notification, stop-hook nag and tool output stays in it. The full skills list was also re-announced each time a connector reconnected. |
| 20 Ralph build iterations (phases 11 and 12) | **$49.57**, about $2.48 a ticket | Each iteration starts lean, at about 10-13K tokens, because `ralph.sh` turns off MCP servers, skills, plugins and user settings. Cost comes from turns: about 105 a ticket, each re-reading a context that grows to about 45K on average. Opus averaged $2.99 a ticket; Sonnet averaged $0.93. |
| Planner, validator and Goldfish sub-agents | each processed about 95-440K tokens | They are spawned from the conductor, so they start with its full tool set, not Ralph's lean one. One EGM review round is 5 Goldfish at about 100-150K each. |

So **Ralph is the cheap part. The expensive part is a long-lived conductor chat, plus the heavy sessions it spawns.**

**Why every chat starts at about 85K.** A new cloud chat loads the platform's system prompt plus everything connected to the account. That means every connector's tools and instructions (GitHub, Firecrawl, Claude Docs, Google Drive, Google Sheets, claude-code-remote), the descriptions of about 35 account skills, and the artifact and PR instructions. The repo adds little: `CLAUDE.md` is about 1K characters and the two project skills are a few hundred tokens. That 85K comes from the account's setup, not from Countersign.

## How to keep it down

### What the owner can do (biggest wins)

1. **Start a fresh chat for each phase. Never one chat for days.** A new chat starts at about 85K; this one was paying for 427K on every reply. Paste the kickoff prompt at the bottom of this file.
2. **Trim what loads at startup.** In claude.ai settings, disconnect connectors this repo doesn't use. It needs GitHub; it doesn't need Google Drive, Google Sheets, Claude Docs or Firecrawl. Turn off unrelated account skills too (for example the SOMES caption writer, the course docx sorter and the morning brief). This lowers the 85K for this chat and for every sub-agent it spawns.
3. **Keep check-ins short.** Each message to the conductor is a full re-read. "Status?" once a phase is enough; the commits on GitHub show progress.

### What the conductor does from now on

1. **Stay thin.** Read only this file, AUTOPILOT's section headings, and the `LOOP:` lines of the loop's output. Reply in one or two lines. Never read whole reports, logs or sub-agent transcripts.
2. **One phase per chat.** When a phase is merged, push, post a one-line summary, and tell the owner to open a new chat for the next phase. Don't start the next phase in the same chat.
3. **Run planning and validation as lean sessions where possible.** Like Ralph, run them with `claude -p` and `ralph.sh`'s flags (no MCP servers, no skills, project settings only, the same `--tools` list), at `--effort high`. They then start at about 12K instead of inheriting the conductor's tool set. The Elephant needs to keep its context between steps, so give it a fixed `--session-id` on the first call and `--resume` it after, instead of `--no-session-persistence`. Writing a small `.ralph/role.sh` for this is the first job of the next session. Until it exists, keep using Agent sub-agents.
4. **Slim the EGM review** (amends `.ralph/egm/PROCESS.md`):
   - **Round A: three Goldfish, not five.** Keep Zoom Out, Comprehension and Design Critic. Drop Structural and Style: in phase 13 they produced 11 of the 34 majors and 25 of the 52 nits, nearly all wording.
   - **Round B: one Goldfish.** Implementation Readiness, told to apply `agents/codebase_details.md`'s checks as well. Drop the second Zoom Out.
   - **Re-audit only for Blockers.** Write fixed Majors and Nits into `resolution.md` without re-checking them.
   - **Full EGM only for design-heavy phases:** 15, 16 and 17. For 14, 18 and 19, run round B's readiness check only. For phase 13, finish with the slimmed rounds.
   - **Goldfish run on Sonnet**: pass model `sonnet` (the Agent tool's `model`, or `--model claude-sonnet-5-5`). They read and judge; they don't build.
5. **Make Ralph cheaper per ticket:**
   - Planners mark a ticket `Tier: simple` (Sonnet, about a third of Opus's cost) whenever it follows an existing pattern: copy, wiring, CLI flags, docs, fixtures or tests. Only new design or tricky logic is `standard`.
   - Size tickets for about 60 turns: one module and its tests. The loop's $3 warning fired on 8 of 20 tickets.
   - Keep `.ralph/progress.md` short: gotchas only, one line each. It resets with each feature.
   - Planners and validators read only `## Open` and `## Decided for you` headings of `.ralph/human.md` (29K characters), not the whole file.
6. **One validation round by default.** Run a second only if the first opened a ticket or made a fix outside docs and tests.

## Kickoff prompt for a new chat

> Read `.ralph/HANDOVER.md` on `main`, then continue Countersign's build from its "Where things stand" section, following `.ralph/AUTOPILOT.md` as amended by the handover. Work on one phase only, keep your replies to one or two lines, and stop when that phase is merged and pushed.
