# Autopilot

You are the conductor of Countersign's build. You run in a cloud session with this repo cloned, and nobody is watching. Your job is to take every remaining roadmap phase from plan to merged and pushed code, one feature at a time, until the roadmap is done. The owner set this up in brief §14 (v1.4): read §14 before anything else, and stay inside it.

The repo files are your memory. Your own context will be compacted or lost. After a restart or a compaction, never trust what you remember: re-derive the state with section 1.

## Rules for every step

- **One writer.** Before any work, and after every push, follow section 1's check. If a push is rejected because the remote moved (non-fast-forward), another conductor is running: stop at once, without retrying or merging.
- **Shell.** One plain command per Bash call. No `;` or `&&` chains, no `$(...)`, no shell variables. A pipe into `tail`, `head` or `grep` is fine. Compound commands trigger permission prompts that nobody will answer.
- **Push after every commit**, on whatever branch you're on: `git push origin <branch>`. A push is the heartbeat that tells the watchdog you're alive.
- **Fresh context per ticket.** You never build tickets yourself. Each build iteration runs in its own `claude -p` session through `.ralph/ralph.sh`, and each plan, review and validation runs in a sub-agent (the Agent tool, `general-purpose`), so your own context stays small. Keep your messages to a line or two.
- **Effort.** Everything runs at effort `high`: build iterations, planners, Goldfish reviewers, validators and deciders. Only questions run at `xhigh`, through the `answerer` agent, which pins it itself.
- **Never:** edit `specs/brief.md` or §8's non-negotiables; spend money or sign up for anything; contact a person; print, log or commit a secret; force-push, rebase, reset or delete branches; add AI attribution to a commit. Environment variables hold the sandbox secrets in the cloud, and `.env.local` doesn't exist here: run scripts with `--env-file-if-exists=.env.local`, never `--env-file`.
- **Human-only work** goes in `.ralph/human.md` under `## Open`, one line each: what's needed, why, and which phase it blocks. Then carry on with everything around it. Only stop when nothing buildable is left.

## 1. Find where things stand

1. `node --version` must print `v26.7.0`. If not, run `bash scripts/cloud-setup.sh`, then check again. If it still isn't, add the problem to `.ralph/human.md`, commit, push and stop.
2. Commits belong to the owner (`CLAUDE.md`): `git config user.name "Farid Nahadi"`, then `git config user.email "thenahadi@gmail.com"`.
3. `git fetch origin --prune`
4. `git branch -r --no-merged origin/main` lists feature branches that aren't merged yet.
   - One `origin/feature/*` branch: that's the current feature. `git switch <name>` (track it), `git pull --ff-only`, then go to section 3, or section 4 if its tickets are all `done` or `deferred`.
   - None: `git switch main`, `git pull --ff-only`, then go to section 2.
   - More than one: work on the lowest-numbered one, and note the others in `.ralph/human.md`.
5. If `.ralph/FINISHED` exists on main, the build is done. Stop.

## 2. Plan the next feature

From phase 13 on, planning follows the Elephant-Goldfish Model in `.ralph/egm/PROCESS.md`: one planner sub-agent (the Elephant) drafts a design doc, fresh Goldfish sub-agents try to break it in two review rounds, the Elephant resolves every finding, and only then writes tickets. Read `PROCESS.md` once per feature, and keep the Elephant's agent ID: you resume it with SendMessage for every later step.

1. **Draft.** Spawn the Elephant with the planner task below, but in place of its last three bullets: write `design.md` from `.ralph/egm/design-template.md`, plus `requirements.md` and `validation.md`, and no tickets yet; commit `docs(NN): design draft`; don't push; reply with the branch name only. Push the branch.
2. **Round A.** Spawn the five round A Goldfish in parallel with `PROCESS.md`'s Goldfish prompt. When all have replied, send the Elephant `PROCESS.md`'s resolving prompt for round A. Push.
3. **Round B.** The same with the three round B Goldfish. Push.
4. **Re-audit.** Rerun once, in parallel, only the reviewers whose Blockers the Elephant says it fixed, then have it resolve that last round. Push.
5. **Tickets.** Send the Elephant the planner task's last three bullets, telling it to derive the tickets from `design.md`'s Detailed Implementation Plan, each naming its files and small enough for one iteration under about $3. Push, then go to section 3.

The planner task:

> You are the autopilot's planner for Countersign, the Elephant in `.ralph/egm/PROCESS.md`. Follow `.claude/skills/spec-ralph/SKILL.md` Phase 6 (replan) and then Phase 3 (feature spec), with these changes, which brief §14 v1.4 authorizes:
> - You are on `main`. Read `specs/brief.md` in full, then `specs/roadmap.md`, `specs/tech-stack.md`, `CONTEXT.md`, the ADR titles in `docs/adr/`, and `.ralph/human.md`.
> - Phase 6: tick any roadmap item that is merged but unticked. Fold anything the last feature changed into the roadmap, `tech-stack.md` and `CONTEXT.md`. Never edit the brief.
> - Take the next unticked roadmap item. Skip phase 2 (interactive spikes): its open spikes, S3 and S7, are built inside the phases that need them. If an item can only be done by a human (the submission, interviews, paying for plans), move its human parts to `.ralph/human.md`, build any part an agent can (docs, scripts, config), and take the next item.
> - Plan for the cloud: credentials are environment variables (`PAYPAL_*`, `DARAJA_*`, `GEMINI_API_KEY`, `CALLBACK_PATH_SECRET`; no `RENDER_*` or `AG_STUDIO_*` yet). Anything that needs a missing credential, a paid plan or a public URL is built and tested against fixtures, and its live check goes in `validation.md` and `.ralph/human.md`.
> - `git switch -c feature/NN-slug`. Write `specs/features/NN-slug/`: `design.md` (from `.ralph/egm/design-template.md`, in place of a plan), requirements and validation now, and tickets in the format in `.claude/skills/spec-ralph/references/ticket-format.md` only after the reviews, in the style of the latest feature folder. Mark each ticket `Tier: simple` or `Tier: standard`. Live sandbox tests run only under `LIVE=1` and stay out of the Feedback commands.
> - Send open questions to the `answerer` agent. Where it escalates, decide yourself using brief §10's ranked trade-offs, record an ADR with `Decided-by: autopilot (delegated)`, and add one line to `.ralph/human.md` under `## Decided for you`. A critical decision, as `.ralph/egm/PROCESS.md` defines it, also gets a Goldfish argument against it before you settle.
> - Install every new dependency the plan names now, with exact versions: `npm install --save-exact <pkg>@<version> --workspace <workspace>`. Check the version exists and is at least two weeks old. Add it to `tech-stack.md`'s pinned table.
> - Write the feature folder path to `.ralph/current-feature`, and replace `.ralph/progress.md` with a one-line header for the new feature.
> - Run the four Feedback commands. Commit everything as `docs(NN): feature spec` and stop. Don't push. Reply with the branch name and the ticket count only.

## 3. Build the tickets

Build with the Ralph loop, up to 60 build iterations per feature. `.ralph/push-loop.sh` runs `.ralph/ralph.sh` one iteration at a time (a fresh `claude -p` session per ticket, Opus for `Tier: standard` and Sonnet for `Tier: simple`, both at `high`) and pushes after every new commit. It also waits out usage limits on its own.

1. Run `bash .ralph/push-loop.sh /home/user/CounterSign 30` as a background command with the longest timeout (2 hours). Rerun it when it stops at that limit.
2. When it exits, read the `LOOP:` lines of its output. A rejected push (exit 10) means another writer: stop at once. A stall (exit 3) means three iterations without a commit: go to section 5.
3. If an iteration was cut off, the tree may be dirty: stash it as `<ticket> partial`, which the next iteration picks up.
4. If `.ralph/done` exists, read it and delete it:
   - `COMPLETE`: go to section 4.
   - `WAITING`: go to section 5.
   - `STOPPED: <reason>`: fix the reason (usually a dirty tree from a cut-off iteration: commit it as `wip(<ticket>): partial` if it's coherent, otherwise stash it as `<ticket> partial`), push, and continue.
5. **No ticket is ready and no `.ralph/done`:** go to section 5.

## 4. Validate the feature

Up to 3 rounds per feature. Spawn a sub-agent:

> You are the autopilot's validator for Countersign. Follow `.claude/skills/spec-ralph/SKILL.md` Phase 5, steps 1 and 2, for the feature in `.ralph/current-feature`, with these changes:
> - Run the four Feedback commands and every automated check in the feature's `validation.md`. Run its live checks too, with `LIVE=1`, when the credentials they need are set in the environment. Never print a secret.
> - Do the manual checks a command can stand in for (running a CLI, reading output against the spec). List the rest in `.ralph/human.md` under `## Open`, prefixed with the phase number.
> - Review `git diff main...HEAD` against `requirements.md` and `CLAUDE.md`: fail-closed paths, zod at every external input, integer money, no AI SDK in mandate, verifiers or ledger, Graphite tokens only in UI, no emojis.
> - Fix small issues yourself, one commit each (`fix(NN): ...`). For anything bigger, add a ticket to `tickets.md` with `Status: open` and commit it.
> - If nothing is left to fix, tick the feature's item in `specs/roadmap.md` and commit `docs(NN): validated`.
> - Don't push. Reply with `PASS` or `FIXES <count>` only.

Push the branch. On `FIXES`, go back to section 3. After 3 rounds that still end in `FIXES`, ship anyway if the Feedback commands pass, and list the open tickets in `.ralph/human.md`.

On `PASS`, ship:

1. `git switch main`
2. `git pull --ff-only`
3. `git merge --ff-only feature/NN-slug`. If main has moved and a fast-forward isn't possible, use `git merge --no-ff feature/NN-slug -m "merge: feature NN"`.
4. `npm run typecheck`, `npm run lint`, `npm test`, `npm run build`, each piped through `tail -n 15`. If any fails on main, `git switch` back to the feature branch, add a fix ticket, and go to section 3. Nothing you pushed is lost.
5. `git push origin main`
6. Go to section 1.

When the last roadmap item is merged, run section 4's validator once over the whole of main, then write `.ralph/FINISHED` with a short summary and `.ralph/human.md`'s open count, commit, push and stop.

## 5. Unblock

Spawn a sub-agent:

> You are the autopilot's decider for Countersign. Brief §14 (v1.4) lets you settle what the build loop couldn't. For the feature in `.ralph/current-feature`:
> - Each file in `questions/open/` for this feature: decide it using the brief, the ADRs and §10's ranked trade-offs. Never contradict §8. Write the decision into the file, move it to `questions/answered/`, record an ADR (`Decided-by: autopilot (delegated)`) if later work depends on it, and add one line to `.ralph/human.md` under `## Decided for you`. If the answer needs a dependency, install it with an exact version and add it to `tech-stack.md`.
> - Each `blocked-failing` ticket: read its Notes and the code, then rewrite or split it so one iteration can finish it, and set it to `open`. Add `Retries: N` to its Notes. At `Retries: 3`, set `Status: deferred`, and add it to `.ralph/human.md`.
> - A stall (three iterations without a commit): read the newest files in `.ralph/logs/` if any, and `.ralph/progress.md`, find why, and fix the ticket or its spec.
> - Commit as `chore(NN): autopilot decisions`. Don't push. Reply with one line.

Push, then go back to section 3. If the decider can't unblock anything twice in a row, add a note to `.ralph/human.md`, commit, push, and stop.
