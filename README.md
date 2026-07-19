# Agent Hive

An AIoT agent management system. Users **chat with the Queen**; the Queen turns the conversation into tasks, scores difficulty, sets budgets, and dispatches over RabbitMQ. **Workers** execute through a 4-tier capability ladder: Claude Code seats, open-source agents on paid models, open-source agents on local Ollama models, and hardcoded tools. Full design: [docs/DESIGN.md](docs/DESIGN.md).

The Queen's conversational layer is a **planner** that proposes structured tasks; the deterministic router core still owns every tier and budget decision. The planner proposes, the core disposes. The planner itself runs on a small local model by default and escalates only for complex requests, so the Queen's own reasoning follows the same cost ladder as the workers.

## Prerequisites

- Node 20+, Docker
- [Ollama](https://ollama.com) with at least one local model (`ollama pull gemma3:4b`). The planner also uses this model by default.
- Optional, for tier 1: Claude Code CLI logged in on a subscription seat
- Optional, for real OpenCode/OpenClaw runtimes: `ollama launch opencode`, `ollama launch openclaw` (without them, tier 3 falls back to direct Ollama calls, marked `ollama-direct`)

## Run the PoC

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

Chat with the Queen in the console, or from the CLI:

```bash
python3 demo/chat.py "Write a one-line safety slogan for a display panel fab."
```

The structured intake still works too (`bash demo/submit-tasks.sh`). Check routing: the console shows a live task card per step with its tier, runtime, model, cost, and `degraded` marker; the CLI prints the same events. `GET :4100/status` shows workers, budgets, seat windows, and the planner's own spend.

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
customers/auo.yaml    per-customer budgets, seats, tools, plannerModel (core is customer-agnostic)
packages/shared       schemas, capability model, cost catalog, amqp helpers
packages/queen        core (deterministic authority), planner (conversational),
                      analyzer, tier mapper, budget ledger, chat routes
packages/worker       worker host: discovery, registration, lease wallet
packages/adapters     official-agent / ollama-agent / tool
apps/web              React console: chat + live task cards + hive panel
demo/                 worker configs, chat.py CLI, sample task script
```
