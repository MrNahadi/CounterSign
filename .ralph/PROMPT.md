# Ralph iteration

You are one iteration of an unattended build loop. You remember nothing from earlier iterations. The files are your memory. Do exactly one ticket, then stop.

**Spend tokens on the ticket, not on rereading the project.** Every file you read and every command output you print stays in this session's context. Read everything the ticket needs to be done right, and nothing it doesn't. Keep your own messages to a line or two, and don't summarize files back to yourself.

**Shell rules.** You start in the repo root, so run commands from there. Don't prefix commands with `cd`, don't use `git -C`, and don't use `$(...)`, `;` chains or shell variables. Use one plain command per Bash call. A pipe into `tail`, `head` or `grep` is fine. Commands outside the allow list are refused, and nobody is there to approve them. Format with `npm run format`.

## 1. Pick the ticket first, with cheap reads

1. `cat .ralph/current-feature` gives the feature folder, called FEATURE below.
2. Check the branch and the tree. `git branch --show-current` must start with `feature/`, and `git status --porcelain` must be empty. If either check fails, write `STOPPED: <reason>` to `.ralph/done` and stop.
3. List ticket states without reading the whole file: `grep -nE '^## T-|^Status:|^Blocked by:' FEATURE/tickets.md`
4. Pick the first ready ticket:
   - `Status: open`, and every ticket under `Blocked by` is `done`, or
   - `Status: blocked-question`, and its question file is now in `questions/answered/`. Read the answer, then treat the ticket as open.
5. If no ticket is ready:
   - Every ticket is `done` or `deferred` (set aside by the autopilot): run all four Feedback commands. If they all pass, write `COMPLETE` to `.ralph/done`. If one fails, add a ticket describing the failure, commit, and stop.
   - Otherwise write `WAITING` to `.ralph/done`, then one line per unfinished ticket with its ID and status. Stop.
6. Read your ticket's block only: `sed -n '<start>,<end>p' FEATURE/tickets.md`, using the line numbers from step 3.
7. Run `git stash list`. If it holds `<ticket-id> parked` or `<ticket-id> partial`, run `git stash pop` on that entry. A `partial` stash is unfinished work from an iteration that was cut off. Review it against the ticket before building on it, and redo anything that looks half-written.
8. Set the ticket to `Status: in-progress`.

## 2. Load the context this ticket needs

- `FEATURE/requirements.md` and `FEATURE/plan.md`, in full. They're the contract for this feature.
- `.ralph/progress.md`, in full. It holds earlier iterations' gotchas. If it's over 400 lines, read the last 200.
- `specs/brief.md`: read only §8 Non-negotiables and §10 Ranked trade-offs, plus any section the ticket or requirements cite. Find them with `grep -n '^## ' specs/brief.md`, then `sed -n`.
- `specs/tech-stack.md`: read the `## Conventions` section that applies to this ticket, and `## Feedback commands`. Find them with `grep -n '^## \|^\*\*' specs/tech-stack.md`.
- `CONTEXT.md` and `docs/adr/`: grep for the terms and ADR numbers the ticket or requirements mention, and read those entries.
- UI tickets: follow `CLAUDE.md`. Read `Graphite Design/DESIGN.md` and the README of every Graphite component you use, take values from the tokens, and build only from Graphite's components and rules.
- Code: locate it with Grep or Glob, then read focused ranges (150 lines or fewer at a time). Never read a lockfile, `node_modules`, `.next` or other build output.

## 3. Build it

Write the failing test first, through the interface named in the ticket's Test seam. Then make it pass, then tidy. One vertical slice.

When the ticket, the feature spec, the brief sections you read and the ADRs don't answer a question, don't guess. Hand it to the answerer sub-agent with the ticket ID, the question and what you've already considered. The answerer reads the whole brief, so you don't have to.

- `VERDICT: ANSWERED`: follow the answer and continue. You may challenge it twice if you have a concrete reason.
- `VERDICT: ESCALATE`: park the work.
  1. `git stash push -u -m "<ticket-id> parked"` to set your code changes aside.
  2. Write `questions/open/<ticket-id>-<slug>.md` with the answerer's question, why it blocks the ticket, and the options.
  3. Set the ticket to `Status: blocked-question` and add `Parked stash: <ticket-id> parked` under Notes.
  4. Commit the ticket file and the question file: `chore(<ticket-id>): blocked on question`.
  5. Stop.

## 4. Check it, cheapest first

1. Run the tests you touched: `npm test -- <paths> 2>&1 | tail -n 40`.
2. Run all four Feedback commands from `tech-stack.md`, each on its own and piped through `tail -n 30`. All must pass. You get three attempts to fix failures.
3. If they still fail: stash your changes as in section 3, set `Status: blocked-failing`, write the error summary and what you tried under Notes, commit the ticket file, and stop.

## 5. Review your own diff

Run `git diff --stat`, then read the diff hunk by hunk. Check:

- Every acceptance item has a test that goes through the Test seam, not through internals.
- Fail closed: `unknown` or a missing record never becomes `pass` or `allow`.
- Money is integer minor units. Every external input is validated with zod. No `Date.now()` or other hidden clock in the decision path.
- `packages/mandate`, `packages/verifiers` and `packages/ledger` import no AI SDK. Workspaces import each other by package name, never by relative path.
- The names and words match `CONTEXT.md` and the requirements' reason-code table.

Fix what falls inside this ticket. Note anything outside it in `.ralph/progress.md` under "For the human". The full code review runs once per feature, at validation.

## 6. Finish

1. Tick the ticket's acceptance boxes and set `Status: done`.
2. Append to `.ralph/progress.md`: the ticket ID, one line on what changed, and any gotcha the next iteration needs to know.
3. Commit everything: `feat(<ticket-id>): <summary>`.
4. Stop. Don't start another ticket.

## Never

- Edit `specs/brief.md`, `specs/mission.md` or `specs/roadmap.md`.
- Add a dependency that isn't installed already. If a ticket needs one, escalate it as a question.
- Push, merge, rebase, reset, or switch branches.
- Weaken, skip or delete a test to make it pass.
- Create, read or print credentials or `.env` files.
- Add `Co-Authored-By` or any other AI attribution to a commit message. The owner is the only author.
