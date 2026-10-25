#!/usr/bin/env bash
# Runs .ralph/ralph.sh one iteration at a time and pushes after every new commit
# (the autopilot's heartbeat). Stops when ralph writes .ralph/done, after 3
# iterations in a row without a commit, on a rejected push, or at the cap.
# Usage: .ralph/push-loop.sh <repo> [max_iterations]   (the autopilot's section 3)
# A background command runs at most 2 hours; rerun to continue. State lives in the repo.
set -uo pipefail

cd "$1"
MAX="${2:-60}"
branch="$(git branch --show-current)"
stalls=0

for (( n = 1; n <= MAX; n++ )); do
  before="$(git rev-parse HEAD)"
  bash .ralph/ralph.sh 1
  code=$?
  after="$(git rev-parse HEAD)"

  if [[ "$after" != "$before" ]]; then
    stalls=0
    if ! git push origin "$branch"; then
      echo "LOOP: push rejected on $branch. Another writer may be running. Stopping." >&2
      exit 10
    fi
    echo "LOOP: pushed $(git log --oneline -1)"
  else
    stalls=$((stalls + 1))
    echo "LOOP: no new commit ($stalls/3)"
  fi

  if [[ -f .ralph/done ]]; then
    echo "LOOP: done file says: $(head -n 1 .ralph/done)"
    exit 0
  fi
  if (( code != 0 && code != 2 )); then
    echo "LOOP: ralph.sh exited $code. Stopping." >&2
    exit "$code"
  fi
  if (( stalls >= 3 )); then
    echo "LOOP: stalled, 3 iterations without a commit." >&2
    exit 3
  fi
done

echo "LOOP: reached $MAX iterations."
exit 2
