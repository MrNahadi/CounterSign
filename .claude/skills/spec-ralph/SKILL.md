---
name: spec-ralph
description: Spec-driven build from a project brief to working code. Gets specs/brief.md to standard, derives a constitution, plans each feature as tickets, then hands implementation to an unattended Ralph loop with an answerer agent that resolves questions from the brief, the specs and the web. Use when starting or resuming a spec-driven build, or when the user mentions brief.md, SDD or Ralph loops.
disable-model-invocation: true
---

# Spec Ralph

You run a spec-driven build in phases. The human does the thinking at the start and the review at the end. A Ralph loop does the implementation in between, one ticket per fresh session.

Every phase ends at a gate. Don't cross a gate without the human's approval unless the brief's Working agreement makes that gate automatic.

Paths below like `templates/brief.md` are relative to this skill's folder. Paths like `specs/brief.md` are in the user's repo.

## Files in the repo

```
specs/brief.md               source of truth for intent
specs/brief.original.md      the user's own brief, kept verbatim if you restructured it
specs/mission.md             constitution: why, for whom, scope
specs/tech-stack.md          constitution: stack, conventions, Feedback commands
specs/roadmap.md             constitution: phases, one feature each
specs/features/NN-slug/      plan.md, requirements.md, validation.md, tickets.md
CONTEXT.md                   shared glossary
docs/adr/                    decisions, including the answerer's
questions/open/              questions waiting for the human
questions/answered/          questions the human has answered
.ralph/                      PROMPT.md, ralph.sh, current-feature, progress.md, logs/, done
.claude/agents/answerer.md   the answerer sub-agent
```

## Start here: find the current phase

Check in this order and start at the first phase that isn't finished:

1. No `specs/brief.md`, or it fails the audit in `references/brief-standard.md` → Phase 0.
2. Any of `specs/mission.md`, `specs/tech-stack.md`, `specs/roadmap.md` missing → Phase 1.
3. `.claude/agents/answerer.md` missing, or the Feedback commands in `tech-stack.md` don't all pass → Phase 2.
4. `.ralph/done` exists → Phase 5 for the feature in `.ralph/current-feature`.
5. The current feature has tickets that aren't done and there's no `.ralph/done` → the loop is mid-run or was stopped. Say so and give the resume command.
6. Otherwise → Phase 3 for the next unticked roadmap item.

Tell the human in one line which phase you're starting and why.

## Phase 0: the brief

Goal: `specs/brief.md` passes every check in `references/brief-standard.md`.

**No brief.** Ask whether they have one to paste or attach. If not, build it with them from `templates/brief.md`, one section at a time, using the grilling skill if it's installed. For sections like Glossary or Tech preferences you may offer a draft for them to correct. Goals, Scope, Ranked trade-offs and Definition of done must come from the human.

**Existing brief.** Audit it and show the score table. Then save their file untouched as `specs/brief.original.md`, move the content into the template structure keeping their wording, and ask only about sections scored Weak or Missing. Don't re-ask anything the brief already answers.

**Brownfield repo.** Before asking anything, read the code, README, TODO files and recent git log. Prefill Tech preferences, Non-negotiables and Glossary from what the code already does, marking those lines `(from code, confirm)`.

Gate: show the final table, all Pass, and ask for approval. Commit on main: `docs: add project brief`.

## Phase 1: constitution

Derive from the brief:

- `specs/mission.md`: summary, users, goals, in scope, out of scope.
- `specs/tech-stack.md`: stack with pinned versions, project layout, conventions, and a `## Feedback commands` section listing the exact typecheck, lint, test and build commands. Mark them TODO if the project doesn't exist yet.
- `specs/roadmap.md`: small numbered phases, each one user-visible feature, as checkboxes. On a greenfield project phase 1 is always the scaffold: the app runs, one test passes, every Feedback command works.
- `CONTEXT.md`: glossary seeded from the brief.

Install the answerer now (Phase 2, step 1) so it can resolve anything the brief leaves open. Send those questions to it rather than deciding them silently. The human is present in this phase, so show escalations to them straight away instead of filing them.

Gate: the human reviews all four files. Commit: `docs: add constitution`.

## Phase 2: loop readiness

The loop runs with nobody watching, so check all of this before any feature starts. Fix what you can and list what only the human can do.

1. Copy `templates/answerer.md` to `.claude/agents/answerer.md`.
2. Copy `templates/PROMPT.md` to `.ralph/PROMPT.md` and `scripts/ralph.sh` to `.ralph/ralph.sh`, then `chmod +x .ralph/ralph.sh`.
3. Merge `templates/settings.json` into `.claude/settings.json`. Replace the four `REPLACE_*` entries with the real Feedback commands. Show the human the allow, ask and deny lists and get approval before writing.
4. Add `.ralph/logs/` and `.ralph/done` to `.gitignore`.
5. Every Feedback command must pass on a clean checkout. On a greenfield repo that means building the scaffold (roadmap phase 1) now, interactively, with the human watching, and ticking it off the roadmap. A loop with no tests has no way to tell working code from broken code.
6. List anything only the human can provide: accounts, API keys, secrets, hardware, paid services. Use the wizard skill if it's installed. The loop never creates credentials.

Gate: all Feedback commands pass. Commit: `chore: loop readiness`.

## Phase 3: feature spec

1. Take the next unticked roadmap item. Check it still makes sense after the last feature. If not, replan first (Phase 6).
2. From an up-to-date main: `git switch -c feature/NN-slug`.
3. Write `specs/features/NN-slug/`:
   - `plan.md`: approach, modules touched, order of work, any new dependencies.
   - `requirements.md`: behaviour, constraints and technical needs. Leave out detail the agent can work out, such as variable names.
   - `validation.md`: how to prove it works. Automated checks first, then manual checks for the human.
   - `tickets.md`: tracer-bullet tickets in the format in `references/ticket-format.md`.
4. Send open questions to the answerer. The human is present, so show escalations now rather than letting the loop find them later.
5. Install any new dependencies named in `plan.md` now, with the human's approval. The loop can't install packages.
6. Write the feature folder path to `.ralph/current-feature`. Delete any old `.ralph/progress.md`.

Gate: the human approves the tickets, unless the Working agreement makes this automatic. Commit: `docs(NN): feature spec`.

Hand over with the command, using the loop budget from the brief's Working agreement:

```
.ralph/ralph.sh 30
```

Explain in two lines: the number caps iterations, each iteration handles one ticket, and Ctrl-C stops it safely because rerunning resumes from the files.

## Phase 4: the loop

Runs outside this conversation via `.ralph/ralph.sh`. Each iteration is a fresh `claude -p` session reading `.ralph/PROMPT.md`. Never start the loop from inside this conversation.

The script stops on its own when `.ralph/done` appears, when the iteration cap is hit, or after three iterations in a row without a commit.

## Phase 5: validate

Starts when `.ralph/done` exists. Read its first line:

- `COMPLETE`: every ticket is done.
- `WAITING`: the rest are blocked. Continue below, then hand back to the loop.
- `STOPPED`: something was wrong at the start of an iteration. Show the reason and fix it with the human.

Then:

1. Run every Feedback command and every automated check in `validation.md`.
2. Run the code-review skill if installed, on the diff from main, against `requirements.md`. Fix standards issues. List spec gaps for the human instead of guessing.
3. Give the human a short report:
   - tickets done, blocked on questions, and failing
   - each file in `questions/open/`, with its options
   - ADRs with `Decided-by: answerer (inferred)` since the branch started. These are where drift hides.
   - the manual checks from `validation.md`
4. When the human answers a question, write their answer into the question file, move it to `questions/answered/`, and commit. Reset `blocked-failing` tickets they want retried to `open`. Delete `.ralph/done` and give the resume command.

Gate: the human signs off. Commit, then merge to main. The human merges unless the Working agreement says you may.

## Phase 6: replan

On main:

- Tick the roadmap item. Split, merge or reorder upcoming items if the last feature changed the picture.
- If the human's intent changed, update `specs/brief.md` with them and bump its version. Never change the brief on your own.
- If the answerer made the same kind of decision more than once, move it into `tech-stack.md` or `CONTEXT.md` so the question stops coming up.
- Update the changelog if the project keeps one.

Then go back to Phase 3.

## Optional companion skills

If Matt Pocock's skills are installed, use the model-invoked ones: `grilling` for interviews, `domain-modeling` for CONTEXT.md and ADRs, `research` inside the answerer, `tdd` and `code-review` inside the loop, `codebase-design` when planning modules, `wizard` for setup only a human can do. This skill is itself user-invoked, so it doesn't call his user-invoked skills (`grill-me`, `grill-with-docs`, `to-spec`, `to-tickets`, `implement`). Without any of them, the instructions here and in `references/` are enough.

## Rules

- The brief belongs to the human. You may restructure it with their approval. You never change what it means.
- One feature per branch, one ticket per commit.
- Never push, force anything, or merge without the human's say-so.
- Skipping a gate is making a decision on the human's behalf. Don't.
