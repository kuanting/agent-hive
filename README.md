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
| 3 | 🏡 **personal bee** | The user's agent over local personal data — email, files, calendar, notes | ~0, and never leaves the machine | Ollama, OpenClaw, or Hermes |
| 4 | 🐝 **worker bee** | Hardcoded tool, no LLM at all (parsers, converters, report generators) | free | nothing |

The commercial insight that drives the whole ladder: **subscription seats are prepaid, so their marginal token cost is ~0 inside the quota window.** That makes a tier-1 honey bee *cheaper per task* than a tier-2 metered bee, despite being more capable. So the cost ranking (cheapest first) is: worker bees → local bees → Ollama cloud seat → frontier seat → per-token API. Per-token dollars are spent only when the work is urgent, every prepaid seat is empty, and the customer's USD cap allows it.

**The hive manages agents you harnessed, not models it found.** A bee advertises the agents named in its config and nothing else — an agent is a thing you installed and configured, so the hive never invents capabilities on your behalf. Each capability names its agent:

```yaml
capabilities:
  - agent: hermes         # what to call it, everywhere in the hive
    runtime: personal     # which adapter drives it
    model: gemma4:12b     # what that agent runs
    tier: 3
    billing: local
    skills: [email, files, calendar]
```

Bees auto-register and advertise only what they can actually run: a configured capability whose CLI, API key, or model is missing is dropped at startup with the reason, and one that will run but degrade (agent binary absent, model can't do tool calls) is kept and flagged. Nothing is advertised that would fail on dispatch — so the same configs work on a fully-equipped laptop and a bare one. What the machine merely *could* run — every installed Ollama model, which agent binaries are on PATH — is reported separately for the console's Setup view, so `ollama pull` changes what you're offered, never what the hive promises.

## Prerequisites

**Node 20+ is the only hard requirement.** Everything else adds a bee; nothing else is needed to get a running hive.

| Add this | Get this |
|---|---|
| nothing | 🐝 worker bee — tools, always available |
| [Ollama](https://ollama.com) + `ollama pull gemma4:12b` | 🏠 local bee, and the planner's default brain |
| the same Ollama (or an OpenClaw gateway / Hermes CLI) | 🏡 personal bee — reads local personal data in `demo/personal-data/` |
| `claude` and/or `codex` CLI, logged in | 🍯 honey bee |
| `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` / `GEMINI_API_KEY` | 💵 metered bee |

Optional: `ollama launch opencode` / `ollama launch openclaw` for the real OpenCode/OpenClaw runtimes. Without them the local bee falls back to direct Ollama calls, marked `ollama-direct` — expected, not an error. Docker is only for the distributed/RabbitMQ path; **solo mode needs neither Docker nor RabbitMQ**.

## Run it

### Solo — one machine, every kind of bee

```bash
npm install
ollama pull gemma4:12b    # the planner's brain; it is never auto-substituted
npm run solo
```

The launcher probes the machine and starts one bee process per capability class it finds, printing the roster and why anything was skipped:

```
  ✓ 🍯 honey bee    tier 1 · subscription seats claude + codex
  · 💵 metered bee  tier 2 · per-token API      no OPENAI_API_KEY / ANTHROPIC_API_KEY / GEMINI_API_KEY set
  ✓ 🏠 local bee    tier 3 · local models       gemma4:12b
  ✓ 🏡 personal bee tier 3 · personal data      built-in mini agent on gemma4:12b
  ✓ 🐝 worker bee   tier 4 · tools, no LLM      csv-report, log-extract
```

Alongside them it brings up the embedded pure-JS MQTT broker (Aedes), the Queen on :4100, and the console on http://localhost:5180. No Docker, no RabbitMQ.

The console has three views. **Home** is what the hive promises: the agents each bee advertises, and a card per task showing which agent ran it. **Setup** is what your machines could run but don't yet — every installed Ollama model (and whether it supports the tool calls agents like Hermes require), which agent binaries are on PATH, and any capability that was configured but refused, with the reason. **Activity** is what they are doing right now.

### Watching work happen

Jobs take time. A `claude -p` run can sit for minutes, and a hive is several processes — so the console used to show a `submitted` chip and nothing else, with each bee narrating itself to a terminal nobody was tailing. Three surfaces fix that, split by how much noise each can afford:

- **The Queen's turn, on Home.** One line that changes in place as she works: *checking what I remember → planning (gemma4:12b) → handing work to the hive → waiting on the bees → writing the answer*, with elapsed time. Phases, not streamed tokens — the planner answers in JSON, so streaming it would type out syntax rather than thought, and real reasoning text would restrict which models can be the Queen's brain.
- **Task cards that count.** Each card shows a live elapsed timer and one line saying where the step actually is — *on the queue, waiting for a bee to take it* / *running on 🏠 T3 local bee · gemma4:12b* / *failed — the Queen may escalate and retry*. Expand a card for that task's own log lines. The bee behind it publishes a liveness tick every few seconds, which is what separates a slow task from a dead one.
- **Activity, the third view.** The browser twin of `npm run watch`: in-flight tasks with the Queen's own reason for each (this is where *"quota window empty, waiting 300s for reset"* stops looking like a hang), and the whole hive's narration as a filterable feed — by level, by bee, pausable. Debug output is opt-in by navigation, so twenty bees can never bury the Queen's answer on Home.

`HIVE_LOG_LEVEL` sets the threshold for a bee's terminal and the feed alike; `HIVE_PROGRESS_MS` sets the tick interval (`0` turns it off). **Log lines carry identifiers and decisions, never prompt or output text** — confidentiality is a promise about where work runs, and narration must not become the side door out of it. A test enforces it across every call site.

Each bee owns exactly **one tier**, which is what lets four of them share the embedded broker. Aedes has no shared subscriptions, so it can't split one task between two workers bound to the same tier+skill — but bees with disjoint tiers never contend, and every task has exactly one taker. (Use the amqp backend below when you want several workers on the *same* tier.)

Solo is **lightweight mode**, and it trades broker guarantees for zero setup: the embedded broker acknowledges a task the moment it arrives, so nothing redelivers a dispatch that was lost or a task whose bee died. The Queen covers both itself — it watches the progress ticks a bee sends for every task it holds, and redispatches when they never start or stop coming, bounded by the same 3-attempt limit as a failure. Workers ignore a repeated delivery of work they already did. RabbitMQ keeps its own at-least-once behavior instead; see [docs/DESIGN.md §4](docs/DESIGN.md).

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
bash demo/daily-jobs.sh     # personal data jobs routed to the 🏡 personal bee
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

The broker is selected by `HIVE_BROKER`: **`amqp` (RabbitMQ) is the default and the production path**, `mqtt` is lightweight mode. `npm run solo` sets `mqtt` for you; nothing else does. Lightweight mode has to be asked for by name — the two backends differ in what they promise about delivery, so which one is running should never be inferred from a stray environment variable.

Chat with the Queen in the console, or from the CLI:

```bash
python3 demo/chat.py "Write a one-line tagline for the lab edge-AI sensor demo."
```

Structured intake goes to `POST :4100/tasks`. Check routing: the console shows a live task card per step with its tier, runtime, model, cost, and `degraded` marker; the CLI prints the same events. `GET :4100/status` shows bees, budgets, seat windows, and the planner's own spend.

### Reset demo state

The budget ledger (spend + seat-window state) persists to `data/ledger.json` and reloads on startup. To start fresh, stop the hive and run:

```bash
npm run reset             # clear the budget ledger
npm run reset -- --memory # also clear what the Queen has learned
npm run reset -- --all    # also clear the artifact store and learned memory
```

The ledger rebuilds from `customers/*.yaml` on the next queen start. Plan guides are hand-authored configuration and are never removed.

## Configuration

See [.env.example](.env.example) for every variable with its default. The ones that matter most:

- `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` / `GEMINI_API_KEY` — the only credentials the hive reads, and the only thing the metered bee needs. The honey bee needs none: Claude Code and Codex authenticate through their own CLI sessions, which is exactly what makes them prepaid rather than per-token.
- `HIVE_API_DRYRUN=1` — skip the network on per-token calls but still report realistic token counts, so the ledger, budget guard and USD cap behave exactly as live. For re-running or recording a demo without spending.
- `HIVE_PLANNER_MODEL` (default `gemma4:12b`) — the local model the planner uses for intake. Verified at startup and never swapped for another: an absent planner model is reported, not worked around, since the Queen's plan decides every task's routing and confidentiality. `plannerModel` in a customer profile is the stronger model it escalates to for complex requests.
- `QUEEN_PORT` (default 4100), `OLLAMA_URL` (default `http://localhost:11434`).

Per-customer policy lives in `customers/*.yaml`: a USD cap, the prepaid seats, the tier-4 tools, and `policy.onBudgetBlock` — whether a blocked task should `wait` for a seat window to reset (full quality, higher latency) or `degrade` to a local model now. `customers/aiotlab.yaml` holds realistic numbers; `customers/demo-lab.yaml` is the same schema shrunk until every budget path fires inside a demo.

## A Queen that learns

**YAML is authority, markdown is advice.** The profiles above own budget, seats, tools and routing. Two markdown inputs shape only *how the Queen splits a request into tasks* — never where those tasks run.

- **Plan guide** — hand-authored, checked in: `customers/plan-guide.md` (house) and `customers/<id>.plan-guide.md` (per-customer overlay).
- **Learned memory** — one lesson per file under `data/memory/<customerId>/`, written by the Queen itself.

At the end of every plan, five deterministic detectors look for something worth remembering: a tool the plan should have matched, a skill tag no worker advertises, a stalled DAG, a plan that needed retries, a clean multi-step plan worth reusing. **If nothing fired, no model is called and the turn costs nothing extra** — and four of the five detectors are templated from your YAML, so they stay free even when they do fire. Recall is a deterministic trigger-word gate, so most turns inject nothing at all.

The payoff is in the repo's own currency. Ask for a report over a CSV without a tool hint and it runs on an LLM; the Queen notices the `csv-report` tool needed only one absent key and writes that down. Ask again in a fresh session and the plan carries `toolInput.csv` — the step matches tier 4 and costs **zero tokens**.

**A lesson has to keep earning its place.** Detector ids are stable, so the Queen can check its own advice: if a note was recalled and the same detector fires anyway, the planner was told and ignored it. That memory's trust falls, it sinks in the ranking, and after three strikes it is retired — kept on disk for the record, but no longer paid for in prompt budget. Notes that work show the opposite signature: the mistake stops recurring, so `observed` freezes while `helped` climbs. `data/memory/<customer>/INDEX.md` shows both.

One caveat worth knowing before you point this at anything sensitive: confidentiality is enforced on the **execution** path, not on the planner's own escalation. A long or complex message can reach a cloud `plannerModel` before any task has been marked confidential. See [docs/DESIGN.md §10](docs/DESIGN.md) — it is open, and the fix options are written up there.

What memory cannot do is route. It reaches the planner prompt only, and `TaskSpec` has no tier or budget field, so a bad memory produces a bad plan, never a bad bill. The two planner fields that *do* carry routing meaning — `urgency`, which unlocks per-token spend, and `sensitivity`, which decides whether work may leave the machine — are both grounded in the user's own words, so a note telling the planner to mark everything urgent or routine gets overruled. A turn touching anything `confidential` writes nothing at all. `HIVE_MEMORY=0` and `HIVE_PLAN_GUIDE=0` turn it off for a reproducible demo; `npm run reset -- --memory` wipes what was learned. See [docs/DESIGN.md §5c](docs/DESIGN.md).

## Tests

```bash
npm test        # cost estimator, difficulty scorer, tool matcher, routing policy
npm run check   # typecheck
```

## Layout

```
customers/            per-customer budgets, seats, tools, routing policy (core is customer-agnostic)
                      plus *.plan-guide.md: hand-authored advice on how to decompose
data/memory/          what the Queen has learned, one lesson per file (runtime state, gitignored)
packages/shared       schemas, capability model, cost catalog, broker backends (amqp + mqtt)
packages/queen        core (deterministic authority), planner (conversational),
                      analyzer, tier mapper, budget ledger, chat routes
packages/worker       bee host: discovery, capability preflight, registration, lease wallet
packages/adapters     official-agent (🍯) / api-model (💵) / ollama-agent (🏠) / tool (🐝)
apps/web              React console: Home (chat + live task cards), Setup, Activity (live feed)
demo/workers/         one config per bee, each owning exactly one tier
demo/                 walkthrough, scoreboard, watch, chat scenario
scripts/solo.mjs      the detecting launcher
```
