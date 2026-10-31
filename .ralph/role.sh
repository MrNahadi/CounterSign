#!/usr/bin/env bash
# Runs one planning, review or validation step as a lean `claude -p` session,
# with ralph.sh's token discipline: no MCP servers, no skills, no Chrome, project
# settings only, and only the tools the role needs.
#
# Usage: .ralph/role.sh <role> <prompt text | @prompt-file>
#   elephant   the planner. Opus at high. Keeps its context per feature: the first
#              call starts a session with a fixed --session-id, later calls --resume it.
#   goldfish   a reviewer. Sonnet at high. Fresh, never saved. Reads and writes files only.
#   validator  Opus at high. Fresh, never saved.
#   fresh      Opus at high. Fresh, never saved. For a one-off planning step.
#
# Prints the session's final reply (first 600 characters) and one usage line.
# The full JSON goes to .ralph/logs/. Usage rows go to .ralph/logs/usage.csv.
#
# Tunables (environment):
#   ROLE_FEATURE   feature folder the Elephant belongs to (default: .ralph/current-feature)
#   ROLE_NEW=1     start a new Elephant session for the feature, dropping the old one
#   ROLE_MODEL     force a model ID
#   ROLE_EFFORT    force an effort level

set -euo pipefail

role="${1:?usage: role.sh <elephant|goldfish|validator|fresh> <prompt | @file>}"
prompt="${2:?missing prompt}"
[[ "$prompt" == @* ]] && prompt="$(cat "${prompt#@}")"

# This variable would override the answerer's own effort level.
unset CLAUDE_CODE_EFFORT_LEVEL

cd "$(git rev-parse --show-toplevel)"
LOGS=".ralph/logs"
mkdir -p "$LOGS"
command -v claude >/dev/null || { echo "Claude Code CLI ('claude') not found on PATH." >&2; exit 1; }

common=(
  --permission-mode acceptEdits
  --settings .ralph/settings.json
  --setting-sources project,local
  --strict-mcp-config --mcp-config '{"mcpServers":{}}'
  --disable-slash-commands
  --no-chrome
  --output-format json
)
full_tools="Bash,Read,Edit,Write,Glob,Grep,Agent,WebSearch,WebFetch"   # Agent runs the answerer

session=()
case "$role" in
  elephant)
    model="claude-opus-5-5"; tools="$full_tools"
    feature="${ROLE_FEATURE:-$(cat .ralph/current-feature 2>/dev/null || true)}"
    [[ -n "$feature" ]] || { echo "No feature: set ROLE_FEATURE or .ralph/current-feature." >&2; exit 1; }
    idfile="$LOGS/elephant-$(basename "$feature").id"
    [[ "${ROLE_NEW:-}" == "1" ]] && rm -f "$idfile"
    if [[ -s "$idfile" ]]; then
      session=(--resume "$(cat "$idfile")")
    else
      id="$(node -e 'console.log(require("crypto").randomUUID())')"
      echo "$id" > "$idfile"
      session=(--session-id "$id")
    fi
    ;;
  goldfish)  model="claude-sonnet-5-5"; tools="Read,Write,Glob,Grep"; session=(--no-session-persistence) ;;
  validator) model="claude-opus-5-5";   tools="$full_tools";          session=(--no-session-persistence) ;;
  fresh)     model="claude-opus-5-5";   tools="$full_tools";          session=(--no-session-persistence) ;;
  *) echo "Unknown role '$role'." >&2; exit 1 ;;
esac
model="${ROLE_MODEL:-$model}"
effort="${ROLE_EFFORT:-high}"

stamp="$(date +%Y%m%d-%H%M%S)-$$"
log="$LOGS/$stamp-$role.json"
err="$LOGS/$stamp-$role.err"

claude -p "$prompt" --model "$model" --effort "$effort" "${session[@]}" --tools "$tools" "${common[@]}" \
  > "$log" 2> "$err" || true
[[ -s "$err" ]] || rm -f "$err"

usage_csv="$LOGS/usage.csv"
[[ -f "$usage_csv" ]] || echo "iteration,log,ticket,model,effort,seconds,turns,input,cache_write,cache_read,output,cost_usd" > "$usage_csv"

node -e '
  const fs = require("fs");
  const [log, role, model, effort, csv] = process.argv.slice(1);
  let d = {};
  try { d = JSON.parse(fs.readFileSync(log, "utf8")); } catch {
    console.log("ROLE: " + role + " gave no JSON result; see " + log);
    process.exit(1);
  }
  const u = d.usage || {};
  const row = ["role", log, role, model, effort, Math.round((d.duration_ms || 0) / 1000), d.num_turns || 0,
    u.input_tokens || 0, u.cache_creation_input_tokens || 0, u.cache_read_input_tokens || 0, u.output_tokens || 0,
    (d.total_cost_usd || 0).toFixed(4)];
  fs.appendFileSync(csv, row.join(",") + "\n");
  console.log(String(d.result || "").slice(0, 600));
  console.log("ROLE: " + role + " " + model + ", " + (d.num_turns || 0) + " turns, $" + (d.total_cost_usd || 0).toFixed(2) +
    (d.is_error ? ", ended with an error" : ""));
  process.exit(d.is_error ? 1 : 0);
' "$log" "$role" "$model" "$effort" "$usage_csv"
