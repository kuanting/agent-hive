#!/usr/bin/env bash
# The conversational Queen: one request, decomposed into a DAG that lands on
# several different bees.
#
#   bash demo/chat-scenario.sh            step through the turns
#   bash demo/chat-scenario.sh --yes      run straight through
#
# Open http://localhost:5180 alongside this to watch the same conversation as
# task cards. The planner is itself metered — its model spend shows up as
# `plannerCostUsd` in /status, separate from execution, so the brain is never a
# hidden cost centre.
#
# The planner runs on a local model (HIVE_PLANNER_MODEL, default gemma3:4b) and
# escalates only when the request scores as complex. If Ollama isn't running it
# degrades to a single task built from your message rather than failing.
set -euo pipefail

Q="${QUEEN_URL:-http://localhost:4100}"
AUTO=0
case "${1:-}" in
  --yes|-y) AUTO=1 ;;
  "") ;;
  *) echo "unknown flag: $1" >&2; exit 1 ;;
esac

bold() { printf '\033[1m%s\033[0m\n' "$1"; }
dim()  { printf '\033[2m%s\033[0m\n' "$1"; }

pause() {
  if [ "$AUTO" = "0" ]; then
    printf '\033[2m    ↵ to continue\033[0m'
    read -r _
  else
    echo
  fi
}

if ! curl -sf "$Q/status" >/dev/null; then
  echo "No queen at $Q — start the hive with \`npm run solo\` first." >&2
  exit 1
fi

SESSION="demo-$$"

turn() {
  echo
  bold "── you: $1"
  dim "   $2"
  echo
  python3 demo/chat.py "$1" "$SESSION"
  pause
}

echo
bold "agent-hive · conversational walkthrough"
dim "session $SESSION · console at http://localhost:5180"

turn "We had a yield drop on line 3 last week and I want to understand it." \
  "expect: the planner may ask a clarifying question rather than guessing — \
cheaper than planning the wrong work."

turn "Sensor logs from the three edge nodes, and I want a written summary at the end." \
  "expect: a plan of several tasks. Watch the tiers: extraction and summarisation \
are cheap work, the synthesis step is not."

turn "Go ahead." \
  "expect: tasks execute in dependency order. A parent's output is passed to its \
child as an artifact REFERENCE, not inlined — check the artifacts/ directory."

echo
bold "── what to look at"
dim "   npm run scoreboard              planner spend vs execution spend"
dim "   ls artifacts/                   results passed by reference between steps"
dim "   curl -s $Q/sessions/$SESSION    the full conversation state"
echo
