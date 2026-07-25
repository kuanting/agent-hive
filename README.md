# Agent Hive

A multi-AI agent management system built for **token optimization**. Every design choice — routing, budgets, the capability ladder, even how the Queen thinks — exists to assign tasks to best efficient workers and drive down the overall cost.

Users chat with the Queen, and the Queen turns the conversation into tasks, scores difficulty, sets budgets, and dispatches over a message broker (RabbitMQ, or an embedded MQTT broker for single-machine use) to the cheapest capability that can do the job. **Bees** execute through a 4-tier capability ladder: prepaid frontier seats, per-token APIs, local Ollama models, and hardcoded tools. Full design: [docs/DESIGN.md](docs/DESIGN.md).

The Queen's conversational layer is a **planner** that proposes structured tasks; the deterministic router core still owns every tier and budget decision. The planner proposes, the core disposes. The planner itself runs on a small local model by default and escalates only for complex requests, so the Queen's own reasoning follows the same cost ladder as the workers — the brain never becomes a hidden cost center.

## The four bees

A bee's ability is the pair **agent type × LLM model**, not the agent type alone. OpenCode on a local 8B model and OpenCode on a cloud frontier model are *different* capabilities with different costs. The hive organizes them into a 4-tier ladder and always reaches for the cheapest rung that is still adequate:

| Tier | Bee | What it is | Marginal cost | Needs |
|---|---|---|---|---|
| 1 | 🍯 **honey bee** | Official agent on a prepaid frontier seat (Claude Code on Claude Max, Codex on ChatGPT Pro) | ~0 inside the quota window | `claude` / `codex` on PATH |
| 2 | 💵 **metered bee** | A paid model over its provider API (OpenAI, Anthropic, Google), or an Ollama cloud plan | per-token — the true last resort | an API key |
| 3 | 🏠 **local bee** | Open-source agent on a local Ollama model | ~0 (local compute) | Ollama running |
| 4 | 🐝 **worker bee** | Hardcoded tool, no LLM at all (parsers, converters, report generators) | free | nothing |

The commercial insight that drives the whole ladder: **subscription seats are prepaid, so their marginal token cost is ~0 inside the quota window.** That makes a tier-1 honey bee *cheaper per task* than a tier-2 metered bee, despite being more capable. So the cost ranking (cheapest first) is: worker bees → local bees → Ollama cloud seat → frontier seat → per-token API. Per-token dollars are spent only when the work is urgent, every prepaid seat is empty, and the customer's USD cap allows it.

Bees auto-register, and advertise only what they can actually run: a local bee asks the Ollama daemon which models are installed and rebuilds its capability records every 30 seconds, while configured capabilities whose CLI or API key is missing are dropped at startup. Nothing is advertised that would fail on dispatch — so the same configs work on a fully-equipped laptop and a bare one.

## Prerequisites

**Node 20+ is the only hard requirement.** Everything else adds a bee; nothing else is needed to get a running hive.

| Add this | Get this |
|---|---|
| nothing | 🐝 worker bee — tools, always available |
| [Ollama](https://ollama.com) + `ollama pull gemma3:4b` | 🏠 local bee, and the planner's default brain |
| `claude` and/or `codex` CLI, logged in | 🍯 honey bee |
| `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` / `GEMINI_API_KEY` | 💵 metered bee |

Optional: `ollama launch opencode` / `ollama launch openclaw` for the real OpenCode/OpenClaw runtimes. Without them the local bee falls back to direct Ollama calls, marked `ollama-direct` — expected, not an error. Docker is only for the distributed/RabbitMQ path; **solo mode needs neither Docker nor RabbitMQ**.

## Run it

### Solo — one machine, every kind of bee

```bash
npm install
ollama pull gemma3:4b     # optional, but it's what the planner thinks with
npm run solo
```

The launcher probes the machine and starts one bee process per capability class it finds, printing the roster and why anything was skipped:

```
  ✓ 🍯 honey bee    tier 1 · subscription seats claude + codex
  · 💵 metered bee  tier 2 · per-token API      no OPENAI_API_KEY / ANTHROPIC_API_KEY / GEMINI_API_KEY set
  ✓ 🏠 local bee    tier 3 · local models       gemma3:4b
  ✓ 🐝 worker bee   tier 4 · tools, no LLM      csv-report, log-extract
```

Alongside them it brings up the embedded pure-JS MQTT broker (Aedes), the Queen on :4100, and the console on http://localhost:5180. No Docker, no RabbitMQ.

Each bee owns exactly **one tier**, which is what lets four of them share the embedded broker. Aedes has no shared subscriptions, so it can't split one task between two workers bound to the same tier+skill — but bees with disjoint tiers never contend, and every task has exactly one taker. (Use the amqp backend below when you want several workers on the *same* tier.)

```bash
npm run solo -- --frontier            # metered bee uses the frontier model profile
npm run solo -- --only=local,worker   # just those bees
npm run solo -- --dry-run             # print the roster and exit
```

### See it route

```bash
bash demo/walkthrough.sh    # one task per routing branch, narrated
npm run watch               # live bee roster, seat quota, budget, wire traffic
npm run scoreboard          # what it cost, and what all-frontier would have cost
bash demo/chat-scenario.sh  # the planner decomposing one request into a DAG
```

`demo/walkthrough.sh` is the tour: a tool match that costs zero tokens, simple prose staying local, complex work landing on a prepaid seat, urgent overflow to a paid API, confidential work locked on-prem, a seat exhausting and the task deferring until the window resets, the same block degrading instead of waiting under a different customer policy, a pinned task, and a cache hit. With `--frontier` it also shows the worker's budget guard refusing a call that would cost 11.8× the task's cap — a beat that costs nothing, because the call never happens.

### Distributed — RabbitMQ

The large-scale path: a RabbitMQ broker with bees you can spread across hosts. Competing consumers mean several bees *can* share a tier here, which is the one thing the embedded broker can't do.

```bash
npm install
docker compose up -d          # RabbitMQ (management UI: http://localhost:15672, guest/guest)

# terminal 1: the Queen (intake API + chat on :4100)
npm run queen

# terminals 2..n: one bee each, or several on the same tier
npm run worker -- demo/workers/local-bee.yaml
npm run worker -- demo/workers/honey-bee.yaml

# last terminal: the web console (http://localhost:5180)
npm run console
```

The broker is selected by `HIVE_BROKER` (`amqp` default, `mqtt` for the embedded broker); `npm run solo` sets `mqtt` for you.

Chat with the Queen in the console, or from the CLI:

```bash
python3 demo/chat.py "Write a one-line tagline for the lab edge-AI sensor demo."
```

Structured intake goes to `POST :4100/tasks`. Check routing: the console shows a live task card per step with its tier, runtime, model, cost, and `degraded` marker; the CLI prints the same events. `GET :4100/status` shows bees, budgets, seat windows, and the planner's own spend.

### Reset demo state

The budget ledger (spend + seat-window state) persists to `data/ledger.json` and reloads on startup. To start fresh, stop the hive and run:

```bash
npm run reset            # clear the budget ledger
npm run reset -- --all   # also clear the on-disk artifact store
```

The ledger rebuilds from `customers/*.yaml` on the next queen start.

## Configuration

See [.env.example](.env.example) for every variable with its default. The ones that matter most:

- `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` / `GEMINI_API_KEY` — the only credentials the hive reads, and the only thing the metered bee needs. The honey bee needs none: Claude Code and Codex authenticate through their own CLI sessions, which is exactly what makes them prepaid rather than per-token.
- `HIVE_API_DRYRUN=1` — skip the network on per-token calls but still report realistic token counts, so the ledger, budget guard and USD cap behave exactly as live. For re-running or recording a demo without spending.
- `HIVE_PLANNER_MODEL` (default `gemma3:4b`) — the local model the planner uses for intake. `plannerModel` in a customer profile is the stronger model it escalates to for complex requests.
- `QUEEN_PORT` (default 4100), `OLLAMA_URL` (default `http://localhost:11434`).

Per-customer policy lives in `customers/*.yaml`: a USD cap, the prepaid seats, the tier-4 tools, and `policy.onBudgetBlock` — whether a blocked task should `wait` for a seat window to reset (full quality, higher latency) or `degrade` to a local model now. `customers/aiotlab.yaml` holds realistic numbers; `customers/demo-lab.yaml` is the same schema shrunk until every budget path fires inside a demo.

## Tests

```bash
npm test        # cost estimator, difficulty scorer, tool matcher, routing policy
npm run check   # typecheck
```

## Layout

```
customers/            per-customer budgets, seats, tools, routing policy (core is customer-agnostic)
packages/shared       schemas, capability model, cost catalog, broker backends (amqp + mqtt)
packages/queen        core (deterministic authority), planner (conversational),
                      analyzer, tier mapper, budget ledger, chat routes
packages/worker       bee host: discovery, capability preflight, registration, lease wallet
packages/adapters     official-agent (🍯) / api-model (💵) / ollama-agent (🏠) / tool (🐝)
apps/web              React console: chat + live task cards + hive panel
demo/workers/         one config per bee, each owning exactly one tier
demo/                 walkthrough, scoreboard, watch, chat scenario
scripts/solo.mjs      the detecting launcher
```
