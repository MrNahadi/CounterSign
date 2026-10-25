#!/usr/bin/env bash
# Ralph loop for spec-ralph: one ticket per fresh, lean Claude Code session.
# Usage: .ralph/ralph.sh [max_iterations]    (default 30)
# Stop any time with Ctrl-C. Rerun to resume; state lives in the repo files.
#
# Models: builder sessions run Claude Opus 5.5 at high effort. A ticket marked
# "Tier: simple" runs Claude Sonnet 5.5, also at high. Only questions run at xhigh:
# the answerer pins Claude Opus 5.5 at xhigh in .claude/agents/answerer.md,
# whatever the builder runs on.
#
# Token discipline (from the Warzone Hackathon loop):
#   - every iteration is a new session that is never saved or resumed,
#   - no plugins, MCP servers, skills or Chrome; only project settings load,
#   - only the tools the loop uses are loaded, because tool definitions ride in
#     every request,
#   - token use and cost per iteration go to .ralph/logs/usage.csv.
#
# Usage limits: when Claude reports a usage limit, the script stashes any partial
# work under "<ticket> partial", waits until the reset time it names, then retries
# the same ticket. A wait never counts as a stall or uses up an iteration.
#
# Tunables (environment):
#   RALPH_MODEL        force one model ID for every iteration (default: per tier)
#   RALPH_EFFORT       force one effort level for every iteration (default: per tier)
#   RALPH_WARN_USD     warn when one iteration costs more than this (default 3)
#   RALPH_LIMIT_WAIT   minutes to wait when the reset time can't be read (default 15)
#   RALPH_DRY_RUN=1    print the claude command for the next ticket and exit

set -euo pipefail

MAX="${1:-30}"
STALL_LIMIT=3                 # stop after this many iterations in a row with no new commit
PROMPT=".ralph/PROMPT.md"
SETTINGS=".ralph/settings.json"
LOGS=".ralph/logs"
WARN_USD="${RALPH_WARN_USD:-3}"
LIMIT_WAIT_MIN="${RALPH_LIMIT_WAIT:-15}"

STANDARD_MODEL="claude-opus-5-5";   STANDARD_EFFORT="high"
SIMPLE_MODEL="claude-sonnet-5-5";   SIMPLE_EFFORT="high"

# This variable would override the answerer's own effort level, so the script uses --effort instead.
unset CLAUDE_CODE_EFFORT_LEVEL

cd "$(git rev-parse --show-toplevel)"

base_args=(
  -p "$(cat "$PROMPT")"
  --no-session-persistence              # fresh session, never saved or resumed
  --permission-mode acceptEdits
  --settings "$SETTINGS"
  --setting-sources project,local       # skip user settings, so user plugins and hooks stay off
  --strict-mcp-config --mcp-config '{"mcpServers":{}}'   # no MCP servers or apps
  --disable-slash-commands              # no skills in context
  --no-chrome
  --tools Bash,Read,Edit,Write,Glob,Grep,Agent,WebSearch,WebFetch   # Agent runs the answerer
  --output-format json                  # final result plus token usage
)

# Prints "<tier> <ticket-id>" for the ticket the next iteration will pick (the same
# rules as PROMPT.md section 1), or "standard none" when no ticket is ready.
next_ticket() {
  node -e '
    const fs = require("fs");
    let feature = "";
    try { feature = fs.readFileSync(".ralph/current-feature", "utf8").trim(); } catch {}
    let text = "";
    try { text = fs.readFileSync(feature + "/tickets.md", "utf8"); } catch { console.log("standard none"); process.exit(0); }
    const tickets = text.split(/^(?=## T-)/m).filter((b) => b.startsWith("## T-")).map((b) => {
      const field = (name) => ((b.match(new RegExp("^" + name + ":[ \\t]*(.*)$", "m")) || [])[1] || "").trim();
      return {
        id: b.match(/^## (T-\d+)/)[1],
        status: field("Status"),
        blockers: (field("Blocked by").match(/T-\d+/g) || []),
        tier: field("Tier").toLowerCase() === "simple" ? "simple" : "standard",
      };
    });
    const statusOf = Object.fromEntries(tickets.map((t) => [t.id, t.status]));
    let answered = [];
    try { answered = fs.readdirSync("questions/answered"); } catch {}
    const ready = tickets.find((t) =>
      (t.status === "open" && t.blockers.every((b) => statusOf[b] === "done")) ||
      (t.status === "blocked-question" && answered.some((f) => f.startsWith(t.id + "-"))));
    console.log(ready ? ready.tier + " " + ready.id : "standard none");
  '
}

# Sets TICKET, MODEL and EFFORT for the next iteration and prints why.
choose_model() {
  local tier
  read -r tier TICKET < <(next_ticket)
  if [[ "$tier" == "simple" ]]; then
    MODEL="$SIMPLE_MODEL"; EFFORT="$SIMPLE_EFFORT"
  else
    MODEL="$STANDARD_MODEL"; EFFORT="$STANDARD_EFFORT"
  fi
  MODEL="${RALPH_MODEL:-$MODEL}"
  EFFORT="${RALPH_EFFORT:-$EFFORT}"
  echo "next ticket: $TICKET ($tier) -> $MODEL, effort $EFFORT"
}

if [[ "${RALPH_DRY_RUN:-}" == "1" ]]; then
  choose_model
  printf 'claude --model %q --effort %q' "$MODEL" "$EFFORT"
  printf ' %q' "${base_args[@]:2}"; printf ' -p <%s>\n' "$PROMPT"
  exit 0
fi

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
for f in "$PROMPT" "$SETTINGS" .ralph/current-feature; do
  [[ -f "$f" ]] || { echo "Missing $f. Run the spec-ralph skill first." >&2; exit 1; }
done
command -v claude >/dev/null || { echo "Claude Code CLI ('claude') not found on PATH." >&2; exit 1; }
command -v node >/dev/null || { echo "node is needed to read token usage." >&2; exit 1; }

mkdir -p "$LOGS"
usage_csv="$LOGS/usage.csv"
[[ -f "$usage_csv" ]] || echo "iteration,log,ticket,model,effort,seconds,turns,input,cache_write,cache_read,output,cost_usd" > "$usage_csv"
last_head="$(git rev-parse HEAD)"
stalls=0
run_cost=0

# Prints "seconds turns input cache_write cache_read output cost" on one line, then the result text.
read_usage() {
  node -e '
    const fs = require("fs");
    let d = {};
    try { d = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); } catch { console.log("0 0 0 0 0 0 0.0000"); console.log("(no JSON result; see the log)"); process.exit(0); }
    const u = d.usage || {};
    console.log([
      Math.round((d.duration_ms || 0) / 1000), d.num_turns || 0,
      u.input_tokens || 0, u.cache_creation_input_tokens || 0, u.cache_read_input_tokens || 0, u.output_tokens || 0,
      (d.total_cost_usd || 0).toFixed(4),
    ].join(" "));
    console.log(String(d.result || "").slice(0, 600));
  ' "$1"
}

# Prints the Claude Code usage-limit message from an iteration's output, or nothing.
# It matches the CLI's own wording only, such as "You've hit your session limit · resets 7:20am".
limit_message() {
  cat "$@" 2>/dev/null | grep -oiE "(you('|’|\\\\u2019)ve hit your [a-z ]*limit[^\"]*|claude usage limit reached[^\"]*)" | head -n 1 || true
}

# Prints the epoch second to resume at, from a message such as
# "You've hit your session limit · resets 7:20am (Africa/Nairobi)". Fails if it can't tell.
reset_epoch() {
  local when zone t now
  when="$(sed -nE 's/.*reset(s| at)[[:space:]]+([^(."]*).*/\2/p' <<<"$1" | sed -E 's/,//g; s/[[:space:]]at[[:space:]]/ /; s/[[:space:]]+$//')"
  zone="$(sed -nE 's/.*\(([A-Za-z_]+\/[A-Za-z_]+)\).*/\1/p' <<<"$1")"
  [[ -n "$when" ]] || return 1
  if [[ -n "$zone" && -f "/usr/share/zoneinfo/$zone" ]]; then
    t="$(TZ="$zone" date -d "$when" +%s 2>/dev/null)" || return 1
  else
    t="$(date -d "$when" +%s 2>/dev/null)" || return 1
  fi
  now="$(date +%s)"
  while (( t <= now )); do t=$(( t + 86400 )); done
  echo "$t"
}

i=1
while (( i <= MAX )); do
  stamp="$(date +%Y%m%d-%H%M%S)"
  log="$LOGS/$stamp-iter-$(printf '%03d' "$i").json"
  err="$LOGS/$stamp-iter-$(printf '%03d' "$i").err"
  echo "=== iteration $i/$MAX ($(date +%H:%M)) ==="
  choose_model
  started="$(date +%s)"

  claude --model "$MODEL" --effort "$EFFORT" "${base_args[@]}" > "$log" 2> "$err" || true
  [[ -s "$err" ]] || rm -f "$err"

  { read -r secs turns input cwrite cread output cost; result="$(cat)"; } < <(read_usage "$log")
  # Only an iteration that made no commit can have been cut off by a usage limit.
  limit=""
  if [[ "$(git rev-parse HEAD)" == "$last_head" ]]; then
    limit="$(limit_message "$log" "$err")"
  fi

  if [[ -n "$limit" ]]; then
    echo "Usage limit: $limit"
    if [[ -n "$(git status --porcelain)" ]]; then
      git stash push -u -m "$TICKET partial" >/dev/null
      echo "Stashed the partial work as \"$TICKET partial\". The retry picks it up."
    fi
    if resume="$(reset_epoch "$limit")"; then
      resume=$(( resume + 120 ))
    else
      resume=$(( $(date +%s) + LIMIT_WAIT_MIN * 60 ))
    fi
    echo "Waiting until $(date -d "@$resume" +%H:%M), then retrying $TICKET. Ctrl-C stops the loop."
    sleep $(( resume - $(date +%s) > 0 ? resume - $(date +%s) : 0 ))
    continue
  fi

  echo "$i,$log,$TICKET,$MODEL,$EFFORT,$secs,$turns,$input,$cwrite,$cread,$output,$cost" >> "$usage_csv"
  run_cost="$(node -e 'console.log((Number(process.argv[1]) + Number(process.argv[2])).toFixed(4))' "$run_cost" "$cost")"
  echo "$result"
  echo "tokens: input $input, cache write $cwrite, cache read $cread, output $output; turns $turns, ${secs}s, \$$cost; run total \$$run_cost"
  if node -e 'process.exit(Number(process.argv[1]) > Number(process.argv[2]) ? 0 : 1)' "$cost" "$WARN_USD"; then
    echo "WARNING: iteration $i cost \$$cost, over the \$$WARN_USD warning line. Check whether $TICKET should be split." >&2
  fi

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
    # A run that dies within a minute is usually transient (network, a brief outage). Pause before retrying.
    if (( $(date +%s) - started < 60 )); then
      echo "That iteration ended within a minute. Pausing 60s before the next one."
      sleep 60
    fi
  else
    stalls=0
    last_head="$head_now"
  fi
  i=$((i + 1))
done

echo "Reached the $MAX-iteration cap. Check .ralph/progress.md, then rerun to continue." >&2
exit 2
