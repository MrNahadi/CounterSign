#!/usr/bin/env bash
# Ralph loop for spec-ralph: one ticket per fresh Claude Code session.
# Usage: .ralph/ralph.sh [max_iterations]    (default 30)
# Stop any time with Ctrl-C. Rerun to resume; state lives in the repo files.

set -euo pipefail

MAX="${1:-30}"
STALL_LIMIT=3                 # stop after this many iterations with no new commit
PROMPT=".ralph/PROMPT.md"
LOGS=".ralph/logs"

cd "$(git rev-parse --show-toplevel)"

rm -f .ralph/done

branch="$(git branch --show-current)"
if [[ "$branch" != feature/* ]]; then
  echo "Refusing to run on '$branch'. Switch to a feature/ branch first." >&2
  exit 1
fi
if [[ -n "$(git status --porcelain)" ]]; then
  echo "Working tree isn't clean. Commit or stash first." >&2
  exit 1
fi
for f in "$PROMPT" .ralph/current-feature; do
  [[ -f "$f" ]] || { echo "Missing $f. Run the spec-ralph skill first." >&2; exit 1; }
done
command -v claude >/dev/null || { echo "Claude Code CLI ('claude') not found on PATH." >&2; exit 1; }

mkdir -p "$LOGS"
last_head="$(git rev-parse HEAD)"
stalls=0

for ((i = 1; i <= MAX; i++)); do
  log="$LOGS/$(date +%Y%m%d-%H%M%S)-iter-$(printf '%03d' "$i").log"
  echo "=== iteration $i/$MAX ($(date +%H:%M)) ==="

  claude -p "$(cat "$PROMPT")" --permission-mode acceptEdits 2>&1 | tee "$log" || true

  if [[ -f .ralph/done ]]; then
    echo "Loop finished after $i iteration(s): $(head -n1 .ralph/done)"
    exit 0
  fi

  if [[ "$(git branch --show-current)" != "$branch" ]]; then
    echo "Branch changed during iteration $i. Stopping." >&2
    exit 1
  fi

  head_now="$(git rev-parse HEAD)"
  if [[ "$head_now" == "$last_head" ]]; then
    stalls=$((stalls + 1))
    echo "No new commit this iteration ($stalls/$STALL_LIMIT)."
    if (( stalls >= STALL_LIMIT )); then
      echo "Stalled: $STALL_LIMIT iterations without a commit. Check the latest log in $LOGS." >&2
      exit 3
    fi
  else
    stalls=0
    last_head="$head_now"
  fi
done

echo "Reached the $MAX-iteration cap. Check .ralph/progress.md, then rerun to continue." >&2
exit 2
