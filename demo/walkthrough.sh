#!/usr/bin/env bash
# Narrated tour of the Queen's routing decisions, one task per branch.
#
#   bash demo/walkthrough.sh            step through, pausing between beats
#   bash demo/walkthrough.sh --yes      run straight through
#   bash demo/walkthrough.sh --frontier include the budget-guard beat
#                                       (needs `npm run solo -- --frontier`)
#
# Start the hive first: `npm run solo`. Watch it live in a third terminal with
# `npm run watch`.
#
# Each beat prints what SHOULD happen and then what did, so a mismatch is
# obvious. The claim to check in the queen's log is the routing line:
#   [queen] <id> -> tasks.t<N>.<skill> (<reason>)
set -euo pipefail

Q="${QUEEN_URL:-http://localhost:4100}"
AUTO=0
FRONTIER=0
for arg in "$@"; do
  case "$arg" in
    --yes|-y) AUTO=1 ;;
    --frontier) FRONTIER=1 ;;
    *) echo "unknown flag: $arg" >&2; exit 1 ;;
  esac
done

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

# beat <n> <title> <expectation> <json>
beat() {
  echo
  bold "── $1. $2"
  dim "   expect: $3"
  echo
  curl -s -X POST "$Q/tasks" -H 'content-type: application/json' -d "$4" | python3 -m json.tool
  pause
}

# Wait for a task to leave the dispatched/deferred state, then print how it ended.
# Generous by default: a tier-1 beat really does shell out to `claude -p`, which
# can run for minutes. Override with SETTLE_TRIES.
settle() {
  local id="$1" tries="${2:-${SETTLE_TRIES:-150}}"
  local n=0
  for _ in $(seq "$tries"); do
    local body status
    body="$(curl -s "$Q/tasks/$id")"
    status="$(printf '%s' "$body" | python3 -c 'import sys,json; print(json.load(sys.stdin).get("status",""))' 2>/dev/null || true)"
    n=$((n + 1))
    if [ $((n % 5)) = 0 ] && [ "$status" = "dispatched" ]; then
      printf '\033[2m.\033[0m'   # still working; a real agent call takes a while
    fi
    if [ "$status" = "done" ] || [ "$status" = "failed" ]; then
      [ $n -ge 5 ] && echo
      printf '%s' "$body" | python3 -c '
import sys, json
t = json.load(sys.stdin)
r = t.get("result") or {}
st = t.get("status", "?")
bee = r.get("agentId", "?")
tier = r.get("tierUsed", "?")
runtime = r.get("runtime", "?")
model = r.get("model") or "-"
cost = (r.get("usage") or {}).get("costUsd", 0)
deg = r.get("degraded")
print("   -> %s  bee=%s  tier=%s  runtime=%s/%s  $%.4f  degraded=%s"
      % (st, bee, tier, runtime, model, cost, deg))
err = r.get("error")
if err:
    print("   error: %s" % err[:200])
'
      return 0
    fi
    sleep 2
  done
  echo
  echo "   -> still $status after $((tries * 2))s (raise SETTLE_TRIES if your agent is slow)"
}

# Submit and return the taskId only.
submit() {
  curl -s -X POST "$Q/tasks" -H 'content-type: application/json' -d "$1" |
    python3 -c 'import sys,json; print(json.load(sys.stdin)["taskId"])'
}

if ! curl -sf "$Q/status" >/dev/null; then
  echo "No queen at $Q — start the hive with \`npm run solo\` first." >&2
  exit 1
fi

echo
bold "agent-hive · routing walkthrough"
dim "queen at $Q"
echo
curl -s "$Q/status" | python3 -c '
import sys, json
s = json.load(sys.stdin)
print("   bees currently registered:")
for w in s["workers"]:
    caps = w["capabilities"]
    tiers = sorted({c["tier"] for c in caps})
    print("     %-16s tiers %s  (%d capabilities)" % (w["agentId"], tiers, len(caps)))
if not s["workers"]:
    print("     (none — the queen has no workers; everything will defer)")
'
pause

beat 1 "Tool match → worker bee" \
  "tier 4, zero tokens. A registered tool whose required keys are present beats any LLM." '{
  "customerId": "aiotlab",
  "title": "Sensor uptime report",
  "input": "Generate the column report for this CSV.",
  "skills": ["reporting"],
  "toolInput": {"csv": "node,uptime,errors\nedge-1,99.2,3\nedge-2,97.4,11\nedge-3,99.8,1"}
}'

beat 2 "Simple prose → local bee" \
  "tier 3, \$0. Simple work never leaves the machine when a local model can do it." '{
  "customerId": "aiotlab",
  "title": "Tagline",
  "input": "Write a one-line tagline for the lab edge-AI sensor demo."
}'

# The "design/refactor/optimize" verbs are what scoreDifficulty keys on for
# `complex`; the length cap just keeps a real agent call short enough to demo.
beat 3 "Complex coding → honey bee" \
  "tier 1 on a prepaid seat. Frontier capability, \$0 marginal cost — quota, not dollars." '{
  "customerId": "aiotlab",
  "title": "Refactor sensor ingestion pipeline",
  "input": "Design a refactor of a multi-step MQTT sensor-ingestion pipeline: split the monolithic handler into strategy classes and optimize the hot path. Answer in under 150 words, no code.",
  "skills": ["coding"]
}'

beat 4 "Urgent overflow → metered bee" \
  "tier 2, real dollars. Per-token is dispatched ONLY when urgency=urgent — this is the one beat that spends." '{
  "customerId": "aiotlab",
  "title": "Incident summary",
  "input": "Summarize the likely cause of a sudden packet-loss spike on an MQTT sensor fleet.",
  "urgency": "urgent",
  "skills": ["research"]
}'

beat 5 "Confidential → locked on-prem" \
  "tier 3 and degraded=true. Confidential work is capped at local billing even when it deserves better." '{
  "customerId": "aiotlab",
  "title": "Analyze proprietary model",
  "input": "Debug and optimize the proprietary on-device inference model controller end-to-end across modules. Answer in under 80 words.",
  "sensitivity": "confidential",
  "skills": ["coding"]
}'

echo
bold "── 6. Seat exhaustion → defer (policy: wait)"
dim "   expect: the first task empties demo-seat-1 (90s / 1000 tokens); the second"
dim "           has nowhere adequate to go, and aiotlab's policy is to WAIT for the"
dim "           window rather than pay retail. Watch for 'deferred', then a resume."
echo
first="$(submit '{
  "customerId": "aiotlab",
  "title": "Design the ingestion retry policy",
  "input": "Design an end-to-end retry and backoff policy across the ingestion services. Answer in under 80 words.",
  "skills": ["demo-quota"]
}')"
echo "   burning the seat with task $first ..."
settle "$first"
echo
second="$(submit '{
  "customerId": "aiotlab",
  "title": "Design the dead-letter policy",
  "input": "Design an end-to-end dead-letter and replay policy across the ingestion services. Answer in under 80 words.",
  "skills": ["demo-quota"]
}')"
sleep 2
curl -s "$Q/tasks/$second" | python3 -c '
import sys, json
t = json.load(sys.stdin)
print("   task %s: %s — %s" % (t["taskId"], t["status"], t["reason"]))
'
pause

echo
bold "── 7. Same block, policy: degrade"
dim "   expect: demo-lab sets onBudgetBlock=degrade, so the identical situation"
dim "           runs NOW on a local model, marked degraded, instead of waiting."
echo
third="$(submit '{
  "customerId": "demo-lab",
  "title": "Design the replay policy",
  "input": "Design an end-to-end replay and reconciliation policy across the ingestion services. Answer in under 80 words.",
  "skills": ["demo-quota"]
}')"
settle "$third"
pause

if [ "$FRONTIER" = "1" ]; then
  echo
  bold "── 8. Worker budget guard refuses"
  dim "   expect: the Queen's per-task envelope is max(\$0.05, sonnet x 2); gpt-5.5-pro"
  dim "           costs 11.8x sonnet, so the worker projects the call, sees it over cap,"
  dim "           and refuses BEFORE calling out. No cheaper capability holds the"
  dim "           deep-research skill, so the task fails rather than overspend."
  dim "           This beat costs \$0 — the call never happens."
  echo
  guard="$(submit '{
    "customerId": "aiotlab",
    "title": "Deep research brief",
    "input": "Design and prove an end-to-end architecture for federated sensor analytics across services.",
    "urgency": "urgent",
    "skills": ["deep-research"]
  }')"
  settle "$guard" 20
  pause
fi

beat 9 "Pinned → direct queue" \
  "bypasses tier mapping entirely and goes straight to the named bee." '{
  "customerId": "aiotlab",
  "title": "Edge-node health check",
  "input": "Summarize edge-node health status.",
  "pinnedAgentId": "local-bee-1"
}'

beat 10 "Repeat of beat 2 → cache hit" \
  "HTTP 200 with cached=true and no dispatch at all. The cheapest call is the one you do not make." '{
  "customerId": "aiotlab",
  "title": "Tagline",
  "input": "Write a one-line tagline for the lab edge-AI sensor demo."
}'

echo
bold "── done"
dim "   npm run scoreboard   what this cost, and what it would have cost"
echo
