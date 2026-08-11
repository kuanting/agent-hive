#!/usr/bin/env bash
# The breeding loop, end to end: traffic in, a finding out, a program that serves
# it for nothing.
#
#   bash demo/breeding.sh            step through, pausing between beats
#   bash demo/breeding.sh --yes      run straight through
#   bash demo/breeding.sh --no-wait  skip the 75s wait in beat 3 (see below)
#
# Start the hive first: `npm run solo`. Watch it in a second terminal with
# `npm run watch`.
#
# What this demonstrates, in order: agent loops run against a model and the hive
# writes down what they DID, not just what they cost. A query finds the procedure
# that keeps recurring. Somebody reads it and writes a deterministic tool — a
# scraper on a schedule plus a cheap local lookup, because a scrape belongs
# nowhere near the critical path of a request. The same work then costs nothing.
#
# Said once here so nobody has to reach beat 7 to learn it: the loop closes for
# the structured intake and NOT for the agent loop that produced the finding. A
# chat completion carries a transcript, so it has no `toolInput` for `matchTool`
# to fire on. That is a design question about who owns the loop, written down in
# DESIGN §10, and beat 7 shows it rather than describing it.
set -euo pipefail

Q="${QUEEN_URL:-http://localhost:4100}"
CUSTOMER=breeder
AUTO=0
WAIT=75
PARTS_A=(LM358N NE555P ATMEGA328P-PU)
PARTS_B=(STM32F103C8T6 IRLZ44N DS18B20)

for arg in "$@"; do
  case "$arg" in
    --yes|-y) AUTO=1 ;;
    --no-wait) WAIT=0 ;;
    *) echo "unknown flag: $arg" >&2; exit 1 ;;
  esac
done

bold() { printf '\033[1m%s\033[0m\n' "$1"; }
dim()  { printf '\033[2m%s\033[0m\n' "$1"; }
red()  { printf '\033[31m%s\033[0m\n' "$1"; }

pause() {
  [ "$AUTO" = 1 ] && { echo; return 0; }
  printf '\033[2m   [enter]\033[0m'
  read -r _ || true
  echo
}

# Submit a structured task and return its id.
submit() {
  curl -s -X POST "$Q/tasks" -H 'content-type: application/json' -d "$1" |
    python3 -c 'import sys,json; print(json.load(sys.stdin)["taskId"])'
}

# Poll until settled, then ASSERT the routing rather than printing whatever came
# back. A task whose skills or toolInput are wrong falls through to a model and
# quietly costs money; a demo that showed the result either way would hide the
# one failure worth catching.
settle_expect_tier4() {
  local id="$1" body status
  for _ in $(seq 60); do
    body="$(curl -s "$Q/tasks/$id")"
    status="$(printf '%s' "$body" | python3 -c 'import sys,json; print(json.load(sys.stdin).get("status",""))' 2>/dev/null || true)"
    [ "$status" = "done" ] || [ "$status" = "failed" ] && break
    sleep 1
  done
  printf '%s' "$body" | python3 -c '
import sys, json
t = json.load(sys.stdin); r = t.get("result") or {}
tier = r.get("tierUsed"); runtime = r.get("runtime", "?")
cost = (r.get("usage") or {}).get("costUsd", 0)
first = (r.get("output") or "").strip().splitlines()[:1]
ok = tier == 4 and runtime.startswith("tool:") and cost == 0
print("   %s tier=%s runtime=%s $%.4f  %s"
      % ("OK " if ok else "!! ", tier, runtime, cost, first[0] if first else ""))
if not ok:
    print("   !! expected tier 4 on a free tool. This beat FAILED.")
    sys.exit(1)
'
}

if ! curl -sf "$Q/status" >/dev/null; then
  echo "No queen at $Q — start the hive with \`npm run solo\` first." >&2
  exit 1
fi

echo
bold "agent-hive · the breeding loop"
dim "queen at $Q · customer $CUSTOMER"
echo

# ── 0 ────────────────────────────────────────────────────────────────────────
bold "── 0. Who can serve a turn in your loop"
dim "   expect: at least one bee with supports_tools. A tool loop needs a model"
dim "           that can emit tool calls; agents that run their own tools cannot."
echo
TOOLBEES="$(curl -s "$Q/v1/models" | python3 -c '
import sys, json
d = json.load(sys.stdin).get("data", [])
ids = [m["id"] for m in d if (m.get("hive") or {}).get("supports_tools")]
print(" ".join(ids))
')"
if [ -z "$TOOLBEES" ]; then
  red "   No tool-capable bee is registered."
  dim "   Beats 1-2 need one. Three ways to get there:"
  dim "     · set GEMINI_API_KEY / OPENAI_API_KEY / ANTHROPIC_API_KEY and restart solo"
  dim "     · pull an Ollama model whose capabilities include tools, then restart solo"
  dim "     · run the second half alone: it needs no model at all"
  echo
  dim "   Skipping to beat 3. Everything from here is the new code, and none of"
  dim "   it needs a model."
  SKIP_LOOPS=1
  pause
else
  echo "   $TOOLBEES"
  SKIP_LOOPS=0
  pause
fi

# ── 1 ────────────────────────────────────────────────────────────────────────
if [ "$SKIP_LOOPS" = 0 ]; then
  bold "── 1. Six agent loops"
  dim "   expect: each part takes 2-3 turns. The hive returns tool CALLS; this"
  dim "           script runs them, because they are the caller's tools."
  echo
  for p in "${PARTS_A[@]}" "${PARTS_B[@]}"; do
    echo "   $p"
    python3 demo/agent-loop.py "$p" "$CUSTOMER" || true
  done
  pause

  # ── 2 ──────────────────────────────────────────────────────────────────────
  bold "── 2. What the hive wrote down"
  dim "   expect: one procedure, repeated. Nobody instrumented this — the tool"
  dim "           names are structure, so they are recorded at the default fidelity."
  echo
  npm run breed --silent -- flows --customer "$CUSTOMER" || true
  echo
  npm run breed --silent -- steps || true
  pause
fi

# ── 3 ──────────────────────────────────────────────────────────────────────
bold "── 3. Somebody reads that and builds a scraper"
dim "   expect: two ticks, and the prices move between them. The scraper is the"
dim "           only thing that fetches; the lookup reads what it left."
echo
npm run scrape:digikey --silent
if [ "$WAIT" -gt 0 ]; then
  echo
  dim "   Waiting ${WAIT}s before the second tick, on purpose:"
  dim "   the survey will not call two different answers 30s apart 'live data' —"
  dim "   inside a minute that is nondeterminism, and no program can stand in for"
  dim "   it. HIVE_BREED_LIVE_GAP_MS would skip the wait; it would also mean the"
  dim "   verdict is yours rather than the survey's."
  sleep "$WAIT"
fi
echo
npm run scrape:digikey --silent
pause

# ── 4 ──────────────────────────────────────────────────────────────────────
bold "── 4. The same work, now at tier 4"
dim "   expect: tier=4, runtime=tool:digikey-price, \$0.0000 — asserted, not"
dim "           printed. Anything else fails this beat."
echo
for p in "${PARTS_A[@]}"; do
  id="$(submit "{\"customerId\":\"$CUSTOMER\",\"title\":\"digikey price\",\"input\":\"price for $p\",\"skills\":[\"sourcing\"],\"toolInput\":{\"part\":\"$p\"}}")"
  settle_expect_tier4 "$id"
done
pause

# ── 5 ──────────────────────────────────────────────────────────────────────
bold "── 5. The collapse"
dim "   expect: the new shape at \$0.00, and the agent loops still costing what"
dim "           they cost. The tool changes what happens next, not what happened."
echo
npm run breed --silent -- shapes --customer "$CUSTOMER" || true
echo
npm run breed --silent -- flows --customer "$CUSTOMER" || true
pause

# ── 6 ──────────────────────────────────────────────────────────────────────
bold "── 6. The lookup does not scrape"
dim "   expect: with the store moved aside, the tool refuses and says why — and"
dim "           the hive then escalates, because a failed tier-4 task retries at a"
dim "           model. That is what makes every throw inside a tool a decision to"
dim "           spend money, and why 'part not stocked' is an ANSWER here, never an"
dim "           error. The tool's own words are in attempt 1; what the caller finally"
dim "           gets is the escalation's."
echo
STORE="${HIVE_TOOL_DATA_DIR:-data/tool-data}/digikey"
if [ -d "$STORE" ]; then
  mv "$STORE" "$STORE.aside"
  # The nonce matters. The result cache keys on the spec, so a beat that reused
  # an earlier request would be answered from it without the tool running at all
  # — and this beat would print a cheerful price in the one place whose whole
  # point is the refusal. That is exactly what happened the first time this was
  # written, so the nonce stays and the beat asserts.
  id="$(submit "{\"customerId\":\"$CUSTOMER\",\"title\":\"digikey price\",\"input\":\"price for MCP3008-I/P (probe $$)\",\"skills\":[\"sourcing\"],\"toolInput\":{\"part\":\"MCP3008-I/P\",\"probe\":$$}}")"
  sleep 3
  curl -s "$Q/tasks/$id" | python3 -c '
import sys, json
t = json.load(sys.stdin)
hist = t.get("history") or []
final = t.get("result") or {}
first = hist[0] if hist else final
err = first.get("error") or ""
print("   attempt 1 (tier %s, %s): ok=%s" % (first.get("tierUsed"), first.get("runtime"), first.get("ok")))
for ln in err.replace("Error: ", "").split(". "):
    if ln.strip():
        print("     " + ln.strip())
if not err:
    print("   !! expected the tool to refuse with its store moved aside. This beat FAILED.")
    sys.exit(1)
print("   the hive then escalated; what the caller finally sees is:")
print("     " + ((final.get("error") or final.get("output") or "")[:150] or "(nothing)"))
'
  mv "$STORE.aside" "$STORE"
fi
pause

# ── 7 ──────────────────────────────────────────────────────────────────────
bold "── 7. What did NOT close"
dim "   expect: the loop that produced the finding still cannot reach the tool it"
dim "           produced. A design question, not a bug — and a beat, not a footnote."
echo
echo "   through /tasks                 skills+toolInput carry the match"
# Again a fresh part, so this is a real dispatch and not beat 4 replayed out of
# the result cache.
id="$(submit "{\"customerId\":\"$CUSTOMER\",\"title\":\"digikey price\",\"input\":\"price for SN74HC595N\",\"skills\":[\"sourcing\"],\"toolInput\":{\"part\":\"SN74HC595N\"}}")"
settle_expect_tier4 "$id" || true
if [ "$SKIP_LOOPS" = 0 ]; then
  echo
  echo "   through /v1/chat/completions   a transcript, and no toolInput"
  python3 demo/agent-loop.py LM358N "$CUSTOMER" || true
fi
echo
dim "   The structured intake carries toolInput, so matchTool can fire. A chat"
dim "   completion carries a transcript, so routes/openai.ts builds a spec with"
dim "   skills: [] and no toolInput, and matchTool (analyzer.ts) returns nothing"
dim "   without one."
dim ""
dim "   The hive could read digikey_search({part}) off the model's own reply and"
dim "   run its tool instead. It will not, because it cannot know whether that"
dim "   name means the hive's tool or yours, and a caller's read_file reads the"
dim "   caller's disk. Four ways to close it are written down in DESIGN §10; none"
dim "   is chosen, and choosing one is a decision about who owns the loop."
echo

bold "That is the loop."
dim "   the corpus found the work · a program serves it for nothing ·"
dim "   the caller who taught us the procedure is still paying for it"
echo
dim "   npm run breed -- sql \"SELECT model, count(*) FROM attempt GROUP BY model\""
dim "   npm run scoreboard    what this cost, and what it would have cost"
echo
