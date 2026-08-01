# Getting started

Solo mode: one machine, every kind of bee, no Docker and no RabbitMQ.

```bash
npm install
ollama pull gemma4:12b    # the planner's brain; it is never auto-substituted
npm run solo
```

That's it. Check [Prerequisites](/guide/prerequisites) first if you want to know
which bees your machine will actually produce.

## What just started

The launcher probes the machine and starts one bee process per capability class
it finds, printing the roster and the reason for anything it skipped:

```
  ✓ 🍯 honey bee    tier 1 · subscription seats claude + codex
  · 💵 metered bee  tier 2 · per-token API      no OPENAI_API_KEY / ANTHROPIC_API_KEY / GEMINI_API_KEY set
  ✓ 🏠 local bee    tier 3 · local models       gemma4:12b
  ✓ 🏡 personal bee tier 3 · personal data      built-in mini agent on gemma4:12b
  ✓ 🐝 worker bee   tier 4 · tools, no LLM      csv-report, log-extract
```

Alongside those bees it brings up:

| Process | Where |
|---|---|
| the embedded pure-JS MQTT broker (Aedes) | in-process, port 1883 |
| the Queen | `http://localhost:4100` |
| the web console | `http://localhost:5180` |

```bash
npm run solo -- --frontier            # metered bee uses the frontier model profile
npm run solo -- --only=local,worker   # just those bees
npm run solo -- --no-console          # skip the web console
npm run solo -- --dry-run             # print the roster and exit
```

## The console

Open `http://localhost:5180` and talk to the Queen. It has three views:

- **Home** is what the hive *promises*: the agents each bee advertises, and a
  card per task showing which agent ran it.
- **Setup** is what your machines *could* run but don't yet — every installed
  Ollama model (and whether it supports the tool calls agents like Hermes
  require), which agent binaries are on `PATH`, and any capability that was
  configured but refused, with the reason.
- **Activity** is what they are *doing right now*.

::: warning The console is an operator tool for the hive's own machine
It has no authentication, and `/status` returns every task's prompt text. Do not
expose it (`vite --host`) or the Queen (`QUEEN_HOST`) to a network you do not
trust. See [Roles](/DESIGN#_1-goals-and-non-goals) and
[the HTTP API's security note](/reference/http-api#before-anything-else-this-api-is-unauthenticated).
:::

## Watch it route

The fastest way to understand what the hive is for:

```bash
bash demo/walkthrough.sh    # one task per routing branch, narrated
npm run watch               # live bee roster, seat quota, budget, wire traffic
npm run scoreboard          # what it cost, and what all-frontier would have cost
bash demo/chat-scenario.sh  # the planner decomposing one request into a DAG
bash demo/daily-jobs.sh     # personal data jobs routed to the 🏡 personal bee
```

`demo/walkthrough.sh` is the tour. It fires one task per routing branch: a tool
match that costs zero tokens, simple prose staying local, complex work landing on
a prepaid seat, urgent overflow to a paid API, confidential work locked on-prem,
a seat exhausting and the task deferring until the window resets, the same block
degrading instead of waiting under a different customer policy, a pinned task,
and a cache hit.

Run it with `--frontier` and it also shows the worker's budget guard refusing a
call that would cost 11.8× the task's cap — a beat that costs nothing, because
the call never happens.

`npm run scoreboard` is the punchline: what the run actually cost, next to what
the same run would have cost on all-frontier routing.

## Submitting work without the console

Structured intake goes to the Queen's [HTTP API](/reference/http-api):

```bash
curl -s localhost:4100/tasks \
  -H 'content-type: application/json' \
  -d '{"customerId":"aiotlab","title":"Tagline","input":"Write a one-line tagline for the lab edge-AI sensor demo."}'
```

Or chat from the CLI:

```bash
python3 demo/chat.py "Write a one-line tagline for the lab edge-AI sensor demo."
```

## What solo mode trades away

Solo is **lightweight mode**, and it buys zero setup with broker guarantees. The
embedded broker acknowledges a task the moment it arrives, so nothing redelivers
a dispatch that was lost or a task whose bee died.

The Queen covers both itself: it watches the progress ticks a bee sends for every
task it holds, and redispatches when they never start or stop coming — bounded by
the same 3-attempt limit as a failure. Workers ignore a repeated delivery of work
they already did.

RabbitMQ keeps its own at-least-once behavior instead. If you want several
workers competing on the *same* tier, that is the path:
[Running distributed](/guide/distributed).

## Next

- [Watching work happen](/guide/watching) — the three surfaces that show progress.
- [Stopping and resetting](/guide/stopping) — how to shut down cleanly.
- [The capability ladder](/guide/capability-ladder) — why tasks land where they do.
