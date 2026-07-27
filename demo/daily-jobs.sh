#!/usr/bin/env bash
# The personal bee: the Queen forwards local, personal-data jobs to the agent
# that lives on the user's machine, keeping them $0 and on-premises.
#
#   bash demo/daily-jobs.sh            step through the beats
#   bash demo/daily-jobs.sh --yes      run straight through
#
# Start the hive first: `npm run solo`. The personal bee reads the sample corpus
# in demo/personal-data/ (email, calendar, notes, documents). Whichever backend
# serves it — an OpenClaw gateway, a Hermes CLI, or the built-in mini agent on a
# local Ollama model — the work never leaves the machine.
#
# Watch http://localhost:5180 alongside: these land as 🏡 personal-bee cards,
# marked confidential, at $0.
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

submit() {
  curl -s -X POST "$Q/tasks" -H 'content-type: application/json' -d "$1" |
    python3 -c 'import sys,json; print(json.load(sys.stdin)["taskId"])'
}

# Poll until a task settles, then print how it ended (bee, runtime, cost).
settle() {
  local id="$1" tries="${2:-${SETTLE_TRIES:-150}}"
  local n=0 status=""
  for _ in $(seq "$tries"); do
    local body
    body="$(curl -s "$Q/tasks/$id")"
    status="$(printf '%s' "$body" | python3 -c 'import sys,json; print(json.load(sys.stdin).get("status",""))' 2>/dev/null || true)"
    n=$((n + 1))
    if [ $((n % 5)) = 0 ] && [ "$status" = "dispatched" ]; then printf '\033[2m.\033[0m'; fi
    if [ "$status" = "done" ] || [ "$status" = "failed" ]; then
      [ $n -ge 5 ] && echo
      printf '%s' "$body" | python3 -c '
import sys, json
t = json.load(sys.stdin)
r = t.get("result") or {}
agent, runtime = r.get("agent"), r.get("runtime","?")
# agent is what the bee was configured to run, runtime is what answered.
# Different means it substituted a backend, which should never pass unnoticed.
served = runtime if not agent or agent == runtime else "%s (fell back from %s)" % (runtime, agent)
print("   -> %s  bee=%s  agent=%s  ran=%s/%s  billing=%s  $%.4f  confidential=%s"
      % (t.get("status","?"), r.get("agentId","?"), agent or "-", served,
         r.get("model") or "-", r.get("billing","?"),
         (r.get("usage") or {}).get("costUsd", 0),
         (t.get("spec") or {}).get("sensitivity") == "confidential"))
out = (r.get("output") or "").strip()
if out:
    print("   --- output (first lines) ---")
    for ln in out.splitlines()[:12]:
        print("   " + ln)
err = r.get("error")
if err:
    print("   error: %s" % err[:200])
'
      return 0
    fi
    sleep 2
  done
  echo
  echo "   -> still ${status:-pending} after $((tries * 2))s (raise SETTLE_TRIES if your model is slow)"
}

if ! curl -sf "$Q/status" >/dev/null; then
  echo "No queen at $Q — start the hive with \`npm run solo\` first." >&2
  exit 1
fi

echo
bold "agent-hive · daily jobs on the personal bee"
dim "queen at $Q · corpus in demo/personal-data/"
echo

# ── 1. Morning digest + status draft (structured intake) ─────────────────────
bold "── 1. Summarize this morning's email and draft a status"
dim '   expect: analyzer marks it confidential ("my inbox"); routed to'
dim "           personal-bee-1 at tier 3, billing local, \$0."
echo
id="$(submit '{
  "customerId": "aiotlab",
  "title": "Summarize this morning'\''s email",
  "input": "Summarize my inbox from this morning, then draft the status paragraph Prof. Chen asked for about the yield-prediction project.",
  "skills": ["email", "daily-report"]
}')"
echo "   task $id submitted"
settle "$id"
pause

# ── 2. Calendar + promises (conversational planner) ──────────────────────────
bold "── 2. Ask the Queen conversationally"
dim "   expect: the planner tags calendar / files from live skills and"
dim "           routes to the personal bee; watch the cards in the console."
echo
if python3 - <<'PY' 2>/dev/null
import urllib.request
urllib.request.urlopen("http://localhost:4100/status", timeout=2)
PY
then
  python3 demo/chat.py "What's on my calendar today, and is there anything in my notes I promised to send this week?"
else
  dim "   (skipped: chat endpoint unavailable)"
fi
echo
bold "done."
dim "Everything above ran on the user's machine: \$0 and no data egress."
echo
