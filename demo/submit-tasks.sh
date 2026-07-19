#!/usr/bin/env bash
# Fire sample tasks across all four tiers at the Queen's intake API.
set -euo pipefail
Q="${QUEEN_URL:-http://localhost:4100}"

post() {
  echo "== $1 =="
  curl -s -X POST "$Q/tasks" -H 'content-type: application/json' -d "$2" | python3 -m json.tool
  echo
}

# 1. Tier-4 tool match: deterministic, zero tokens.
post "tool match -> tier 4 csv-report" '{
  "customerId": "auo",
  "title": "Monthly yield report",
  "input": "Generate the column report for this CSV.",
  "skills": ["reporting"],
  "toolInput": {"csv": "line,yield,defects\nL1,98.2,12\nL2,97.1,19\nL3,99.0,4"}
}'

# 2. Simple task: expect tier 3 local model.
post "simple -> tier 3 local" '{
  "customerId": "auo",
  "title": "Slogan",
  "input": "Write a one-line safety slogan for a display panel fab."
}'

# 3. Complex coding task: expect tier 1 Claude Code seat (or degraded local if absent).
post "complex -> tier 1 seat" '{
  "customerId": "auo",
  "title": "Refactor conveyor scheduler",
  "input": "Design and implement a refactor of a multi-step conveyor scheduling module: split the monolithic scheduler into strategy classes, add unit tests, and optimize the hot path.",
  "skills": ["coding"]
}'

# 4. Confidential complex task: must stay on-prem (capped at tier 3, marked degraded).
post "confidential -> capped local" '{
  "customerId": "auo",
  "title": "Analyze secret recipe",
  "input": "Debug and optimize the proprietary OLED deposition recipe controller end-to-end across modules.",
  "sensitivity": "confidential",
  "skills": ["coding"]
}'

# 5. Pinned task: direct queue to a named agent.
post "pinned -> direct queue" '{
  "customerId": "auo",
  "title": "Fab-floor camera check",
  "input": "Summarize camera health status.",
  "pinnedAgentId": "hq-local-1"
}'

echo "== status =="
curl -s "$Q/status" | python3 -m json.tool | head -60
