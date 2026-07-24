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
  "customerId": "aiotlab",
  "title": "Sensor uptime report",
  "input": "Generate the column report for this CSV.",
  "skills": ["reporting"],
  "toolInput": {"csv": "node,uptime,errors\nedge-1,99.2,3\nedge-2,97.4,11\nedge-3,99.8,1"}
}'

# 2. Simple task: expect tier 3 local model.
post "simple -> tier 3 local" '{
  "customerId": "aiotlab",
  "title": "Tagline",
  "input": "Write a one-line tagline for the lab edge-AI sensor demo."
}'

# 3. Complex coding task: expect tier 1 Claude Code seat (or degraded local if absent).
post "complex -> tier 1 seat" '{
  "customerId": "aiotlab",
  "title": "Refactor sensor ingestion pipeline",
  "input": "Design and implement a refactor of a multi-step MQTT sensor-ingestion pipeline: split the monolithic handler into strategy classes, add unit tests, and optimize the hot path.",
  "skills": ["coding"]
}'

# 4. Confidential complex task: must stay on-prem (capped at tier 3, marked degraded).
post "confidential -> capped local" '{
  "customerId": "aiotlab",
  "title": "Analyze proprietary model",
  "input": "Debug and optimize the proprietary on-device inference model controller end-to-end across modules.",
  "sensitivity": "confidential",
  "skills": ["coding"]
}'

# 5. Pinned task: direct queue to a named agent.
post "pinned -> direct queue" '{
  "customerId": "aiotlab",
  "title": "Edge-node health check",
  "input": "Summarize edge-node health status.",
  "pinnedAgentId": "hq-local-1"
}'

echo "== status =="
curl -s "$Q/status" | python3 -m json.tool | head -60
