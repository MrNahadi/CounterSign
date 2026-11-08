#!/usr/bin/env bash
# Countersign's build loop: one fresh agent run per task in PLAN.md, using PROMPT.md.
# The repo is the only memory. The loop pushes after every commit.
#
# Usage: ./loop.sh [codex|claude] [max_runs]      (defaults: codex, 40)
# Stop any time with Ctrl-C; rerun to continue.
#
# Optional settings:
#   CODEX_MODEL    model for Codex (default: Codex's own default)
#   CODEX_EFFORT   reasoning effort for Codex (default: medium)
#   CLAUDE_MODEL   model for Claude Code (default: claude-sonnet-5-5)
#   CLAUDE_EFFORT  effort for Claude Code (default: medium)
# Output of each run is saved in loop-logs/ (git ignores it).

set -uo pipefail
cd "$(git rev-parse --show-toplevel)"

agent="${1:-codex}"
max="${2:-40}"
branch="$(git branch --show-current)"
stalls=0
mkdir -p loop-logs

if ! command -v "$agent" >/dev/null 2>&1; then
  echo "LOOP: '$agent' isn't on the PATH in this shell. Install it, sign in, and try again." >&2
  exit 2
fi

for (( run = 1; run <= max; run++ )); do
  if ! grep -q '^- \[ \]' PLAN.md; then
    echo "LOOP: no open tasks left in PLAN.md."
    exit 0
  fi
  if [[ -n "$(git status --porcelain)" ]]; then
    echo "LOOP: the working tree isn't clean. Commit or stash first." >&2
    exit 1
  fi

  before="$(git rev-parse HEAD)"
  log="loop-logs/$(date +%Y%m%d-%H%M%S)-$agent.log"
  echo "LOOP: run $run/$max with $agent at $(date +%H:%M)"

  case "$agent" in
    codex)
      codex exec --full-auto \
        ${CODEX_MODEL:+-m "$CODEX_MODEL"} \
        -c model_reasoning_effort="${CODEX_EFFORT:-medium}" \
        "$(cat PROMPT.md)" > "$log" 2>&1
      ;;
    claude)
      claude -p "$(cat PROMPT.md)" \
        --model "${CLAUDE_MODEL:-claude-sonnet-5-5}" \
        --effort "${CLAUDE_EFFORT:-medium}" \
        --no-session-persistence \
        --permission-mode acceptEdits \
        --settings .claude/loop-settings.json \
        --setting-sources project,local \
        --strict-mcp-config --mcp-config '{"mcpServers":{}}' \
        --disable-slash-commands \
        --tools Bash,Read,Edit,Write,Glob,Grep \
        > "$log" 2>&1
      ;;
    *)
      echo "Unknown agent '$agent'. Use codex or claude." >&2
      exit 2
      ;;
  esac

  # If the agent finished a task but its sandbox couldn't commit, commit for it.
  if [[ "$(git rev-parse HEAD)" == "$before" ]] && git diff -U0 PLAN.md | grep -qE '^\+- \[(x|!)\]'; then
    git add -A
    git commit -q -m "$(tail -n 1 progress.txt | cut -c1-120)"
  fi

  if [[ "$(git rev-parse HEAD)" == "$before" ]]; then
    stalls=$((stalls + 1))
    echo "LOOP: no commit ($stalls/3). Last lines of $log:"
    tail -n 15 "$log" | sed 's/^/  | /'
    # Keep any half-done work for the next run, which pops it.
    if [[ -n "$(git status --porcelain)" ]]; then
      git stash push -u -m "loop partial" >/dev/null
    fi
    if (( stalls >= 3 )); then
      echo "LOOP: 3 runs in a row without a commit. Read the last log and progress.txt." >&2
      exit 3
    fi
  else
    stalls=0
    if ! git push -q origin "$branch"; then
      echo "LOOP: push failed. Stopping." >&2
      exit 4
    fi
    echo "LOOP: $(git log --oneline -1)"
  fi
done

echo "LOOP: reached $max runs. Rerun to continue."
