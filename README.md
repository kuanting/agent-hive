# Agent Hive

A multi-AI agent management system built for **token optimization**. Every design choice — routing, budgets, the capability ladder, even how the Queen thinks — exists to assign tasks to best efficient workers and drive down the overall cost.

Users chat with the Queen, and the Queen turns the conversation into tasks, scores difficulty, sets budgets, and dispatches over a message broker (RabbitMQ, or an embedded MQTT broker for single-machine use) to the cheapest capability that can do the job. **Worker bees** execute through a 4-tier capability ladder: Claude Code seats, open-source agents on paid models, open-source agents on local Ollama models, and hardcoded tools. Full design: [docs/DESIGN.md](docs/DESIGN.md).

The Queen's conversational layer is a **planner** that proposes structured tasks; the deterministic router core still owns every tier and budget decision. The planner proposes, the core disposes. The planner itself runs on a small local model by default and escalates only for complex requests, so the Queen's own reasoning follows the same cost ladder as the workers — the brain never becomes a hidden cost center.

## Worker bees: the capability agent types

A worker bee's ability is the pair **agent type × LLM model**, not the agent type alone. OpenCode on a local 8B model and OpenCode on a cloud frontier model are *different* capabilities with different costs. The hive organizes them into a 4-tier ladder and always reaches for the cheapest rung that is still adequate:

| Tier | Worker bee | What it is | Marginal cost |
|---|---|---|---|
| 1 | **Honey bees** | Official agent on a prepaid frontier seat (Claude Code on Claude Max, Codex on ChatGPT Pro) | ~0 inside the quota window |
| 2 | **Metered bees** | Open-source agent (OpenCode / OpenClaw / Hermes) on a per-token API or Ollama cloud plan | per-token — the true last resort |
| 3 | **Local bees** | Open-source agent on a local Ollama model | ~0 (local compute) |
| 4 | **Tool bees** | Hardcoded tool, no LLM at all (parsers, converters, report generators) | free |

The commercial insight that drives the whole ladder: **subscription seats are prepaid, so their marginal token cost is ~0 inside the quota window.** That makes a tier-1 honey bee *cheaper per task* than a tier-2 metered bee, despite being more capable. So the cost ranking (cheapest first) is: tool bees → local bees → Ollama cloud seat → frontier seat → per-token API. Per-token dollars are spent only when the work is urgent, every prepaid seat is empty, and the customer's USD cap allows it.

Worker bees auto-register: a local bee's discovery loop asks the Ollama daemon which models are installed and rebuilds its capability records automatically. Pull a model and the bee re-registers within 30 seconds.

## Prerequisites

- Node 20+ (Docker is only for the distributed/RabbitMQ path — **solo mode needs neither Docker nor RabbitMQ**)
- [Ollama](https://ollama.com) with at least one local model (`ollama pull gemma3:4b`). The planner also uses this model by default.
- Optional, for tier 1: Claude Code CLI logged in on a subscription seat
- Optional, for real OpenCode/OpenClaw runtimes: `ollama launch opencode`, `ollama launch openclaw` (without them, tier 3 falls back to direct Ollama calls, marked `ollama-direct`)

## Run it

### Solo — one machine, one command

For an individual pointing the hive at the agents already on their laptop (Claude Code, Codex, local Ollama). No Docker, no RabbitMQ:

```bash
npm install
ollama pull gemma3:4b     # local tier-3 model + the planner's default brain
npm run solo              # embedded MQTT broker + Queen + one worker + console
```

`npm run solo` starts everything in a single command over an embedded pure-JS MQTT broker (Aedes) — the Queen on :4100, the console on http://localhost:5180, and one worker (`demo/workers/solo.yaml`) carrying a Claude Code seat, a Codex seat, local Ollama models, and the tier-4 tools. Drop any capability you don't have from `demo/workers/solo.yaml`; a bare Ollama box still serves tier 3.

The embedded broker has no shared subscriptions, so solo runs a **single** worker — there is nothing to load-balance on one machine. For horizontal worker scale, use the distributed path below.

### Distributed — RabbitMQ

The large-scale path: a RabbitMQ broker with workers you can spread across hosts.

```bash
npm install
docker compose up -d          # RabbitMQ (management UI: http://localhost:15672, guest/guest)

# terminal 1: the Queen (intake API + chat on :4100)
npm run queen

# terminal 2: local-tier worker (tier 3/4, auto-discovers Ollama models)
npm run worker -- demo/workers/hq-local.yaml

# terminal 3 (optional): premium worker (tier 1 Claude Code seat)
npm run worker -- demo/workers/hq-premium.yaml

# terminal 4: the web console (http://localhost:5180)
npm run console
```

The broker is selected by `HIVE_BROKER` (`amqp` default, `mqtt` for the embedded broker); `npm run solo` sets `mqtt` for you.

Chat with the Queen in the console, or from the CLI:

```bash
python3 demo/chat.py "Write a one-line tagline for the lab edge-AI sensor demo."
```

The structured intake still works too (`bash demo/submit-tasks.sh`). Check routing: the console shows a live task card per step with its tier, runtime, model, cost, and `degraded` marker; the CLI prints the same events. `GET :4100/status` shows workers, budgets, seat windows, and the planner's own spend.

### Reset demo state

The budget ledger (spend + seat-window state) persists to `data/ledger.json` and reloads on startup. To start fresh, stop the hive and run:

```bash
npm run reset            # clear the budget ledger
npm run reset -- --all   # also clear the on-disk artifact store
```

The ledger rebuilds from `customers/*.yaml` on the next queen start.

## Configuration

- `HIVE_PLANNER_MODEL` (default `gemma3:4b`): the local model the planner uses for intake.
- `plannerModel` in a customer profile: a stronger model the planner escalates to for complex requests.
- `QUEEN_PORT` (default 4100), `OLLAMA_URL` (default `http://localhost:11434`).

## Tests

```bash
npm test        # cost estimator, difficulty scorer, tool matcher, routing policy
npm run check   # typecheck
```

## Layout

```
customers/aiotlab.yaml  per-customer budgets, seats, tools, plannerModel (core is customer-agnostic)
packages/shared       schemas, capability model, cost catalog, broker backends (amqp + mqtt)
packages/queen        core (deterministic authority), planner (conversational),
                      analyzer, tier mapper, budget ledger, chat routes
packages/worker       worker host: discovery, registration, lease wallet
packages/adapters     official-agent / ollama-agent / tool
apps/web              React console: chat + live task cards + hive panel
demo/                 worker configs, chat.py CLI, sample task script
```
